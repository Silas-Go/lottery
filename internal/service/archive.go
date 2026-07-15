package service

import (
	"errors"
	"silas/internal/database"
	"silas/internal/metrics"
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

// ArchiveService 编排《百职录》的两条公平读路径。
// Direct 每次读取 MySQL；Cached 执行标准 Cache-Aside，二者返回同一个领域对象。
type ArchiveService struct {
	store  *database.Store
	fillMu sync.Mutex
}

func NewArchiveService(store *database.Store) *ArchiveService {
	return &ArchiveService{store: store}
}

// List 返回页面的职业目录。它不参与压力实验，避免一次初始化请求污染对比数据。
func (s *ArchiveService) List() ([]database.ProfessionArchive, *AppError) {
	archives, err := s.store.ListProfessionArchives()
	if err != nil {
		return nil, NewAppError(CodeArchiveDBReadFailed, "《百职录》目录暂时无法打开", err)
	}
	return archives, nil
}

// ReadDirect 代表旧规矩：无论同一页刚刚被问过多少次，都重新翻阅 MySQL 真本。
func (s *ArchiveService) ReadDirect(id int) (*database.ProfessionArchive, ArchiveSource, *AppError) {
	start := time.Now()
	metrics.RecordArchiveRequest(metrics.ArchivePathDirect)
	archive, appErr := s.readMySQL(id, metrics.ArchivePathDirect)
	metrics.RecordArchiveLatency(metrics.ArchivePathDirect, time.Since(start), appErr != nil)
	return archive, ArchiveSourceMySQL, appErr
}

// ReadCached 执行 Cache-Aside：先读 Redis，未命中才回源 MySQL 并回填。
// fillMu 只合并本进程同一时刻的冷缓存回源，防止第一波并发把一次 MISS 放大成缓存击穿；
// 多实例生产环境应改用 singleflight/分布式互斥或逻辑过期等专门治理方案。
func (s *ArchiveService) ReadCached(id int) (*database.ProfessionArchive, ArchiveSource, *AppError) {
	start := time.Now()
	metrics.RecordArchiveRequest(metrics.ArchivePathCached)

	archive, hit, cacheErr := database.GetProfessionArchiveCache(id)
	if cacheErr == nil && hit {
		metrics.RecordArchiveCacheHit()
		metrics.RecordArchiveLatency(metrics.ArchivePathCached, time.Since(start), false)
		return archive, ArchiveSourceCacheHit, nil
	}
	if cacheErr != nil {
		// 缓存是性能层，不是正确性依赖。Redis 故障时回源 MySQL，页面用指标展示这次降级。
		metrics.RecordArchiveCacheError()
		archive, appErr := s.readMySQL(id, metrics.ArchivePathCached)
		metrics.RecordArchiveLatency(metrics.ArchivePathCached, time.Since(start), appErr != nil)
		return archive, ArchiveSourceCacheError, appErr
	}

	s.fillMu.Lock()
	defer s.fillMu.Unlock()

	// 双检让等待首个回源请求的并发请求直接读取刚写好的水晶，而不是排队翻真本。
	archive, hit, cacheErr = database.GetProfessionArchiveCache(id)
	if cacheErr == nil && hit {
		metrics.RecordArchiveCacheHit()
		metrics.RecordArchiveCacheCoalesced()
		metrics.RecordArchiveLatency(metrics.ArchivePathCached, time.Since(start), false)
		return archive, ArchiveSourceCacheHit, nil
	}
	if cacheErr != nil {
		metrics.RecordArchiveCacheError()
	}

	metrics.RecordArchiveCacheMiss()
	archive, appErr := s.readMySQL(id, metrics.ArchivePathCached)
	if appErr != nil {
		metrics.RecordArchiveLatency(metrics.ArchivePathCached, time.Since(start), true)
		return nil, ArchiveSourceCacheMiss, appErr
	}
	if err := database.SetProfessionArchiveCache(archive, metrics.ArchiveCacheTTL); err != nil {
		// 回填失败不影响本次正确响应；下一次请求会再次回源，cacheErrors 会暴露退化。
		metrics.RecordArchiveCacheError()
	}
	metrics.RecordArchiveLatency(metrics.ArchivePathCached, time.Since(start), false)
	return archive, ArchiveSourceCacheMiss, nil
}

func (s *ArchiveService) readMySQL(id int, path string) (*database.ProfessionArchive, *AppError) {
	dbStart := time.Now()
	archive, err := s.store.GetProfessionArchive(id)
	inUse, capacity := s.store.DBPoolStats()
	metrics.RecordArchiveDBRead(path, time.Since(dbStart), inUse, capacity)
	if err == nil {
		return archive, nil
	}
	if errors.Is(err, database.ErrProfessionArchiveNotFound) {
		return nil, NewAppError(CodeArchiveNotFound, "《百职录》中没有这一页", err, "archive_id", id)
	}
	return nil, NewAppError(CodeArchiveDBReadFailed, "档案员未能从真本取回这一页", err, "archive_id", id)
}

// ResetChapter 清空第一章 Redis 副本和指标，但不会删除订单或重置库存。
func (s *ArchiveService) ResetChapter() *AppError {
	if err := database.ClearProfessionArchiveCache(); err != nil {
		return NewAppError(CodeArchiveCacheResetFailed, "记忆水晶未能完全清空", err)
	}
	metrics.ResetArchiveRead()
	return nil
}
