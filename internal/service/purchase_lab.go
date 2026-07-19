package service

import (
	"errors"
	"fmt"
	"silas/internal/database"
	"sync"
	"time"
)

// PurchaseStrategy 是购买实验允许比较的两种 Cache-Aside 写顺序。
type PurchaseStrategy string

const (
	PurchaseDeleteThenUpdate PurchaseStrategy = "delete-then-update"
	PurchaseUpdateThenDelete PurchaseStrategy = "update-then-delete"
)

// PurchaseTraceStep 是服务端真实执行完成后返回的不可变步骤证据。
// 前端只回放这些步骤，不根据所选方案伪造路径或延迟。
type PurchaseTraceStep struct {
	Sequence    int     `json:"sequence"`
	Actor       string  `json:"actor"`
	Action      string  `json:"action"`
	Label       string  `json:"label"`
	Detail      string  `json:"detail"`
	Target      string  `json:"target"`
	DurationMs  float64 `json:"durationMs"`
	AtMs        float64 `json:"atMs"`
	MySQLStock  int     `json:"mysqlStock"`
	RedisStock  *int    `json:"redisStock"`
	ResponseQty *int    `json:"responseStock,omitempty"`
}

// PurchaseLabRun 是一次真实购买顺序实验的冻结结果。
type PurchaseLabRun struct {
	RunID              string              `json:"runId"`
	MaterialID         int                 `json:"materialId"`
	Strategy           PurchaseStrategy    `json:"strategy"`
	ConcurrentQuery    bool                `json:"concurrentQuery"`
	InitialStock       int                 `json:"initialStock"`
	FinalMySQLStock    int                 `json:"finalMySQLStock"`
	FinalRedisStock    *int                `json:"finalRedisStock"`
	PurchaseSuccess    bool                `json:"purchaseSuccess"`
	DirtyCache         bool                `json:"dirtyCache"`
	StaleQueryResponse bool                `json:"staleQueryResponse"`
	QueryResponseStock *int                `json:"queryResponseStock"`
	DBReads            int                 `json:"dbReads"`
	RedisHits          int                 `json:"redisHits"`
	RedisMisses        int                 `json:"redisMisses"`
	LatencyMs          float64             `json:"latencyMs"`
	ExecutedAt         time.Time           `json:"executedAt"`
	Trace              []PurchaseTraceStep `json:"trace"`
}

// PurchaseLabService 编排独立材料夹具上的 T1/T2 受控竞态。
// 互斥锁保证同一进程一次只运行一轮，避免两个演示互相污染；它不是生产购买并发方案。
type PurchaseLabService struct {
	store *database.Store
	mu    sync.Mutex
}

func NewPurchaseLabService(store *database.Store) *PurchaseLabService {
	return &PurchaseLabService{store: store}
}

// State 返回当前真实夹具状态，不会重置或扣减库存。
func (s *PurchaseLabService) State(materialID int) (*database.PurchaseLabState, *AppError) {
	state, err := s.store.InspectPurchaseLabState(materialID)
	if err != nil {
		return nil, purchaseLabError("读取购买实验状态失败", materialID, err)
	}
	return state, nil
}

// Reset 只恢复当前材料购买夹具，不删除前端已冻结的历史结果。
func (s *PurchaseLabService) Reset(materialID int) (*database.PurchaseLabState, *AppError) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.store.ResetPurchaseLabMaterial(materialID)
	if err != nil {
		return nil, purchaseLabError("重置购买实验失败", materialID, err)
	}
	return state, nil
}

// Run 从固定热缓存基线执行一轮真实写顺序实验。
// T2 通过 channel 被精确插入竞态窗口；前端收到的是执行后的 trace，动画只负责解释。
func (s *PurchaseLabService) Run(materialID int, strategy PurchaseStrategy, concurrentQuery bool) (*PurchaseLabRun, *AppError) {
	if strategy != PurchaseDeleteThenUpdate && strategy != PurchaseUpdateThenDelete {
		return nil, NewAppError(CodePurchaseLabInvalidStrategy, "购买实验方案无效", nil, "material_id", materialID, "strategy", strategy)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	baseline, err := s.store.ResetPurchaseLabMaterial(materialID)
	if err != nil {
		return nil, purchaseLabError("准备购买实验基线失败", materialID, err)
	}

	started := time.Now()
	recorder := newPurchaseTraceRecorder(started)
	stats := purchaseRunStats{}
	if strategy == PurchaseDeleteThenUpdate {
		err = s.runDeleteThenUpdate(materialID, baseline.InitialStock, concurrentQuery, recorder, &stats)
	} else {
		err = s.runUpdateThenDelete(materialID, baseline.InitialStock, concurrentQuery, recorder, &stats)
	}
	if err != nil {
		return nil, purchaseLabError("购买顺序实验执行失败", materialID, err)
	}

	finalState, err := s.store.InspectPurchaseLabState(materialID)
	if err != nil {
		return nil, purchaseLabError("购买实验结果校验失败", materialID, err)
	}
	dirty := finalState.RedisStock != nil && *finalState.RedisStock != finalState.MySQLStock
	staleResponse := stats.queryResponseStock != nil && *stats.queryResponseStock != finalState.MySQLStock
	finished := time.Now()

	return &PurchaseLabRun{
		RunID:      fmt.Sprintf("purchase-%d-%d", materialID, finished.UnixNano()),
		MaterialID: materialID, Strategy: strategy, ConcurrentQuery: concurrentQuery,
		InitialStock: baseline.InitialStock, FinalMySQLStock: finalState.MySQLStock,
		FinalRedisStock: finalState.RedisStock, PurchaseSuccess: stats.purchaseSuccess,
		DirtyCache: dirty, StaleQueryResponse: staleResponse,
		QueryResponseStock: stats.queryResponseStock, DBReads: stats.dbReads,
		RedisHits: stats.redisHits, RedisMisses: stats.redisMisses,
		LatencyMs: durationMilliseconds(finished.Sub(started)), ExecutedAt: finished,
		Trace: recorder.steps,
	}, nil
}

type purchaseRunStats struct {
	purchaseSuccess    bool
	dbReads            int
	redisHits          int
	redisMisses        int
	queryResponseStock *int
}

type purchaseQueryPhase struct {
	stock int
	err   error
}

func (s *PurchaseLabService) runDeleteThenUpdate(materialID, initialStock int, concurrent bool, recorder *purchaseTraceRecorder, stats *purchaseRunStats) error {
	started := time.Now()
	if err := database.DeletePurchaseLabCache(materialID); err != nil {
		return err
	}
	recorder.add("t1", "delete_cache", "DELETE CACHE", "先删除 Redis 库存副本", "redis", time.Since(started), initialStock, nil, nil)

	if !concurrent {
		return s.deductAndRecord(materialID, initialStock, nil, recorder, stats)
	}

	readReady := make(chan purchaseQueryPhase, 1)
	resumeRefill := make(chan struct{})
	queryDone := make(chan error, 1)
	go func() {
		cacheStarted := time.Now()
		_, hit, err := database.GetPurchaseLabCacheStock(materialID)
		if err != nil {
			readReady <- purchaseQueryPhase{err: err}
			queryDone <- err
			return
		}
		if hit {
			err = errors.New("delete-first race expected Redis MISS, got HIT")
			readReady <- purchaseQueryPhase{err: err}
			queryDone <- err
			return
		}
		recorder.add("t2", "query_cache", "CACHE MISS", "并发查询在删除后进入 Redis", "redis", time.Since(cacheStarted), initialStock, nil, nil)

		dbStarted := time.Now()
		oldStock, err := s.store.ReadPurchaseLabStock(materialID)
		if err != nil {
			readReady <- purchaseQueryPhase{err: err}
			queryDone <- err
			return
		}
		recorder.add("t2", "read_mysql", "DB READ · OLD VALUE", "T2 在 T1 更新前读到旧库存", "mysql", time.Since(dbStarted), oldStock, nil, nil)
		readReady <- purchaseQueryPhase{stock: oldStock}
		<-resumeRefill

		refillStarted := time.Now()
		if err := database.SetPurchaseLabCacheStock(materialID, oldStock); err != nil {
			queryDone <- err
			return
		}
		redisStock := oldStock
		mysqlStock := initialStock - 1
		recorder.add("t2", "refill_cache", "CACHE REFILL · OLD VALUE", "T2 把刚读取的旧值回填 Redis", "redis", time.Since(refillStarted), mysqlStock, &redisStock, nil)
		responseStock := oldStock
		recorder.add("t2", "return_query", "RETURN T2", "查询返回旧库存，缓存也保留旧值", "client", 0, mysqlStock, &redisStock, &responseStock)
		queryDone <- nil
	}()

	phase := <-readReady
	if phase.err != nil {
		return phase.err
	}
	stats.redisMisses = 1
	stats.dbReads = 1
	responseStock := phase.stock
	stats.queryResponseStock = &responseStock
	if err := s.deductAndRecord(materialID, initialStock, nil, recorder, stats); err != nil {
		close(resumeRefill)
		<-queryDone
		return err
	}
	close(resumeRefill)
	return <-queryDone
}

func (s *PurchaseLabService) runUpdateThenDelete(materialID, initialStock int, concurrent bool, recorder *purchaseTraceRecorder, stats *purchaseRunStats) error {
	redisStock := initialStock
	if err := s.deductAndRecord(materialID, initialStock, &redisStock, recorder, stats); err != nil {
		return err
	}
	mysqlStock := initialStock - 1

	if concurrent {
		lookupDone := make(chan purchaseQueryPhase, 1)
		resumeResponse := make(chan struct{})
		queryDone := make(chan struct{})
		go func() {
			started := time.Now()
			stock, hit, err := database.GetPurchaseLabCacheStock(materialID)
			if err != nil || !hit || stock == nil {
				if err == nil {
					err = errors.New("update-first race expected Redis HIT, got MISS")
				}
				lookupDone <- purchaseQueryPhase{err: err}
				close(queryDone)
				return
			}
			cached := *stock
			recorder.add("t2", "query_cache", "CACHE HIT · OLD VALUE", "T2 在缓存删除前命中旧库存", "redis", time.Since(started), mysqlStock, &cached, nil)
			lookupDone <- purchaseQueryPhase{stock: cached}
			<-resumeResponse
			responseStock := cached
			recorder.add("t2", "return_query", "RETURN T2", "这一次查询可能返回旧值，但旧缓存已被删除", "client", 0, mysqlStock, nil, &responseStock)
			close(queryDone)
		}()

		phase := <-lookupDone
		if phase.err != nil {
			return phase.err
		}
		stats.redisHits = 1
		responseStock := phase.stock
		stats.queryResponseStock = &responseStock
		started := time.Now()
		if err := database.DeletePurchaseLabCache(materialID); err != nil {
			close(resumeResponse)
			<-queryDone
			return err
		}
		recorder.add("t1", "delete_cache", "DELETE CACHE", "数据库更新完成后删除 Redis 旧副本", "redis", time.Since(started), mysqlStock, nil, nil)
		close(resumeResponse)
		<-queryDone
	} else {
		started := time.Now()
		if err := database.DeletePurchaseLabCache(materialID); err != nil {
			return err
		}
		recorder.add("t1", "delete_cache", "DELETE CACHE", "数据库更新完成后删除 Redis 旧副本", "redis", time.Since(started), mysqlStock, nil, nil)
	}

	recorder.add("t1", "return_purchase", "RETURN T1", "购买库存写入完成；后续读取将从 MySQL 重建缓存", "client", 0, mysqlStock, nil, nil)
	return nil
}

func (s *PurchaseLabService) deductAndRecord(materialID, initialStock int, redisStock *int, recorder *purchaseTraceRecorder, stats *purchaseRunStats) error {
	started := time.Now()
	ok, err := s.store.DeductPurchaseLabStock(materialID)
	if err != nil {
		return err
	}
	stats.purchaseSuccess = ok
	newStock := initialStock
	if ok {
		newStock--
	}
	recorder.add("t1", "update_mysql", "UPDATE MYSQL", "MySQL 条件扣减权威库存", "mysql", time.Since(started), newStock, redisStock, nil)
	if !ok {
		return NewAppError(CodePurchaseLabSoldOut, "购买实验库存不足", nil, "material_id", materialID)
	}
	if redisStock == nil {
		recorder.add("t1", "return_purchase", "T1 WRITE ACCEPTED", "MySQL 已完成真实库存更新", "client", 0, newStock, nil, nil)
	}
	return nil
}

type purchaseTraceRecorder struct {
	mu      sync.Mutex
	started time.Time
	steps   []PurchaseTraceStep
}

func newPurchaseTraceRecorder(started time.Time) *purchaseTraceRecorder {
	return &purchaseTraceRecorder{started: started, steps: make([]PurchaseTraceStep, 0, 8)}
}

func (r *purchaseTraceRecorder) add(actor, action, label, detail, target string, duration time.Duration, mysqlStock int, redisStock, responseStock *int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.steps = append(r.steps, PurchaseTraceStep{
		Sequence: len(r.steps) + 1, Actor: actor, Action: action, Label: label,
		Detail: detail, Target: target, DurationMs: durationMilliseconds(duration),
		AtMs: durationMilliseconds(time.Since(r.started)), MySQLStock: mysqlStock,
		RedisStock: cloneInt(redisStock), ResponseQty: cloneInt(responseStock),
	})
}

func cloneInt(value *int) *int {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func durationMilliseconds(duration time.Duration) float64 {
	return float64(duration.Microseconds()) / 1000
}

func purchaseLabError(message string, materialID int, err error) *AppError {
	if errors.Is(err, database.ErrPurchaseLabMaterialNotFound) {
		return NewAppError(CodePurchaseLabMaterialNotFound, "购买实验中没有这个材料", err, "material_id", materialID)
	}
	if appErr, ok := err.(*AppError); ok {
		return appErr
	}
	return NewAppError(CodePurchaseLabUnavailable, message, err, "material_id", materialID)
}
