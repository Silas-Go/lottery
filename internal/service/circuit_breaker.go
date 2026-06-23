package service

import (
	"silas/internal/metrics"
	"silas/internal/util"
	"sync"
	"time"
)

// circuitState 是熔断器内部状态。
// 对外通过 metrics 的 green/yellow/red 文本展示，内部用三态机精确控制放行与恢复。
type circuitState int

const (
	// stateClosed 正常放行（信号灯 green/yellow）。
	stateClosed circuitState = iota
	// stateOpen 熔断中，fail-fast 拒绝新请求（信号灯 red）。
	stateOpen
	// stateHalfOpen 冷却后试探恢复，放少量请求探测压力（信号灯 yellow）。
	stateHalfOpen
)

// CircuitBreaker 是 Cache-Aside 链路的压力感知熔断器。
//
// 与基于错误率的经典熔断器不同，这里用"系统压力指标"驱动：当数据库环节耗时
// （含连接池排队等待）或连接池占用率持续越过红线，就判定过载并切到 Open，
// fail-fast 拒绝新请求以保护 MySQL；冷却期后切到 Half-Open 放少量试探请求，
// 压力恢复则回到 Closed，否则重新 Open。预扣模式不接入熔断器，因为它本就不打 DB。
type CircuitBreaker struct {
	mu       sync.Mutex
	state    circuitState
	openedAt time.Time

	// consecutiveOverload 是连续过载次数，达到阈值才跳闸，避免偶发抖动误熔断。
	consecutiveOverload int
	// halfOpenProbes 是 Half-Open 状态下已放行的试探请求数。
	halfOpenProbes int

	yellowLatencyMs int64         // DB RT 预警黄线，单位毫秒
	redLatencyMs    int64         // DB RT 熔断红线，单位毫秒
	redPoolUsage    int           // 连接池占用率红线，百分比
	tripThreshold   int           // 连续过载达到该次数触发熔断
	cooldown        time.Duration // Open 到 Half-Open 的冷却时间
	halfOpenMax     int           // Half-Open 最多放行的试探请求数
}

// newCircuitBreaker 用环境变量（带演示友好的默认值）创建熔断器。
// 默认阈值是针对本机演示 + DB 闸门容量 10 调过的，能在压测时较快压出红灯。
func newCircuitBreaker() *CircuitBreaker {
	return &CircuitBreaker{
		state:           stateClosed,
		yellowLatencyMs: int64(util.EnvInt("LOTTERY_CB_YELLOW_LATENCY_MS", 30)),
		redLatencyMs:    int64(util.EnvInt("LOTTERY_CB_RED_LATENCY_MS", 100)),
		redPoolUsage:    util.EnvInt("LOTTERY_CB_RED_POOL_USAGE", 80),
		tripThreshold:   util.EnvInt("LOTTERY_CB_TRIP_THRESHOLD", 5),
		cooldown:        time.Duration(util.EnvInt("LOTTERY_CB_COOLDOWN_MS", 3000)) * time.Millisecond,
		halfOpenMax:     util.EnvInt("LOTTERY_CB_HALFOPEN_MAX", 3),
	}
}

// Allow 判断当前请求是否放行。
// 返回 false 表示熔断器 Open（或 Half-Open 试探额已满），调用方应 fail-fast 拒绝。
func (cb *CircuitBreaker) Allow() bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	switch cb.state {
	case stateOpen:
		if time.Since(cb.openedAt) < cb.cooldown {
			return false
		}
		// 冷却结束，进入 Half-Open 试探阶段。
		cb.state = stateHalfOpen
		cb.halfOpenProbes = 0
		metrics.SetCircuitState(metrics.CircuitYellow)
		fallthrough
	case stateHalfOpen:
		if cb.halfOpenProbes >= cb.halfOpenMax {
			return false
		}
		cb.halfOpenProbes++
		return true
	default: // stateClosed
		return true
	}
}

// Report 在每个被放行的请求完成后上报压力指标，驱动状态切换与信号灯刷新。
// latencyMs 是数据库环节耗时（含连接池排队等待），poolUsage 是连接池占用率百分比。
func (cb *CircuitBreaker) Report(latencyMs int64, poolUsage int) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	overloaded := latencyMs >= cb.redLatencyMs || poolUsage >= cb.redPoolUsage

	switch cb.state {
	case stateHalfOpen:
		if overloaded {
			cb.trip() // 试探仍过载，回到 Open 继续冷却
			return
		}
		// 试探成功且压力正常，恢复 Closed。
		cb.state = stateClosed
		cb.consecutiveOverload = 0
		metrics.SetCircuitState(metrics.CircuitGreen)
	case stateClosed:
		if overloaded {
			cb.consecutiveOverload++
			if cb.consecutiveOverload >= cb.tripThreshold {
				cb.trip()
				return
			}
		} else {
			cb.consecutiveOverload = 0
		}
		// Closed 状态下根据是否接近红线刷新绿/黄信号灯，提供"预警"过渡态。
		if latencyMs >= cb.yellowLatencyMs || poolUsage >= cb.redPoolUsage/2 {
			metrics.SetCircuitState(metrics.CircuitYellow)
		} else {
			metrics.SetCircuitState(metrics.CircuitGreen)
		}
	}
}

func (cb *CircuitBreaker) trip() {
	cb.state = stateOpen
	cb.openedAt = time.Now()
	cb.consecutiveOverload = 0
	metrics.SetCircuitState(metrics.CircuitRed)
}

// State 返回当前熔断器状态的展示文本（green/yellow/red），主要用于测试和排查。
func (cb *CircuitBreaker) State() string {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	switch cb.state {
	case stateOpen:
		return metrics.CircuitRed
	case stateHalfOpen:
		return metrics.CircuitYellow
	default:
		return metrics.CircuitGreen
	}
}
