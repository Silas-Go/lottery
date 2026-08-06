package metrics

import (
	"sort"
	"sync"
	"time"
)

const archiveScenarioStableSeconds = 3

// ArchiveScenarioSample 描述一次任务级查询实际走过的缓存与数据库路径。
// RedisMiss 记录第一次相关 Key 查询为空；它与最终是否被互斥合并分开计数。
type ArchiveScenarioSample struct {
	PositiveCacheHit   bool
	RedisMiss          bool
	Coalesced          bool
	MySQLFallback      bool
	SQLQueries         int
	CacheRebuilt       bool
	NegativeCacheHit   bool
	NegativeCacheWrite bool
	Nonexistent        bool
	InvalidMySQLQuery  bool
	ExpectedNotFound   bool
	Failed             bool
	KeyPTTLMillis      int64
	Duration           time.Duration
}

// ArchiveScenarioCounters 同时用于上一完整秒和整轮累计，保证页面不会拿累计平均冒充实时变化。
type ArchiveScenarioCounters struct {
	Second              int64   `json:"second,omitempty"`
	Requests            int64   `json:"requests"`
	PositiveCacheHits   int64   `json:"positiveCacheHits"`
	RedisMisses         int64   `json:"redisMisses"`
	CoalescedAfterMiss  int64   `json:"coalescedAfterMiss"`
	MySQLFallbacks      int64   `json:"mysqlFallbacks"`
	SQLQueries          int64   `json:"sqlQueries"`
	CacheRebuilds       int64   `json:"cacheRebuilds"`
	NegativeCacheHits   int64   `json:"negativeCacheHits"`
	NegativeCacheWrites int64   `json:"negativeCacheWrites"`
	NonexistentRequests int64   `json:"nonexistentRequests"`
	InvalidMySQLQueries int64   `json:"invalidMySQLQueries"`
	ExpectedNotFound    int64   `json:"expectedNotFound"`
	Errors              int64   `json:"errors"`
	HitRate             float64 `json:"hitRate"`
	P95Latency          int64   `json:"p95Latency"`
	MaxLatency          int64   `json:"maxLatency"`
}

// ArchiveScenarioSnapshot 是任务级热点失效或缓存穿透的权威状态。
type ArchiveScenarioSnapshot struct {
	At                 string                  `json:"at"`
	Active             bool                    `json:"active"`
	Scenario           string                  `json:"scenario,omitempty"`
	Protection         string                  `json:"protection,omitempty"`
	Phase              string                  `json:"phase,omitempty"`
	MissingID          int                     `json:"missingId,omitempty"`
	KeyPresent         bool                    `json:"keyPresent"`
	KeyPTTLMillis      int64                   `json:"keyPttlMillis"`
	Current            ArchiveScenarioCounters `json:"current"`
	Round              ArchiveScenarioCounters `json:"round"`
	Stable             ArchiveScenarioCounters `json:"stable"`
	Impact             ArchiveScenarioCounters `json:"impact"`
	Recovered          ArchiveScenarioCounters `json:"recovered"`
	EvictedAt          string                  `json:"evictedAt,omitempty"`
	RebuiltAt          string                  `json:"rebuiltAt,omitempty"`
	StableAt           string                  `json:"stableAt,omitempty"`
	RebuildDurationMS  int64                   `json:"rebuildDurationMs"`
	RecoveryDurationMS int64                   `json:"recoveryDurationMs"`
}

type archiveScenarioBucket struct {
	ArchiveScenarioCounters
	latencies []int64
}

type archiveScenarioMeter struct {
	mu sync.Mutex

	active        bool
	scenario      string
	protection    string
	phase         string
	missingID     int
	keyPresent    bool
	keyPTTLMillis int64
	evictedAt     time.Time
	rebuiltAt     time.Time
	stableAt      time.Time
	round         archiveScenarioBucket
	stable        archiveScenarioBucket
	impact        archiveScenarioBucket
	recovered     archiveScenarioBucket
	seconds       map[int64]*archiveScenarioBucket
}

var defaultArchiveScenario = &archiveScenarioMeter{seconds: make(map[int64]*archiveScenarioBucket)}

// ResetArchiveScenario 建立一轮新的任务指标；它不会修改 Redis 或 MySQL。
func ResetArchiveScenario(scenario, protection, phase string, missingID int, keyPresent bool, keyPTTL time.Duration) {
	meter := defaultArchiveScenario
	meter.mu.Lock()
	defer meter.mu.Unlock()
	meter.active = true
	meter.scenario = scenario
	meter.protection = protection
	meter.phase = phase
	meter.missingID = missingID
	meter.keyPresent = keyPresent
	meter.keyPTTLMillis = keyPTTL.Milliseconds()
	meter.evictedAt = time.Time{}
	meter.rebuiltAt = time.Time{}
	meter.stableAt = time.Time{}
	meter.round = archiveScenarioBucket{}
	meter.stable = archiveScenarioBucket{}
	meter.impact = archiveScenarioBucket{}
	meter.recovered = archiveScenarioBucket{}
	meter.seconds = make(map[int64]*archiveScenarioBucket)
}

// DeactivateArchiveScenario 只关闭任务作用域，保留终态快照供 SSE 与任务结算读取。
func DeactivateArchiveScenario() {
	defaultArchiveScenario.mu.Lock()
	defaultArchiveScenario.active = false
	defaultArchiveScenario.mu.Unlock()
}

// RecordArchiveScenarioEvicted 只在 Redis 确认删除了热点 Key 后推进阶段。
func RecordArchiveScenarioEvicted(at time.Time) {
	meter := defaultArchiveScenario
	meter.mu.Lock()
	defer meter.mu.Unlock()
	meter.phase = "evicted"
	meter.keyPresent = false
	meter.keyPTTLMillis = 0
	meter.evictedAt = at
	meter.rebuiltAt = time.Time{}
	meter.stableAt = time.Time{}
	// Runner 只有在连续两个完整秒都稳定命中后才会触发失效；冻结紧邻失效前的
	// 最后一个完整秒，避免任务结束后把整轮平均值冒充稳态基线。
	if bucket := meter.seconds[at.Unix()-1]; bucket != nil {
		meter.stable = cloneArchiveScenarioBucket(bucket)
	}
	meter.impact = archiveScenarioBucket{}
	meter.recovered = archiveScenarioBucket{}
}

// RecordArchiveScenarioSample 记录一次真实请求，并按请求结束所在秒归桶。
func RecordArchiveScenarioSample(sample ArchiveScenarioSample) {
	now := time.Now()
	meter := defaultArchiveScenario
	meter.mu.Lock()
	defer meter.mu.Unlock()
	if !meter.active {
		return
	}
	bucket := meter.seconds[now.Unix()]
	if bucket == nil {
		bucket = &archiveScenarioBucket{}
		meter.seconds[now.Unix()] = bucket
	}
	applyArchiveScenarioSample(&meter.round, sample)
	applyArchiveScenarioSample(bucket, sample)
	// 冲击窗口严格取真实 DEL 后一秒。缓存通常会在毫秒级重建，因此这一秒既包含
	// 失效后的 MISS，也包含重建后的 HIT，能保留页面当时看到的命中率跌落与恢复。
	if meter.scenario == "cache-breakdown" && !meter.evictedAt.IsZero() &&
		now.Before(meter.evictedAt.Add(time.Second)) {
		applyArchiveScenarioSample(&meter.impact, sample)
	}
	if sample.CacheRebuilt {
		meter.keyPresent = true
		meter.keyPTTLMillis = sample.KeyPTTLMillis
		if meter.rebuiltAt.IsZero() && !meter.evictedAt.IsZero() {
			meter.rebuiltAt = now
			meter.phase = "recovering"
		}
	}
	for second := range meter.seconds {
		if second < now.Unix()-8 {
			delete(meter.seconds, second)
		}
	}
}

func applyArchiveScenarioSample(bucket *archiveScenarioBucket, sample ArchiveScenarioSample) {
	bucket.Requests++
	if sample.PositiveCacheHit {
		bucket.PositiveCacheHits++
	}
	if sample.RedisMiss {
		bucket.RedisMisses++
	}
	if sample.Coalesced {
		bucket.CoalescedAfterMiss++
	}
	if sample.MySQLFallback {
		bucket.MySQLFallbacks++
	}
	bucket.SQLQueries += int64(sample.SQLQueries)
	if sample.CacheRebuilt {
		bucket.CacheRebuilds++
	}
	if sample.NegativeCacheHit {
		bucket.NegativeCacheHits++
	}
	if sample.NegativeCacheWrite {
		bucket.NegativeCacheWrites++
	}
	if sample.Nonexistent {
		bucket.NonexistentRequests++
	}
	if sample.InvalidMySQLQuery {
		bucket.InvalidMySQLQueries++
	}
	if sample.ExpectedNotFound {
		bucket.ExpectedNotFound++
	}
	if sample.Failed {
		bucket.Errors++
	}
	latency := sample.Duration.Milliseconds()
	if latency < 1 {
		latency = 1
	}
	bucket.latencies = appendBounded(bucket.latencies, latency)
}

// SnapshotArchiveScenario 返回上一完整秒与整轮累计，并用三秒真实稳定窗口判定恢复。
func SnapshotArchiveScenario() ArchiveScenarioSnapshot {
	now := time.Now()
	meter := defaultArchiveScenario
	meter.mu.Lock()
	defer meter.mu.Unlock()
	evaluateArchiveScenarioRecoveryLocked(meter, now)
	currentSecond := now.Unix() - 1
	current := snapshotArchiveScenarioBucket(currentSecond, meter.seconds[currentSecond])
	round := snapshotArchiveScenarioBucket(0, &meter.round)
	snapshot := ArchiveScenarioSnapshot{
		At: now.Format(time.RFC3339), Active: meter.active, Scenario: meter.scenario,
		Protection: meter.protection, Phase: meter.phase, MissingID: meter.missingID,
		KeyPresent: meter.keyPresent, KeyPTTLMillis: meter.keyPTTLMillis,
		Current: current, Round: round,
		Stable:    snapshotArchiveScenarioBucket(0, &meter.stable),
		Impact:    snapshotArchiveScenarioBucket(0, &meter.impact),
		Recovered: snapshotArchiveScenarioBucket(0, &meter.recovered),
	}
	if !meter.evictedAt.IsZero() {
		snapshot.EvictedAt = meter.evictedAt.Format(time.RFC3339Nano)
	}
	if !meter.rebuiltAt.IsZero() {
		snapshot.RebuiltAt = meter.rebuiltAt.Format(time.RFC3339Nano)
		snapshot.RebuildDurationMS = meter.rebuiltAt.Sub(meter.evictedAt).Milliseconds()
	}
	if !meter.stableAt.IsZero() {
		snapshot.StableAt = meter.stableAt.Format(time.RFC3339Nano)
		snapshot.RecoveryDurationMS = meter.stableAt.Sub(meter.evictedAt).Milliseconds()
	}
	return snapshot
}

func evaluateArchiveScenarioRecoveryLocked(meter *archiveScenarioMeter, now time.Time) {
	if meter.scenario != "cache-breakdown" || meter.rebuiltAt.IsZero() || !meter.stableAt.IsZero() {
		return
	}
	oldestSecond := now.Unix() - archiveScenarioStableSeconds
	if oldestSecond <= meter.rebuiltAt.Unix() {
		return
	}
	for offset := int64(1); offset <= archiveScenarioStableSeconds; offset++ {
		bucket := meter.seconds[now.Unix()-offset]
		if bucket == nil || bucket.Requests == 0 || bucket.RedisMisses > 0 || bucket.MySQLFallbacks > 0 ||
			archiveScenarioHitRate(bucket.PositiveCacheHits, bucket.RedisMisses) < 99 {
			return
		}
	}
	meter.stableAt = now
	meter.phase = "recovered"
	meter.recovered = cloneArchiveScenarioBucket(meter.seconds[now.Unix()-1])
}

func cloneArchiveScenarioBucket(bucket *archiveScenarioBucket) archiveScenarioBucket {
	if bucket == nil {
		return archiveScenarioBucket{}
	}
	clone := *bucket
	clone.latencies = append([]int64(nil), bucket.latencies...)
	return clone
}

func snapshotArchiveScenarioBucket(second int64, bucket *archiveScenarioBucket) ArchiveScenarioCounters {
	if bucket == nil {
		return ArchiveScenarioCounters{Second: second}
	}
	result := bucket.ArchiveScenarioCounters
	result.Second = second
	result.HitRate = archiveScenarioHitRate(result.PositiveCacheHits, result.RedisMisses)
	latencies := append([]int64(nil), bucket.latencies...)
	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	result.P95Latency = percentile(latencies, .95)
	if len(latencies) > 0 {
		result.MaxLatency = latencies[len(latencies)-1]
	}
	return result
}

func archiveScenarioHitRate(hits, misses int64) float64 {
	total := hits + misses
	if total == 0 {
		return 0
	}
	return float64(hits) * 100 / float64(total)
}
