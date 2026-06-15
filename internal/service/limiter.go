package service

import (
	"sync"
	"time"
)

// tokenBucketLimiter 是本进程内的令牌桶限流器。
// QPS 是 Queries Per Second 的缩写，在本项目里表示“每秒允许进入抽奖链路的请求数”。
// 限流放在 Go 进程内是为了保护 Redis Lua、RocketMQ 和本机演示环境；
// 它不是全局限流，多实例部署时仍需要网关或 Redis 级限流兜底。
type tokenBucketLimiter struct {
	// rate 是令牌每秒补充速度，对应 LOTTERY_RATE_LIMIT_QPS。
	rate float64
	// burst 是令牌桶容量，用一秒 QPS 作为短时突发上限，避免瞬时点击被过度拒绝。
	burst float64
	// tokens 是当前可用令牌数；请求拿到令牌才允许继续进入 Redis 预扣库存。
	tokens float64
	// lastRefill 记录上次补充令牌的时间，用真实经过时间计算应补多少令牌。
	lastRefill time.Time
	// mu 保护 tokens 和 lastRefill，避免多个 goroutine 同时扣令牌导致限流失真。
	mu sync.Mutex
}

// newTokenBucketLimiter 根据 QPS 创建本地令牌桶限流器。
// qps 小于等于 0 表示关闭限流，适合本地排查功能问题；
// 压测或演示高并发时建议显式设置，避免把依赖故障误判成业务逻辑错误。
func newTokenBucketLimiter(qps int) *tokenBucketLimiter {
	if qps <= 0 {
		return &tokenBucketLimiter{}
	}
	// 桶容量设置为一秒的 QPS，允许短时间抖动通过。
	// 但持续流量仍会被限制在 LOTTERY_RATE_LIMIT_QPS 附近，避免压测时把 Redis/MQ 打满。
	burst := float64(qps)
	return &tokenBucketLimiter{
		rate:       float64(qps),
		burst:      burst,
		tokens:     burst,
		lastRefill: time.Now(),
	}
}

// Allow 判断当前请求是否允许进入抽奖主链路。
// 这里必须在锁内完成补令牌和扣令牌，否则并发请求可能同时看到同一份令牌，
// 造成实际放行 QPS 高于配置值，压测指标会失真。
func (l *tokenBucketLimiter) Allow() bool {
	if l == nil || l.rate <= 0 {
		return true
	}

	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	l.refill(now)
	if l.tokens < 1 {
		return false
	}
	l.tokens--
	return true
}

// refill 根据距离上次补充的真实时间恢复令牌。
// 使用时间差而不是定时 goroutine，是为了减少后台协程和退出清理成本；
// 边界情况是长时间无请求后令牌不能无限累积，最多只恢复到 burst。
func (l *tokenBucketLimiter) refill(now time.Time) {
	if l.lastRefill.IsZero() {
		l.lastRefill = now
		l.tokens = l.burst
		return
	}
	elapsed := now.Sub(l.lastRefill).Seconds()
	if elapsed <= 0 {
		return
	}
	l.tokens += elapsed * l.rate
	if l.tokens > l.burst {
		l.tokens = l.burst
	}
	l.lastRefill = now
}
