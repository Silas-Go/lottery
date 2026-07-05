package metrics

import (
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// MySQLPressureSnapshot 表示某条业务链路上的 MySQL 压力截面。
// 预扣链路用它记录轻量读查询；旁路缓存链路继续使用 CacheAsideSnapshot 记录更完整的 DB 压力。
type MySQLPressureSnapshot struct {
	At string `json:"at"`

	QPS           int64 `json:"qps"`
	TotalRequests int64 `json:"totalRequests"`

	DBAvgLatency int64 `json:"dbAvgLatency"`
	DBP95Latency int64 `json:"dbP95Latency"`
	DBP99Latency int64 `json:"dbP99Latency"`
	DBMaxLatency int64 `json:"dbMaxLatency"`

	PoolInUse    int64 `json:"poolInUse"`
	PoolCapacity int64 `json:"poolCapacity"`
	PoolUsage    int64 `json:"poolUsage"`
}

type mysqlPressureMeter struct {
	totalRequests int64
	dbMaxLatency  int64
	poolInUse     int64
	poolCapacity  int64

	mu            sync.Mutex
	latencies     []int64
	secondBuckets map[int64]int64
}

var preDeductMySQLMeter = &mysqlPressureMeter{
	secondBuckets: make(map[int64]int64),
}

// RecordPreDeductMySQL 记录预扣库存链路中的一次 MySQL 操作。
// 预扣链路不把库存扣减压到 MySQL，但仍会有防重复查询和奖品详情查询，用这个指标和 Cache-Aside 对比。
func RecordPreDeductMySQL(duration time.Duration, poolInUse, poolCapacity int) {
	recordMySQLPressure(preDeductMySQLMeter, duration, poolInUse, poolCapacity)
}

func resetPreDeductMySQLMetrics() {
	resetMySQLPressure(preDeductMySQLMeter)
}

func SnapshotPreDeductMySQL() MySQLPressureSnapshot {
	return snapshotMySQLPressure(preDeductMySQLMeter)
}

func recordMySQLPressure(m *mysqlPressureMeter, duration time.Duration, poolInUse, poolCapacity int) {
	ms := duration.Milliseconds()
	if ms < 1 {
		ms = 1
	}
	atomic.AddInt64(&m.totalRequests, 1)
	updateMax(&m.dbMaxLatency, ms)
	atomic.StoreInt64(&m.poolInUse, int64(poolInUse))
	atomic.StoreInt64(&m.poolCapacity, int64(poolCapacity))

	now := time.Now().Unix()
	m.mu.Lock()
	m.secondBuckets[now]++
	for sec := range m.secondBuckets {
		if sec < now-8 {
			delete(m.secondBuckets, sec)
		}
	}
	m.latencies = append(m.latencies, ms)
	if len(m.latencies) > maxLatencySamples {
		copy(m.latencies, m.latencies[len(m.latencies)-maxLatencySamples:])
		m.latencies = m.latencies[:maxLatencySamples]
	}
	m.mu.Unlock()
}

func resetMySQLPressure(m *mysqlPressureMeter) {
	atomic.StoreInt64(&m.totalRequests, 0)
	atomic.StoreInt64(&m.dbMaxLatency, 0)
	atomic.StoreInt64(&m.poolInUse, 0)
	atomic.StoreInt64(&m.poolCapacity, 0)

	m.mu.Lock()
	m.latencies = nil
	m.secondBuckets = make(map[int64]int64)
	m.mu.Unlock()
}

func snapshotMySQLPressure(m *mysqlPressureMeter) MySQLPressureSnapshot {
	now := time.Now()

	m.mu.Lock()
	latencies := append([]int64(nil), m.latencies...)
	qps := recentQPS(now, m.secondBuckets)
	m.mu.Unlock()

	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })

	inUse := atomic.LoadInt64(&m.poolInUse)
	capacity := atomic.LoadInt64(&m.poolCapacity)
	var poolUsage int64
	if capacity > 0 {
		poolUsage = inUse * 100 / capacity
	}

	return MySQLPressureSnapshot{
		At:            now.Format(time.RFC3339),
		QPS:           qps,
		TotalRequests: atomic.LoadInt64(&m.totalRequests),
		DBAvgLatency:  average(latencies),
		DBP95Latency:  percentile(latencies, 0.95),
		DBP99Latency:  percentile(latencies, 0.99),
		DBMaxLatency:  atomic.LoadInt64(&m.dbMaxLatency),
		PoolInUse:     inUse,
		PoolCapacity:  capacity,
		PoolUsage:     poolUsage,
	}
}
