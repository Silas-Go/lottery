package metrics

import (
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// RateLimitProbeSnapshot 只统计共享令牌桶探针，不包含库存、订单或 MQ 行为。
// 把它和 /lucky 指标拆开，才能在售罄后仍然单独解释入口保护效果。
type RateLimitProbeSnapshot struct {
	TotalRequests int64 `json:"totalRequests"`
	Allowed       int64 `json:"allowed"`
	Limited       int64 `json:"limited"`
	QPS           int64 `json:"qps"`
	P95           int64 `json:"p95"`
	P99           int64 `json:"p99"`
}

type rateLimitProbeMeter struct {
	total   int64
	allowed int64
	limited int64

	mu             sync.Mutex
	secondBuckets  map[int64]int64
	latencySamples []int64
}

var defaultRateLimitProbe = &rateLimitProbeMeter{secondBuckets: make(map[int64]int64)}

// RecordRateLimitProbe 记录一次真实 HTTP 探针结果；allowed=false 对应 HTTP 429。
func RecordRateLimitProbe(allowed bool, duration time.Duration) {
	atomic.AddInt64(&defaultRateLimitProbe.total, 1)
	if allowed {
		atomic.AddInt64(&defaultRateLimitProbe.allowed, 1)
	} else {
		atomic.AddInt64(&defaultRateLimitProbe.limited, 1)
	}
	ms := duration.Milliseconds()
	if ms < 1 {
		ms = 1
	}
	now := time.Now().Unix()
	defaultRateLimitProbe.mu.Lock()
	defaultRateLimitProbe.secondBuckets[now]++
	for second := range defaultRateLimitProbe.secondBuckets {
		if second < now-8 {
			delete(defaultRateLimitProbe.secondBuckets, second)
		}
	}
	defaultRateLimitProbe.latencySamples = append(defaultRateLimitProbe.latencySamples, ms)
	if len(defaultRateLimitProbe.latencySamples) > maxLatencySamples {
		defaultRateLimitProbe.latencySamples = append([]int64(nil), defaultRateLimitProbe.latencySamples[len(defaultRateLimitProbe.latencySamples)-maxLatencySamples:]...)
	}
	defaultRateLimitProbe.mu.Unlock()
}

// ResetRateLimitProbe 让每轮限流实验拥有独立指标基线。
func ResetRateLimitProbe() {
	atomic.StoreInt64(&defaultRateLimitProbe.total, 0)
	atomic.StoreInt64(&defaultRateLimitProbe.allowed, 0)
	atomic.StoreInt64(&defaultRateLimitProbe.limited, 0)
	defaultRateLimitProbe.mu.Lock()
	defaultRateLimitProbe.secondBuckets = make(map[int64]int64)
	defaultRateLimitProbe.latencySamples = nil
	defaultRateLimitProbe.mu.Unlock()
}

// SnapshotRateLimitProbe 返回探针的当前真实快照。
func SnapshotRateLimitProbe() RateLimitProbeSnapshot {
	defaultRateLimitProbe.mu.Lock()
	latencies := append([]int64(nil), defaultRateLimitProbe.latencySamples...)
	qps := recentQPS(time.Now(), defaultRateLimitProbe.secondBuckets)
	defaultRateLimitProbe.mu.Unlock()
	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	return RateLimitProbeSnapshot{
		TotalRequests: atomic.LoadInt64(&defaultRateLimitProbe.total),
		Allowed:       atomic.LoadInt64(&defaultRateLimitProbe.allowed),
		Limited:       atomic.LoadInt64(&defaultRateLimitProbe.limited),
		QPS:           qps,
		P95:           percentile(latencies, 0.95),
		P99:           percentile(latencies, 0.99),
	}
}
