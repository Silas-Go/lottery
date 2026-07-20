package metrics

import (
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// ArchiveCacheTTL 是记忆水晶副本的存活时间。页面会明确展示该值，避免把缓存误解成永久真本。
const ArchiveCacheTTL = 5 * time.Minute

const (
	ArchivePathDirect = "direct"
	ArchivePathCached = "cached"
)

// ArchiveReadSnapshot 是第一章“百职录”读实验的完整快照。
// 两组数据使用相同结构，页面可以在不改口径的情况下公平比较直读与 Cache-Aside。
type ArchiveReadSnapshot struct {
	At              string                  `json:"at"`
	CacheTTLSeconds int64                   `json:"cacheTTLSeconds"`
	Direct          ArchiveReadPathSnapshot `json:"direct"`
	Cached          ArchiveReadPathSnapshot `json:"cached"`
}

// ArchiveReadPathSnapshot 同时提供故事名背后的技术证据：请求、DB 翻阅、缓存命中和尾延迟。
type ArchiveReadPathSnapshot struct {
	TotalRequests int64 `json:"totalRequests"`
	QPS           int64 `json:"qps"`
	// SQLQueries 是详情组装实际执行的 SQL 语句数；DBReads 保留为旧前端兼容别名。
	SQLQueries   int64 `json:"sqlQueries"`
	DBReads      int64 `json:"dbReads"`
	CacheHits    int64 `json:"cacheHits"`
	CacheMisses  int64 `json:"cacheMisses"`
	CacheErrors  int64 `json:"cacheErrors"`
	Coalesced    int64 `json:"coalesced"`
	CacheHitRate int64 `json:"cacheHitRate"`
	Errors       int64 `json:"errors"`
	AvgLatency   int64 `json:"avgLatency"`
	P95          int64 `json:"p95"`
	P99          int64 `json:"p99"`
	MaxLatency   int64 `json:"maxLatency"`
	DBAvgLatency int64 `json:"dbAvgLatency"`
	DBP95Latency int64 `json:"dbP95Latency"`
	DBP99Latency int64 `json:"dbP99Latency"`
	PoolInUse    int64 `json:"poolInUse"`
	PoolPeak     int64 `json:"poolPeak"`
	PoolCapacity int64 `json:"poolCapacity"`
	PoolUsage    int64 `json:"poolUsage"`
}

type archivePathMeter struct {
	totalRequests int64
	sqlQueries    int64
	cacheHits     int64
	cacheMisses   int64
	cacheErrors   int64
	coalesced     int64
	errors        int64
	maxLatency    int64
	poolInUse     int64
	poolPeak      int64
	poolCapacity  int64

	mu               sync.Mutex
	latencySamples   []int64
	dbLatencySamples []int64
	secondBuckets    map[int64]int64
}

var archiveMeters = map[string]*archivePathMeter{
	ArchivePathDirect: {secondBuckets: make(map[int64]int64)},
	ArchivePathCached: {secondBuckets: make(map[int64]int64)},
}

func archiveMeter(path string) *archivePathMeter {
	if meter := archiveMeters[path]; meter != nil {
		return meter
	}
	return archiveMeters[ArchivePathDirect]
}

// RecordArchiveRequest 记录一次进入某条档案读取链路的请求。
func RecordArchiveRequest(path string) {
	meter := archiveMeter(path)
	atomic.AddInt64(&meter.totalRequests, 1)
	now := time.Now().Unix()
	meter.mu.Lock()
	meter.secondBuckets[now]++
	for second := range meter.secondBuckets {
		if second < now-8 {
			delete(meter.secondBuckets, second)
		}
	}
	meter.mu.Unlock()
}

// RecordArchiveLatency 记录用户实际感知的 HTTP 总耗时；失败单独计数但仍保留延迟样本。
func RecordArchiveLatency(path string, duration time.Duration, failed bool) {
	meter := archiveMeter(path)
	ms := duration.Milliseconds()
	if ms < 1 {
		ms = 1
	}
	if failed {
		atomic.AddInt64(&meter.errors, 1)
	}
	updateMax(&meter.maxLatency, ms)
	meter.mu.Lock()
	meter.latencySamples = appendBounded(meter.latencySamples, ms)
	meter.mu.Unlock()
}

// RecordArchiveSQLQueries 记录一次详情 DTO 组装实际执行的 SQL 数量、总耗时和连接池采样。
// duration 是整个查询束的耗时，而不是人为叠加的单 SQL 延迟。
func RecordArchiveSQLQueries(path string, duration time.Duration, queryCount, inUse, capacity int) {
	meter := archiveMeter(path)
	atomic.AddInt64(&meter.sqlQueries, int64(queryCount))
	atomic.StoreInt64(&meter.poolInUse, int64(inUse))
	atomic.StoreInt64(&meter.poolCapacity, int64(capacity))
	updateMax(&meter.poolPeak, int64(inUse))
	ms := duration.Milliseconds()
	if ms < 1 {
		ms = 1
	}
	meter.mu.Lock()
	meter.dbLatencySamples = appendBounded(meter.dbLatencySamples, ms)
	meter.mu.Unlock()
}

func RecordArchiveCacheHit()       { atomic.AddInt64(&archiveMeter(ArchivePathCached).cacheHits, 1) }
func RecordArchiveCacheMiss()      { atomic.AddInt64(&archiveMeter(ArchivePathCached).cacheMisses, 1) }
func RecordArchiveCacheError()     { atomic.AddInt64(&archiveMeter(ArchivePathCached).cacheErrors, 1) }
func RecordArchiveCacheCoalesced() { atomic.AddInt64(&archiveMeter(ArchivePathCached).coalesced, 1) }

func appendBounded(values []int64, value int64) []int64 {
	values = append(values, value)
	if len(values) <= maxLatencySamples {
		return values
	}
	copy(values, values[len(values)-maxLatencySamples:])
	return values[:maxLatencySamples]
}

// ResetArchiveRead 清空第一章指标；它不触碰库存和订单实验。
func ResetArchiveRead() {
	for _, meter := range archiveMeters {
		atomic.StoreInt64(&meter.totalRequests, 0)
		atomic.StoreInt64(&meter.sqlQueries, 0)
		atomic.StoreInt64(&meter.cacheHits, 0)
		atomic.StoreInt64(&meter.cacheMisses, 0)
		atomic.StoreInt64(&meter.cacheErrors, 0)
		atomic.StoreInt64(&meter.coalesced, 0)
		atomic.StoreInt64(&meter.errors, 0)
		atomic.StoreInt64(&meter.maxLatency, 0)
		atomic.StoreInt64(&meter.poolInUse, 0)
		atomic.StoreInt64(&meter.poolPeak, 0)
		atomic.StoreInt64(&meter.poolCapacity, 0)
		meter.mu.Lock()
		meter.latencySamples = nil
		meter.dbLatencySamples = nil
		meter.secondBuckets = make(map[int64]int64)
		meter.mu.Unlock()
	}
}

// SnapshotArchiveRead 返回同一时刻的直读和缓存读数据。
func SnapshotArchiveRead(cacheTTL time.Duration) ArchiveReadSnapshot {
	now := time.Now()
	return ArchiveReadSnapshot{
		At:              now.Format(time.RFC3339),
		CacheTTLSeconds: int64(cacheTTL.Seconds()),
		Direct:          snapshotArchivePath(now, archiveMeter(ArchivePathDirect)),
		Cached:          snapshotArchivePath(now, archiveMeter(ArchivePathCached)),
	}
}

func snapshotArchivePath(now time.Time, meter *archivePathMeter) ArchiveReadPathSnapshot {
	meter.mu.Lock()
	latencies := append([]int64(nil), meter.latencySamples...)
	dbLatencies := append([]int64(nil), meter.dbLatencySamples...)
	qps := recentQPS(now, meter.secondBuckets)
	meter.mu.Unlock()
	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	sort.Slice(dbLatencies, func(i, j int) bool { return dbLatencies[i] < dbLatencies[j] })
	hits := atomic.LoadInt64(&meter.cacheHits)
	misses := atomic.LoadInt64(&meter.cacheMisses)
	var hitRate int64
	if total := hits + misses; total > 0 {
		hitRate = hits * 100 / total
	}
	peak := atomic.LoadInt64(&meter.poolPeak)
	capacity := atomic.LoadInt64(&meter.poolCapacity)
	var usage int64
	if capacity > 0 {
		usage = peak * 100 / capacity
	}
	sqlQueries := atomic.LoadInt64(&meter.sqlQueries)
	return ArchiveReadPathSnapshot{
		TotalRequests: atomic.LoadInt64(&meter.totalRequests), QPS: qps,
		SQLQueries: sqlQueries, DBReads: sqlQueries, CacheHits: hits, CacheMisses: misses,
		CacheErrors: atomic.LoadInt64(&meter.cacheErrors), Coalesced: atomic.LoadInt64(&meter.coalesced),
		CacheHitRate: hitRate, Errors: atomic.LoadInt64(&meter.errors),
		AvgLatency: average(latencies), P95: percentile(latencies, .95), P99: percentile(latencies, .99),
		MaxLatency: atomic.LoadInt64(&meter.maxLatency), DBAvgLatency: average(dbLatencies),
		DBP95Latency: percentile(dbLatencies, .95), DBP99Latency: percentile(dbLatencies, .99),
		PoolInUse: atomic.LoadInt64(&meter.poolInUse), PoolPeak: peak, PoolCapacity: capacity, PoolUsage: usage,
	}
}
