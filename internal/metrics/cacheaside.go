package metrics

import (
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// 熔断状态文本，前端据此渲染绿/黄/红三色信号灯。
const (
	// CircuitGreen 表示链路健康：DB RT 和连接池占用都在安全区。
	CircuitGreen = "green"
	// CircuitYellow 表示预警：压力升高（RT 接近红线或连接池吃紧），或熔断器处于 Half-Open 试探。
	CircuitYellow = "yellow"
	// CircuitRed 表示熔断：系统过载，已 fail-fast 拒绝新请求保护 MySQL。
	CircuitRed = "red"
)

// CacheAsideSnapshot 是旁路缓存模式的压力指标截面，供前端压力面板和红灯预警展示。
// 它和预扣模式的 Snapshot 完全独立，这样同一个页面能并排对比两种模式在相同压力下的表现。
type CacheAsideSnapshot struct {
	At string `json:"at"`

	// QPS 是 Cache-Aside 抽奖每秒请求数。
	QPS int64 `json:"qps"`

	// TotalRequests 是进入 Cache-Aside 链路的抽奖请求总数（含被熔断拒绝的）。
	TotalRequests int64 `json:"totalRequests"`

	// Completed 是成功扣减库存并写入正式订单的请求数。
	Completed int64 `json:"completed"`

	// SoldOut 是因库存售罄而未中奖的请求数。
	SoldOut int64 `json:"soldOut"`

	// Rejected 是被熔断器降级拒绝的请求数（系统过载保护）。
	Rejected int64 `json:"rejected"`

	// CacheHits / CacheMisses 是聚合库存缓存的命中数与击穿（回源 MySQL）数。
	CacheHits   int64 `json:"cacheHits"`
	CacheMisses int64 `json:"cacheMisses"`

	// CacheHitRate 是缓存命中率百分比（0-100）；写密集时会显著下降，说明缓存近乎失效。
	CacheHitRate int64 `json:"cacheHitRate"`

	// AvgLatency/P95/P99/MaxLatency 是 Cache-Aside HTTP 总请求耗时，单位毫秒。
	// 这是用户实际感知到的端到端延迟，包含业务判断、缓存读取、DB 扣减与订单写入。
	AvgLatency int64 `json:"avgLatency"`
	P95        int64 `json:"p95"`
	P99        int64 `json:"p99"`
	MaxLatency int64 `json:"maxLatency"`

	// DBAvgLatency/DBP95Latency/DBMaxLatency 是数据库环节耗时（含连接池排队等待），单位毫秒。
	// 这是 Cache-Aside 慢的核心证据，也是熔断红线的主要依据。
	DBAvgLatency int64 `json:"dbAvgLatency"`
	DBP95Latency int64 `json:"dbP95Latency"`
	DBP99Latency int64 `json:"dbP99Latency"`
	DBMaxLatency int64 `json:"dbMaxLatency"`

	// PoolInUse/PoolCapacity/PoolUsage 是 DB 并发闸门（模拟连接池）的占用情况与占用率百分比。
	PoolInUse    int64 `json:"poolInUse"`
	PoolCapacity int64 `json:"poolCapacity"`
	PoolUsage    int64 `json:"poolUsage"`

	// CircuitState 是熔断器状态：green/yellow/red，驱动前端信号灯和红灯预警。
	CircuitState string `json:"circuitState"`

	// Events 是 Cache-Aside 链路最近的业务事件，用中文解释压力与降级状态变化。
	Events []Event `json:"events"`
}

type cacheMeter struct {
	totalRequests int64
	completed     int64
	soldOut       int64
	rejected      int64
	cacheHits     int64
	cacheMisses   int64
	maxLatency    int64
	dbMaxLatency  int64
	poolInUse     int64
	poolCapacity  int64

	circuitState atomic.Value // string

	mu               sync.Mutex
	latencySamples   []int64
	dbLatencySamples []int64
	secondBuckets    map[int64]int64
	events           []Event
}

var defaultCacheMeter = func() *cacheMeter {
	m := &cacheMeter{secondBuckets: make(map[int64]int64)}
	m.circuitState.Store(CircuitGreen)
	return m
}()

func resetCacheAsideMetrics() {
	atomic.StoreInt64(&defaultCacheMeter.totalRequests, 0)
	atomic.StoreInt64(&defaultCacheMeter.completed, 0)
	atomic.StoreInt64(&defaultCacheMeter.soldOut, 0)
	atomic.StoreInt64(&defaultCacheMeter.rejected, 0)
	atomic.StoreInt64(&defaultCacheMeter.cacheHits, 0)
	atomic.StoreInt64(&defaultCacheMeter.cacheMisses, 0)
	atomic.StoreInt64(&defaultCacheMeter.maxLatency, 0)
	atomic.StoreInt64(&defaultCacheMeter.dbMaxLatency, 0)
	atomic.StoreInt64(&defaultCacheMeter.poolInUse, 0)
	atomic.StoreInt64(&defaultCacheMeter.poolCapacity, 0)
	defaultCacheMeter.circuitState.Store(CircuitGreen)

	defaultCacheMeter.mu.Lock()
	defaultCacheMeter.latencySamples = nil
	defaultCacheMeter.dbLatencySamples = nil
	defaultCacheMeter.secondBuckets = make(map[int64]int64)
	defaultCacheMeter.events = nil
	defaultCacheMeter.mu.Unlock()
}

// RecordCacheAsideRequest 记录一次 Cache-Aside 抽奖请求，用于统计请求总数和 QPS。
func RecordCacheAsideRequest() {
	atomic.AddInt64(&defaultCacheMeter.totalRequests, 1)
	now := time.Now().Unix()
	defaultCacheMeter.mu.Lock()
	defaultCacheMeter.secondBuckets[now]++
	for sec := range defaultCacheMeter.secondBuckets {
		if sec < now-8 {
			delete(defaultCacheMeter.secondBuckets, sec)
		}
	}
	defaultCacheMeter.mu.Unlock()
}

// RecordCacheAsideLatency 记录一次 Cache-Aside HTTP 总请求耗时，单位由 duration 提供。
// 这和 DBLatency 分开：前者是用户感知的端到端耗时，后者只刻画数据库瓶颈。
func RecordCacheAsideLatency(duration time.Duration) {
	ms := duration.Milliseconds()
	if ms < 1 {
		ms = 1
	}
	updateMax(&defaultCacheMeter.maxLatency, ms)
	defaultCacheMeter.mu.Lock()
	defaultCacheMeter.latencySamples = append(defaultCacheMeter.latencySamples, ms)
	if len(defaultCacheMeter.latencySamples) > maxLatencySamples {
		copy(defaultCacheMeter.latencySamples, defaultCacheMeter.latencySamples[len(defaultCacheMeter.latencySamples)-maxLatencySamples:])
		defaultCacheMeter.latencySamples = defaultCacheMeter.latencySamples[:maxLatencySamples]
	}
	defaultCacheMeter.mu.Unlock()
}

// RecordCacheAsideDBLatency 记录一次数据库环节耗时（含连接池排队等待），单位毫秒。
func RecordCacheAsideDBLatency(ms int64) {
	if ms < 1 {
		ms = 1
	}
	updateMax(&defaultCacheMeter.dbMaxLatency, ms)
	defaultCacheMeter.mu.Lock()
	defaultCacheMeter.dbLatencySamples = append(defaultCacheMeter.dbLatencySamples, ms)
	if len(defaultCacheMeter.dbLatencySamples) > maxLatencySamples {
		copy(defaultCacheMeter.dbLatencySamples, defaultCacheMeter.dbLatencySamples[len(defaultCacheMeter.dbLatencySamples)-maxLatencySamples:])
		defaultCacheMeter.dbLatencySamples = defaultCacheMeter.dbLatencySamples[:maxLatencySamples]
	}
	defaultCacheMeter.mu.Unlock()
}

// RecordCacheHit 记录一次聚合库存缓存命中。
func RecordCacheHit() { atomic.AddInt64(&defaultCacheMeter.cacheHits, 1) }

// RecordCacheMiss 记录一次缓存击穿（回源 MySQL）。
func RecordCacheMiss() {
	n := atomic.AddInt64(&defaultCacheMeter.cacheMisses, 1)
	if shouldEmit(n) {
		defaultCacheMeter.addEvent("缓存击穿", fmt.Sprintf("第 %d 次缓存未命中，回源 MySQL 读取库存。", n), "warning")
	}
}

// RecordCacheAsideCompleted 记录一次 Cache-Aside 成功中奖并落库。
func RecordCacheAsideCompleted(giftID int) {
	n := atomic.AddInt64(&defaultCacheMeter.completed, 1)
	if shouldEmit(n) {
		defaultCacheMeter.addEvent("订单完成", fmt.Sprintf("第 %d 个 Cache-Aside 正式订单已落库，奖品 ID：%d。", n, giftID), "success")
	}
}

// RecordCacheAsideSoldOut 记录一次因库存售罄导致的未中奖。
func RecordCacheAsideSoldOut() {
	n := atomic.AddInt64(&defaultCacheMeter.soldOut, 1)
	if shouldEmit(n) {
		defaultCacheMeter.addEvent("库存售罄", fmt.Sprintf("第 %d 个请求未抢到库存（MySQL 行锁判定售罄，不超卖）。", n), "warning")
	}
}

// RecordCacheAsideRejected 记录一次被熔断器降级拒绝的请求。
func RecordCacheAsideRejected() {
	n := atomic.AddInt64(&defaultCacheMeter.rejected, 1)
	if shouldEmit(n) {
		defaultCacheMeter.addEvent("熔断降级", fmt.Sprintf("第 %d 个请求被过载保护拒绝，fail-fast 保护 MySQL。", n), "danger")
	}
}

// SetCacheAsidePool 更新连接池占用采样值。
// 由 service 在持有 DB 闸门令牌时采样传入，能捕捉到过载峰值，而不是请求结束后的空闲值。
func SetCacheAsidePool(inUse, capacity int) {
	atomic.StoreInt64(&defaultCacheMeter.poolInUse, int64(inUse))
	atomic.StoreInt64(&defaultCacheMeter.poolCapacity, int64(capacity))
}

// SetCircuitState 更新熔断器状态文本（green/yellow/red），并在状态切换时记录事件。
func SetCircuitState(state string) {
	prev, _ := defaultCacheMeter.circuitState.Load().(string)
	if prev == state {
		return
	}
	defaultCacheMeter.circuitState.Store(state)
	switch state {
	case CircuitRed:
		defaultCacheMeter.addEvent("熔断开启", "系统过载，熔断器切到 Open，开始 fail-fast 拒绝新请求。", "danger")
	case CircuitYellow:
		defaultCacheMeter.addEvent("压力预警", "压力升高或熔断器试探恢复中（Half-Open）。", "warning")
	case CircuitGreen:
		defaultCacheMeter.addEvent("恢复正常", "压力回落，熔断器恢复 Closed，链路放行。", "success")
	}
}

// SnapshotCacheAside 生成 Cache-Aside 压力指标快照。
func SnapshotCacheAside() CacheAsideSnapshot {
	now := time.Now()

	defaultCacheMeter.mu.Lock()
	latencies := append([]int64(nil), defaultCacheMeter.latencySamples...)
	dbLatencies := append([]int64(nil), defaultCacheMeter.dbLatencySamples...)
	qps := recentQPS(now, defaultCacheMeter.secondBuckets)
	events := append([]Event(nil), defaultCacheMeter.events...)
	defaultCacheMeter.mu.Unlock()

	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	sort.Slice(dbLatencies, func(i, j int) bool { return dbLatencies[i] < dbLatencies[j] })

	hits := atomic.LoadInt64(&defaultCacheMeter.cacheHits)
	misses := atomic.LoadInt64(&defaultCacheMeter.cacheMisses)
	var hitRate int64
	if total := hits + misses; total > 0 {
		hitRate = hits * 100 / total
	}

	inUse := atomic.LoadInt64(&defaultCacheMeter.poolInUse)
	capacity := atomic.LoadInt64(&defaultCacheMeter.poolCapacity)
	var poolUsage int64
	if capacity > 0 {
		poolUsage = inUse * 100 / capacity
	}

	state, _ := defaultCacheMeter.circuitState.Load().(string)
	if state == "" {
		state = CircuitGreen
	}

	return CacheAsideSnapshot{
		At:            now.Format(time.RFC3339),
		QPS:           qps,
		TotalRequests: atomic.LoadInt64(&defaultCacheMeter.totalRequests),
		Completed:     atomic.LoadInt64(&defaultCacheMeter.completed),
		SoldOut:       atomic.LoadInt64(&defaultCacheMeter.soldOut),
		Rejected:      atomic.LoadInt64(&defaultCacheMeter.rejected),
		CacheHits:     hits,
		CacheMisses:   misses,
		CacheHitRate:  hitRate,
		AvgLatency:    average(latencies),
		P95:           percentile(latencies, 0.95),
		P99:           percentile(latencies, 0.99),
		MaxLatency:    atomic.LoadInt64(&defaultCacheMeter.maxLatency),
		DBAvgLatency:  average(dbLatencies),
		DBP95Latency:  percentile(dbLatencies, 0.95),
		DBP99Latency:  percentile(dbLatencies, 0.99),
		DBMaxLatency:  atomic.LoadInt64(&defaultCacheMeter.dbMaxLatency),
		PoolInUse:     inUse,
		PoolCapacity:  capacity,
		PoolUsage:     poolUsage,
		CircuitState:  state,
		Events:        events,
	}
}

func (m *cacheMeter) addEvent(title, detail, tone string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.events = append([]Event{{
		Time:   time.Now().Format("15:04:05"),
		Title:  title,
		Detail: detail,
		Tone:   tone,
	}}, m.events...)
	if len(m.events) > maxEvents {
		m.events = m.events[:maxEvents]
	}
}
