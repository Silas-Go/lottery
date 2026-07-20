package service

import (
	"errors"
	"silas/internal/database"
	"silas/internal/metrics"
	"strconv"
	"sync"
	"time"
)

// ArchiveSource 描述这一页最终由谁回答，用响应头展示 HIT/MISS/BYPASS。
type ArchiveSource string

const (
	ArchiveSourceMySQL      ArchiveSource = "mysql"
	ArchiveSourceCacheHit   ArchiveSource = "redis-hit"
	ArchiveSourceCacheMiss  ArchiveSource = "redis-miss"
	ArchiveSourceCacheError ArchiveSource = "redis-fallback"
)

// ArchiveService 编排材料聚合详情的两条公平读路径。
// Direct 每次用四条 SQL 组装 DTO；Cached 执行标准 Cache-Aside，二者返回完全相同的最终 DTO。
type ArchiveService struct {
	store  *database.Store
	fillMu sync.Map
}

func NewArchiveService(store *database.Store) *ArchiveService {
	return &ArchiveService{store: store}
}

// List 返回市场基础列表。它不参与聚合详情压力实验，避免初始化请求污染对比数据。
func (s *ArchiveService) List() ([]database.MaterialSummaryDTO, *AppError) {
	archives, err := s.store.ListMaterialSummaries()
	if err != nil {
		return nil, NewAppError(CodeArchiveDBReadFailed, "《百职录》目录暂时无法打开", err)
	}
	return archives, nil
}

// ReadDirect 代表旧规矩：每次都重新 JOIN 基础资料并聚合组成、交易和评分事实。
func (s *ArchiveService) ReadDirect(id int) (*database.MaterialDetailDTO, ArchiveSource, int, *AppError) {
	start := time.Now()
	metrics.RecordArchiveRequest(metrics.ArchivePathDirect)
	archive, queries, appErr := s.readMySQL(id, metrics.ArchivePathDirect)
	metrics.RecordArchiveLatency(metrics.ArchivePathDirect, time.Since(start), appErr != nil)
	return archive, ArchiveSourceMySQL, queries, appErr
}

// ReadCached 执行 Cache-Aside：先读 Redis，未命中才回源 MySQL 并回填。
// fillMu 只合并本进程同一时刻的冷缓存回源，防止第一波并发把一次 MISS 放大成缓存击穿；
// 多实例生产环境应改用 singleflight/分布式互斥或逻辑过期等专门治理方案。
func (s *ArchiveService) ReadCached(id int) (*database.MaterialDetailDTO, ArchiveSource, int, *AppError) {
	start := time.Now()
	metrics.RecordArchiveRequest(metrics.ArchivePathCached)

	archive, hit, cacheErr := database.GetMaterialDetailCache(id)
	if cacheErr == nil && hit {
		metrics.RecordArchiveCacheHit()
		metrics.RecordArchiveLatency(metrics.ArchivePathCached, time.Since(start), false)
		return archive, ArchiveSourceCacheHit, 0, nil
	}
	if cacheErr != nil {
		// 缓存是性能层，不是正确性依赖。Redis 故障时回源 MySQL，页面用指标展示这次降级。
		metrics.RecordArchiveCacheError()
		archive, queries, appErr := s.readMySQL(id, metrics.ArchivePathCached)
		metrics.RecordArchiveLatency(metrics.ArchivePathCached, time.Since(start), appErr != nil)
		return archive, ArchiveSourceCacheError, queries, appErr
	}

	// 每个材料使用独立冷缓存锁：同一材料的首波请求合并回源，不同材料之间不会互相阻塞。
	lockValue, _ := s.fillMu.LoadOrStore(strconv.Itoa(id), &sync.Mutex{})
	fillLock := lockValue.(*sync.Mutex)
	fillLock.Lock()
	defer fillLock.Unlock()

	// 双检让等待首个回源请求的并发请求直接读取刚写好的水晶，而不是排队翻真本。
	archive, hit, cacheErr = database.GetMaterialDetailCache(id)
	if cacheErr == nil && hit {
		metrics.RecordArchiveCacheHit()
		metrics.RecordArchiveCacheCoalesced()
		metrics.RecordArchiveLatency(metrics.ArchivePathCached, time.Since(start), false)
		return archive, ArchiveSourceCacheHit, 0, nil
	}
	if cacheErr != nil {
		metrics.RecordArchiveCacheError()
	}

	metrics.RecordArchiveCacheMiss()
	archive, queries, appErr := s.readMySQL(id, metrics.ArchivePathCached)
	if appErr != nil {
		metrics.RecordArchiveLatency(metrics.ArchivePathCached, time.Since(start), true)
		return nil, ArchiveSourceCacheMiss, queries, appErr
	}
	if err := database.SetMaterialDetailCache(archive, metrics.ArchiveCacheTTL); err != nil {
		// 回填失败不影响本次正确响应；下一次请求会再次回源，cacheErrors 会暴露退化。
		metrics.RecordArchiveCacheError()
	}
	metrics.RecordArchiveLatency(metrics.ArchivePathCached, time.Since(start), false)
	return archive, ArchiveSourceCacheMiss, queries, nil
}

func (s *ArchiveService) readMySQL(id int, path string) (*database.MaterialDetailDTO, int, *AppError) {
	dbStart := time.Now()
	archive, queries, err := s.store.GetMaterialDetail(id)
	inUse, capacity := s.store.DBPoolStats()
	metrics.RecordArchiveSQLQueries(path, time.Since(dbStart), queries, inUse, capacity)
	if err == nil {
		return archive, queries, nil
	}
	if errors.Is(err, database.ErrMaterialArchiveNotFound) {
		return nil, queries, NewAppError(CodeArchiveNotFound, "材料档案中没有这一页", err, "archive_id", id)
	}
	return nil, queries, NewAppError(CodeArchiveDBReadFailed, "未能从 MySQL 组装材料详情", err, "archive_id", id)
}

// ResetChapter 清空第一章 Redis 副本和指标，但不会删除订单或重置库存。
func (s *ArchiveService) ResetChapter() *AppError {
	if err := database.ClearMaterialDetailCache(); err != nil {
		return NewAppError(CodeArchiveCacheResetFailed, "记忆水晶未能完全清空", err)
	}
	metrics.ResetArchiveRead()
	return nil
}
