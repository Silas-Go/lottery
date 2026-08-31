package service

import (
	"errors"
	"silas/internal/database"
	"silas/internal/metrics"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	ArchiveExperimentCacheBreakdown   = "cache-breakdown"
	ArchiveExperimentCachePenetration = "cache-penetration"
	ArchiveProtectionNone             = "none"
	ArchiveProtectionKeyMutex         = "key-mutex"
	ArchiveProtectionNegativeCache    = "negative-cache"
	ArchiveExperimentMissingID        = 900004
)

const (
	archiveExperimentLease           = 90 * time.Second
	archiveNegativeCacheTTL          = 60 * time.Second
	ArchiveCacheBreakdownOriginDelay = 100 * time.Millisecond
)

type archiveExperimentScope struct {
	Token       string
	Scenario    string
	Protection  string
	OriginDelay time.Duration
	ExpiresAt   time.Time
}

// ArchiveExperimentPrepareRequest 只接受 Runner 生成的任务令牌和有限场景。
// 不存在 ID 固定在服务端，不能把该接口变成任意材料查询器。
type ArchiveExperimentPrepareRequest struct {
	Token      string `json:"token"`
	Scenario   string `json:"scenario"`
	Protection string `json:"protection,omitempty"`
}

type ArchiveExperimentControlRequest struct {
	Token string `json:"token"`
}

type ArchiveExperimentControlState struct {
	Scenario      string `json:"scenario"`
	Protection    string `json:"protection,omitempty"`
	ArchiveID     int    `json:"archiveId,omitempty"`
	MissingID     int    `json:"missingId,omitempty"`
	CacheKey      string `json:"cacheKey,omitempty"`
	KeyPresent    bool   `json:"keyPresent"`
	KeyPTTLMillis int64  `json:"keyPttlMillis"`
	OriginDelayMS int64  `json:"originDelayMs,omitempty"`
	Deleted       bool   `json:"deleted,omitempty"`
	At            string `json:"at"`
}

// PrepareExperiment 建立一轮短租约任务作用域。热点场景会先真实预热，再只清指标；
// 穿透场景清掉固定无效 ID 的负缓存，保证保护前后都从可解释状态起跑。
func (s *ArchiveService) PrepareExperiment(input ArchiveExperimentPrepareRequest) (*ArchiveExperimentControlState, *AppError) {
	input.Token = strings.TrimSpace(input.Token)
	if len(input.Token) < 16 || len(input.Token) > 128 {
		return nil, archiveExperimentInvalid("实验任务令牌无效", nil)
	}
	if input.Scenario != ArchiveExperimentCacheBreakdown && input.Scenario != ArchiveExperimentCachePenetration {
		return nil, archiveExperimentInvalid("缓存实验场景不受支持", nil)
	}
	if input.Scenario == ArchiveExperimentCacheBreakdown {
		if input.Protection != ArchiveProtectionNone && input.Protection != ArchiveProtectionKeyMutex {
			return nil, archiveExperimentInvalid("热点击穿回源保护策略不受支持", nil)
		}
	} else if input.Protection != ArchiveProtectionNone && input.Protection != ArchiveProtectionNegativeCache {
		return nil, archiveExperimentInvalid("缓存穿透保护策略不受支持", nil)
	}

	now := time.Now()
	s.experimentMu.Lock()
	if current := s.experiment; current != nil && now.Before(current.ExpiresAt) && current.Token != input.Token {
		s.experimentMu.Unlock()
		return nil, NewAppError(CodeArchiveExperimentConflict, "已有缓存场景正在运行", nil)
	}
	s.experiment = nil
	s.experimentMu.Unlock()

	if err := database.DeleteMaterialDetailNegativeCache(ArchiveExperimentMissingID); err != nil {
		return nil, archiveExperimentUnavailable("清理任务级负缓存失败", err)
	}
	if err := database.DeleteMaterialDetailCache(ArchiveExperimentMissingID); err != nil {
		return nil, archiveExperimentUnavailable("清理不存在材料的 DTO Key 失败", err)
	}

	state := &ArchiveExperimentControlState{
		Scenario: input.Scenario, Protection: input.Protection,
		ArchiveID: database.StarMarrowMaterialID, MissingID: ArchiveExperimentMissingID,
		At: now.Format(time.RFC3339Nano),
	}
	originDelay := time.Duration(0)
	if input.Scenario == ArchiveExperimentCacheBreakdown {
		originDelay = ArchiveCacheBreakdownOriginDelay
		state.OriginDelayMS = originDelay.Milliseconds()
		state.CacheKey = database.MaterialDetailCacheKey(database.StarMarrowMaterialID)
		if err := database.DeleteMaterialDetailCache(database.StarMarrowMaterialID); err != nil {
			return nil, archiveExperimentUnavailable("清理热点 Key 失败", err)
		}
		metrics.ResetArchiveRead()
		_, _, _, appErr, _ := s.readCached(database.StarMarrowMaterialID)
		if appErr != nil {
			return nil, archiveExperimentUnavailable("预热热点 Key 失败", appErr)
		}
		present, ttl, err := database.MaterialDetailCacheState(database.StarMarrowMaterialID)
		if err != nil || !present {
			if err == nil {
				err = errors.New("hot cache key was not created")
			}
			return nil, archiveExperimentUnavailable("热点 Key 预热后仍不存在", err)
		}
		// 预热是准备动作，不计入任务；保留已经真实写入 Redis 的热 Key。
		metrics.ResetArchiveRead()
		metrics.ResetArchiveScenario(input.Scenario, input.Protection, "stable", 0, true, ttl)
		state.KeyPresent = true
		state.KeyPTTLMillis = ttl.Milliseconds()
	} else {
		state.CacheKey = database.MaterialDetailCacheKey(ArchiveExperimentMissingID)
		phase := "unprotected"
		if input.Protection == ArchiveProtectionNegativeCache {
			phase = "protected"
		}
		metrics.ResetArchiveRead()
		metrics.ResetArchiveScenario(input.Scenario, input.Protection, phase, ArchiveExperimentMissingID, false, 0)
	}

	s.experimentMu.Lock()
	s.experiment = &archiveExperimentScope{
		Token: input.Token, Scenario: input.Scenario, Protection: input.Protection,
		OriginDelay: originDelay,
		ExpiresAt:   time.Now().Add(archiveExperimentLease),
	}
	s.experimentMu.Unlock()
	return state, nil
}

// EvictExperiment 对已预热的星髓 Key 执行一次真实 DEL；Key 不存在时拒绝伪造注入成功。
func (s *ArchiveService) EvictExperiment(token string) (*ArchiveExperimentControlState, *AppError) {
	scope, appErr := s.activeExperiment(token)
	if appErr != nil {
		return nil, appErr
	}
	if scope.Scenario != ArchiveExperimentCacheBreakdown {
		return nil, archiveExperimentInvalid("当前任务不是热点击穿场景", nil)
	}
	present, ttl, err := database.MaterialDetailCacheState(database.StarMarrowMaterialID)
	if err != nil {
		return nil, archiveExperimentUnavailable("读取热点 Key 状态失败", err)
	}
	if !present {
		return nil, archiveExperimentInvalid("热点 Key 已不存在，不能重复注入失效", nil)
	}
	deleted, err := database.DeleteMaterialDetailCacheWithResult(database.StarMarrowMaterialID)
	if err != nil {
		return nil, archiveExperimentUnavailable("删除热点 Key 失败", err)
	}
	if !deleted {
		return nil, archiveExperimentInvalid("热点 Key 未被删除", nil)
	}
	now := time.Now()
	metrics.RecordArchiveScenarioEvicted(now)
	return &ArchiveExperimentControlState{
		Scenario: scope.Scenario, Protection: scope.Protection, ArchiveID: database.StarMarrowMaterialID,
		CacheKey:   database.MaterialDetailCacheKey(database.StarMarrowMaterialID),
		KeyPresent: false, KeyPTTLMillis: ttl.Milliseconds(),
		OriginDelayMS: scope.OriginDelay.Milliseconds(),
		Deleted:       true, At: now.Format(time.RFC3339Nano),
	}, nil
}

// FinishExperiment 幂等关闭任务作用域，并恢复不会污染后续实验的缓存状态。
func (s *ArchiveService) FinishExperiment(token string) (*ArchiveExperimentControlState, *AppError) {
	token = strings.TrimSpace(token)
	s.experimentMu.Lock()
	current := s.experiment
	if current == nil || time.Now().After(current.ExpiresAt) {
		s.experiment = nil
		s.experimentMu.Unlock()
		metrics.DeactivateArchiveScenario()
		_ = database.DeleteMaterialDetailNegativeCache(ArchiveExperimentMissingID)
		return &ArchiveExperimentControlState{At: time.Now().Format(time.RFC3339Nano)}, nil
	}
	if current.Token != token {
		s.experimentMu.Unlock()
		return nil, NewAppError(CodeArchiveExperimentConflict, "实验任务令牌不匹配", nil)
	}
	scope := *current
	s.experiment = nil
	s.experimentMu.Unlock()
	defer metrics.DeactivateArchiveScenario()

	if err := database.DeleteMaterialDetailNegativeCache(ArchiveExperimentMissingID); err != nil {
		return nil, archiveExperimentUnavailable("清理任务级负缓存失败", err)
	}
	state := &ArchiveExperimentControlState{
		Scenario: scope.Scenario, Protection: scope.Protection,
		ArchiveID: database.StarMarrowMaterialID, MissingID: ArchiveExperimentMissingID,
		OriginDelayMS: scope.OriginDelay.Milliseconds(),
		At:            time.Now().Format(time.RFC3339Nano),
	}
	if scope.Scenario == ArchiveExperimentCacheBreakdown {
		state.CacheKey = database.MaterialDetailCacheKey(database.StarMarrowMaterialID)
		present, ttl, err := database.MaterialDetailCacheState(database.StarMarrowMaterialID)
		if err != nil {
			return nil, archiveExperimentUnavailable("检查热点 Key 恢复状态失败", err)
		}
		if !present {
			_, _, _, appErr, _ := s.readCached(database.StarMarrowMaterialID)
			if appErr != nil {
				return nil, archiveExperimentUnavailable("恢复热点 Key 失败", appErr)
			}
			present, ttl, err = database.MaterialDetailCacheState(database.StarMarrowMaterialID)
			if err != nil || !present {
				return nil, archiveExperimentUnavailable("热点 Key 未恢复", err)
			}
		}
		state.KeyPresent = present
		state.KeyPTTLMillis = ttl.Milliseconds()
	}
	return state, nil
}

// ReadExperiment 只接受当前短租约令牌；正常公开查询接口完全不读取该状态。
func (s *ArchiveService) ReadExperiment(token string) (*database.MaterialDetailDTO, ArchiveSource, int, *AppError) {
	scope, appErr := s.activeExperiment(token)
	if appErr != nil {
		return nil, ArchiveSourceCacheMiss, 0, appErr
	}
	if scope.Scenario == ArchiveExperimentCacheBreakdown {
		return s.readBreakdownExperiment(scope.Protection, scope.OriginDelay)
	}
	return s.readPenetrationExperiment(scope.Protection)
}

func (s *ArchiveService) readBreakdownExperiment(protection string, originDelay time.Duration) (*database.MaterialDetailDTO, ArchiveSource, int, *AppError) {
	started := time.Now()
	var archive *database.MaterialDetailDTO
	var source ArchiveSource
	var queries int
	var appErr *AppError
	var trace archiveCacheTrace
	if protection == ArchiveProtectionKeyMutex {
		archive, source, queries, appErr, trace = s.readCachedWithOriginDelay(database.StarMarrowMaterialID, originDelay)
	} else {
		archive, source, queries, appErr, trace = s.readCachedUnprotected(database.StarMarrowMaterialID, originDelay)
	}
	sample := metrics.ArchiveScenarioSample{
		PositiveCacheHit: trace.InitialHit, RedisMiss: trace.InitialMiss,
		Coalesced: trace.Coalesced, MySQLFallback: trace.MySQLFallback,
		SQLQueries: trace.SQLQueries, CacheRebuilt: trace.CacheRebuilt,
		Failed:   appErr != nil || trace.CacheRebuildFailed || trace.CacheError,
		Duration: time.Since(started),
	}
	if trace.CacheRebuilt {
		if present, ttl, err := database.MaterialDetailCacheState(database.StarMarrowMaterialID); err == nil && present {
			sample.KeyPTTLMillis = ttl.Milliseconds()
		}
	}
	metrics.RecordArchiveScenarioSample(sample)
	return archive, source, queries, appErr
}

func (s *ArchiveService) readPenetrationExperiment(protection string) (*database.MaterialDetailDTO, ArchiveSource, int, *AppError) {
	started := time.Now()
	sample := metrics.ArchiveScenarioSample{Nonexistent: true}
	record := func(sample metrics.ArchiveScenarioSample) {
		sample.Duration = time.Since(started)
		metrics.RecordArchiveScenarioSample(sample)
	}

	// 两轮都先做同一个正常 DTO Key 查询；保护开启后再检查独立的负缓存 Key。
	if _, hit, err := database.GetMaterialDetailCache(ArchiveExperimentMissingID); err != nil {
		sample.Failed = true
		record(sample)
		return nil, ArchiveSourceCacheError, 0, archiveExperimentUnavailable("读取 Redis 失败", err)
	} else if hit {
		sample.Failed = true
		record(sample)
		return nil, ArchiveSourceCacheError, 0, archiveExperimentUnavailable("不存在材料意外命中正常 DTO", nil)
	}
	// 正常 DTO Key 的第一次查询已经真实 MISS；即使随后命中独立负缓存，
	// 也必须同时保留这次 MISS，并把负缓存命中单列，不能伪装成正常缓存 HIT。
	sample.RedisMiss = true

	if protection == ArchiveProtectionNegativeCache {
		negativeHit, err := database.GetMaterialDetailNegativeCache(ArchiveExperimentMissingID)
		if err != nil {
			sample.Failed = true
			record(sample)
			return nil, ArchiveSourceCacheError, 0, archiveExperimentUnavailable("读取负缓存失败", err)
		}
		if negativeHit {
			sample.NegativeCacheHit = true
			sample.ExpectedNotFound = true
			record(sample)
			return nil, ArchiveSourceNegativeCacheHit, 0, archiveNotFoundExperimentError()
		}
	}
	if protection != ArchiveProtectionNegativeCache {
		return s.queryMissingMaterial(sample, record, false)
	}

	lockValue, _ := s.fillMu.LoadOrStore(strconv.Itoa(ArchiveExperimentMissingID), &sync.Mutex{})
	fillLock := lockValue.(*sync.Mutex)
	fillLock.Lock()
	defer fillLock.Unlock()
	negativeHit, err := database.GetMaterialDetailNegativeCache(ArchiveExperimentMissingID)
	if err != nil {
		sample.Failed = true
		record(sample)
		return nil, ArchiveSourceCacheError, 0, archiveExperimentUnavailable("二次读取负缓存失败", err)
	}
	if negativeHit {
		sample.Coalesced = true
		sample.NegativeCacheHit = true
		sample.ExpectedNotFound = true
		record(sample)
		return nil, ArchiveSourceNegativeCacheHit, 0, archiveNotFoundExperimentError()
	}
	return s.queryMissingMaterial(sample, record, true)
}

func (s *ArchiveService) queryMissingMaterial(
	sample metrics.ArchiveScenarioSample,
	record func(metrics.ArchiveScenarioSample),
	writeNegative bool,
) (*database.MaterialDetailDTO, ArchiveSource, int, *AppError) {
	archive, queries, err := s.store.GetMaterialDetail(ArchiveExperimentMissingID)
	sample.MySQLFallback = true
	sample.SQLQueries = queries
	if errors.Is(err, database.ErrMaterialArchiveNotFound) {
		sample.InvalidMySQLQuery = true
		sample.ExpectedNotFound = true
		if writeNegative {
			if cacheErr := database.SetMaterialDetailNegativeCache(ArchiveExperimentMissingID, archiveNegativeCacheTTL); cacheErr != nil {
				sample.Failed = true
			} else {
				sample.NegativeCacheWrite = true
			}
		}
		record(sample)
		return nil, ArchiveSourceCacheMiss, queries, archiveNotFoundExperimentError()
	}
	if err != nil {
		sample.Failed = true
		record(sample)
		return nil, ArchiveSourceCacheMiss, queries, archiveExperimentUnavailable("不存在材料查询失败", err)
	}
	sample.Failed = true
	record(sample)
	return archive, ArchiveSourceCacheError, queries, archiveExperimentUnavailable("固定不存在材料已出现在业务目录", nil)
}

func (s *ArchiveService) activeExperiment(token string) (archiveExperimentScope, *AppError) {
	s.experimentMu.RLock()
	defer s.experimentMu.RUnlock()
	if s.experiment == nil || time.Now().After(s.experiment.ExpiresAt) {
		return archiveExperimentScope{}, NewAppError(CodeArchiveExperimentConflict, "缓存实验任务未激活或已经过期", nil)
	}
	if strings.TrimSpace(token) == "" || s.experiment.Token != strings.TrimSpace(token) {
		return archiveExperimentScope{}, NewAppError(CodeArchiveExperimentConflict, "缓存实验任务令牌不匹配", nil)
	}
	return *s.experiment, nil
}

func archiveNotFoundExperimentError() *AppError {
	return NewAppError(CodeArchiveNotFound, "材料档案中没有这一页", database.ErrMaterialArchiveNotFound,
		"archive_id", ArchiveExperimentMissingID)
}

func archiveExperimentInvalid(message string, err error) *AppError {
	return NewAppError(CodeArchiveExperimentInvalid, message, err)
}

func archiveExperimentUnavailable(message string, err error) *AppError {
	return NewAppError(CodeArchiveExperimentUnavailable, message, err)
}
