package service

import (
	"silas/internal/metrics"
	"testing"
	"time"
)

// TestCircuitBreakerTripAndRecover 验证熔断器在过载下跳闸、冷却后试探恢复的完整闭环。
// 纯内存逻辑，不依赖 MySQL/Redis，可在任意环境运行。
func TestCircuitBreakerTripAndRecover(t *testing.T) {
	cb := newCircuitBreaker()
	// 用确定阈值覆盖默认值，避免测试受环境变量影响。
	cb.yellowLatencyMs = 30
	cb.redLatencyMs = 100
	cb.redPoolUsage = 80
	cb.tripThreshold = 3
	cb.cooldown = 50 * time.Millisecond
	cb.halfOpenMax = 2
	cb.halfOpenSuccess = 2

	if !cb.Allow() {
		t.Fatal("closed breaker should allow requests")
	}
	if got := cb.State(); got != metrics.CircuitGreen {
		t.Fatalf("expected green initially, got %s", got)
	}

	// 连续过载达到阈值后应跳闸 Open（红灯）。
	for i := 0; i < cb.tripThreshold; i++ {
		cb.Report(200, 100)
	}
	if got := cb.State(); got != metrics.CircuitRed {
		t.Fatalf("expected red after sustained overload, got %s", got)
	}
	if cb.Allow() {
		t.Fatal("open breaker should reject requests")
	}

	// 冷却后进入 Half-Open，放行有限试探请求。
	time.Sleep(cb.cooldown + 10*time.Millisecond)
	if !cb.Allow() {
		t.Fatal("after cooldown half-open should allow a probe")
	}

	// 单次试探正常仍保持 Half-Open（黄灯），避免刚恢复就被流量再次打爆。
	cb.Report(5, 0)
	if got := cb.State(); got != metrics.CircuitYellow {
		t.Fatalf("expected yellow until enough healthy probes, got %s", got)
	}
	if !cb.Allow() {
		t.Fatal("half-open should allow the second healthy probe")
	}
	// 多次试探请求压力正常，应恢复 Closed（绿灯）。
	cb.Report(5, 0)
	if got := cb.State(); got != metrics.CircuitGreen {
		t.Fatalf("expected green after successful probe, got %s", got)
	}
	if !cb.Allow() {
		t.Fatal("recovered breaker should allow requests")
	}
}

// TestCircuitBreakerHalfOpenReTrip 验证 Half-Open 试探仍过载时立刻重新熔断。
func TestCircuitBreakerHalfOpenReTrip(t *testing.T) {
	cb := newCircuitBreaker()
	cb.redLatencyMs = 100
	cb.tripThreshold = 1
	cb.cooldown = 50 * time.Millisecond
	cb.halfOpenMax = 2

	cb.Report(200, 0) // tripThreshold=1，一次过载即跳闸
	if got := cb.State(); got != metrics.CircuitRed {
		t.Fatalf("expected red, got %s", got)
	}

	time.Sleep(cb.cooldown + 10*time.Millisecond)
	if !cb.Allow() {
		t.Fatal("half-open should allow a probe after cooldown")
	}
	// 试探仍过载，应回到 Open。
	cb.Report(200, 0)
	if got := cb.State(); got != metrics.CircuitRed {
		t.Fatalf("expected red after failed probe, got %s", got)
	}
}

// TestCircuitBreakerStaysClosedUnderLightLoad 验证轻载下不会误熔断。
func TestCircuitBreakerStaysClosedUnderLightLoad(t *testing.T) {
	cb := newCircuitBreaker()
	cb.redLatencyMs = 100
	cb.redPoolUsage = 80
	cb.tripThreshold = 3

	for i := 0; i < 20; i++ {
		cb.Report(5, 10) // 远低于红线
		if !cb.Allow() {
			t.Fatal("light load should never trip the breaker")
		}
	}
	if got := cb.State(); got != metrics.CircuitGreen {
		t.Fatalf("expected green under light load, got %s", got)
	}
}

// TestCircuitBreakerPoolPressureNeedsLatencyToTrip 验证连接池瞬时吃紧只预警，不单独熔断。
func TestCircuitBreakerPoolPressureNeedsLatencyToTrip(t *testing.T) {
	cb := newCircuitBreaker()
	cb.yellowLatencyMs = 30
	cb.redLatencyMs = 100
	cb.redPoolUsage = 80
	cb.tripThreshold = 2

	for i := 0; i < 20; i++ {
		cb.Report(5, 100) // 连接池满，但 DB RT 很低，只应黄灯预警。
		if !cb.Allow() {
			t.Fatal("pool-only pressure should not open the breaker")
		}
	}
	if got := cb.State(); got != metrics.CircuitGreen {
		t.Fatalf("State reports internal open/half-open only; expected closed/green, got %s", got)
	}

	for i := 0; i < cb.tripThreshold; i++ {
		cb.Report(40, 100) // 连接池满且 RT 越过黄线，持续后才熔断。
	}
	if got := cb.State(); got != metrics.CircuitRed {
		t.Fatalf("expected red when pool pressure also raises latency, got %s", got)
	}
}

// TestCircuitBreakerReset 验证实验室真重置可以清掉上一轮熔断状态。
func TestCircuitBreakerReset(t *testing.T) {
	cb := newCircuitBreaker()
	cb.tripThreshold = 1
	cb.Report(200, 100)
	if got := cb.State(); got != metrics.CircuitRed {
		t.Fatalf("expected red before reset, got %s", got)
	}

	cb.Reset()
	if got := cb.State(); got != metrics.CircuitGreen {
		t.Fatalf("expected green after reset, got %s", got)
	}
	if !cb.Allow() {
		t.Fatal("reset breaker should allow requests")
	}
}
