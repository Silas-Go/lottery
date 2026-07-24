package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"silas/internal/database"
	"silas/internal/metrics"
	"silas/internal/mq"
	"sort"
	"sync"
	"time"
)

const (
	PurchaseSyncInvalidate     PurchaseStrategy = "sync-invalidate"
	PurchaseOutboxMQInvalidate PurchaseStrategy = "outbox-mq-invalidate"

	PurchaseRunRunning         = "running"
	PurchaseRunWaitingOutbox   = "waiting_outbox"
	PurchaseRunWaitingConsumer = "waiting_consumer"
	PurchaseRunCompleted       = "completed"
	PurchaseRunFailed          = "failed"

	maxPurchaseBatch = 150
	maxQueryBatch    = 20
)

var purchaseRequestIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{7,95}$`)

// PurchaseStrategy 是真实购买实验允许的缓存失效方案标识。
type PurchaseStrategy string

// PurchaseTraceStep 是服务端真实动作形成的不可变步骤证据。
// 前端只回放这些步骤，不根据所选方案伪造执行路径或延迟。
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

// PurchaseLabService 编排共享 materials.stock 与材料 DTO 缓存上的真实购买实验。
// mu 串行化实验批次，runMu 只保护内存中的运行快照；订单与 Outbox 的最终证据仍以 MySQL 为准。
type PurchaseLabService struct {
	store      *database.Store
	archive    *ArchiveService
	mu         sync.Mutex
	runMu      sync.RWMutex
	runs       map[string]*PurchaseExperimentRun
	workerWake chan struct{}
}

func NewPurchaseLabService(store *database.Store, archives ...*ArchiveService) *PurchaseLabService {
	var archive *ArchiveService
	if len(archives) > 0 {
		archive = archives[0]
	}
	if archive == nil {
		archive = NewArchiveService(store)
	}
	return &PurchaseLabService{
		store: store, archive: archive,
		runs:       make(map[string]*PurchaseExperimentRun),
		workerWake: make(chan struct{}, 1),
	}
}

// PurchaseExperimentRequest 是主购买实验允许的白名单输入。
// purchaseCount 最大 150，用于固定购买者场景；queryCount 只保留兼容性，主页面改由 20 QPS
// 的真实 Cached 探针采样。接口仍不接受任意 URL、脚本、Topic 或命令。
type PurchaseExperimentRequest struct {
	RequestID     string           `json:"requestId"`
	Strategy      PurchaseStrategy `json:"strategy"`
	PurchaseCount int              `json:"purchaseCount"`
	QueryCount    int              `json:"queryCount"`
}

type PurchaseQuerySample struct {
	Source             ArchiveSource `json:"source"`
	Stock              int           `json:"stock"`
	AuthoritativeStock int           `json:"authoritativeStock"`
	LatencyMS          float64       `json:"latencyMs"`
	Old                bool          `json:"old"`
}

type PurchaseOutboxView struct {
	EventID       string     `json:"eventId"`
	Status        string     `json:"status"`
	RetryCount    int        `json:"retryCount"`
	LastError     string     `json:"lastError,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
	PublishedAt   *time.Time `json:"publishedAt,omitempty"`
	InvalidatedAt *time.Time `json:"invalidatedAt,omitempty"`
}

// PurchaseExperimentRun 是主实验的真实执行和异步失效状态。
type PurchaseExperimentRun struct {
	RequestID                  string                `json:"requestId"`
	MaterialID                 int                   `json:"materialId"`
	Strategy                   PurchaseStrategy      `json:"strategy"`
	Status                     string                `json:"status"`
	InitialStock               int                   `json:"initialStock"`
	FinalMySQLStock            int                   `json:"finalMySQLStock"`
	FinalRedisStock            *int                  `json:"finalRedisStock"`
	PurchaseRequested          int                   `json:"purchaseRequested"`
	PurchaseSucceeded          int                   `json:"purchaseSucceeded"`
	DuplicateRequests          int                   `json:"duplicateRequests"`
	SoldOutRequests            int                   `json:"soldOutRequests"`
	QueryRequested             int                   `json:"queryRequested"`
	QueryCompleted             int                   `json:"queryCompleted"`
	OldReadCount               int                   `json:"oldReadCount"`
	PurchaseLatencyMS          float64               `json:"purchaseLatencyMs"`
	PurchaseP99MS              float64               `json:"purchaseP99Ms"`
	CacheInvalidationLatencyMS float64               `json:"cacheInvalidationLatencyMs"`
	OutboxStatus               string                `json:"outboxStatus"`
	MQStatus                   string                `json:"mqStatus"`
	RetryCount                 int                   `json:"retryCount"`
	ErrorMessage               string                `json:"errorMessage,omitempty"`
	ExecutedAt                 time.Time             `json:"executedAt"`
	Trace                      []PurchaseTraceStep   `json:"trace"`
	QuerySamples               []PurchaseQuerySample `json:"querySamples"`
	Outbox                     []PurchaseOutboxView  `json:"outbox"`
}

type purchaseQueryBatchResult struct {
	samples []PurchaseQuerySample
	err     error
}

type purchaseExecutionResult struct {
	childRequestID      string
	commit              *database.PurchaseCommitResult
	transactionElapsed  time.Duration
	requestLatency      time.Duration
	invalidationElapsed time.Duration
	err                 error
	invalidationErr     error
}

// State 返回主实验共享的 materials.stock 与材料详情 DTO 缓存状态。
func (s *PurchaseLabService) State(materialID int) (*database.PurchaseExperimentState, *AppError) {
	state, err := s.store.InspectPurchaseExperimentState(materialID)
	if err != nil {
		return nil, purchaseLabError("读取购买实验共享库存失败", materialID, err)
	}
	return state, nil
}

// Reset 将 materials.stock 恢复到固定目录基线，并重新组装、预热同一个材料 DTO key。
func (s *PurchaseLabService) Reset(materialID int) (*database.PurchaseExperimentState, *AppError) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.store.ResetPurchaseExperimentMaterial(materialID); err != nil {
		return nil, purchaseLabError("重置购买实验权威库存失败", materialID, err)
	}
	detail, _, err := s.store.GetMaterialDetail(materialID)
	if err != nil {
		return nil, purchaseLabError("重置后重建材料详情失败", materialID, err)
	}
	if err := database.SetMaterialDetailCache(detail, metrics.ArchiveCacheTTL); err != nil {
		return nil, purchaseLabError("重置后预热材料缓存失败", materialID, err)
	}
	return s.State(materialID)
}

// RunExperiment 并发释放最多 150 个真实购买，并让可选查询样本与缓存失效窗口竞争。
// 每个购买请求使用独立 request_id；重复提交同一批次不会再次扣库存。
func (s *PurchaseLabService) RunExperiment(
	ctx context.Context,
	materialID int,
	request PurchaseExperimentRequest,
) (*PurchaseExperimentRun, *AppError) {
	if appErr := validatePurchaseExperimentRequest(materialID, request); appErr != nil {
		return nil, appErr
	}
	if request.Strategy == PurchaseOutboxMQInvalidate && !mq.Enabled() {
		return nil, NewAppError(CodePurchaseLabUnavailable,
			"RocketMQ 未启用，无法运行 Outbox 异步失效方案", nil,
			"material_id", materialID, "strategy", request.Strategy)
	}
	// 一轮实验会重置/观察同一份共享库存和缓存；串行化主实验，避免两个页面的
	// 批次互相污染结果。实验内部的查询样本仍会与购买和失效真实并发。
	s.mu.Lock()
	defer s.mu.Unlock()
	baseline, appErr := s.State(materialID)
	if appErr != nil {
		return nil, appErr
	}

	started := time.Now()
	recorder := newPurchaseTraceRecorder(started)
	run := &PurchaseExperimentRun{
		RequestID: request.RequestID, MaterialID: materialID, Strategy: request.Strategy,
		Status: PurchaseRunRunning, InitialStock: baseline.MySQLStock,
		FinalMySQLStock: baseline.MySQLStock, FinalRedisStock: cloneInt(baseline.RedisStock),
		PurchaseRequested: request.PurchaseCount, QueryRequested: request.QueryCount,
		OutboxStatus: "not-used", MQStatus: "not-used", ExecutedAt: started,
		QuerySamples: make([]PurchaseQuerySample, 0, request.QueryCount),
	}

	startGate := make(chan struct{})
	queryResult := make(chan purchaseQueryBatchResult, 1)
	go func() {
		<-startGate
		samples, err := s.executeQueryBatch(materialID, request.QueryCount)
		queryResult <- purchaseQueryBatchResult{samples: samples, err: err}
	}()

	withOutbox := request.Strategy == PurchaseOutboxMQInvalidate
	purchaseResults := make(chan purchaseExecutionResult, request.PurchaseCount)
	var purchaseWait sync.WaitGroup
	for index := 0; index < request.PurchaseCount; index++ {
		purchaseWait.Add(1)
		go func(purchaseIndex int) {
			defer purchaseWait.Done()
			<-startGate
			purchaseResults <- s.executePurchase(
				ctx, request, materialID, purchaseIndex, withOutbox,
			)
		}(index)
	}
	recorder.add("purchase", "transaction_started", "PURCHASES RELEASED",
		fmt.Sprintf("%d 个唯一 request_id 已并发进入购买事务", request.PurchaseCount),
		"mysql", 0, run.FinalMySQLStock, run.FinalRedisStock, nil)
	close(startGate)
	go func() {
		purchaseWait.Wait()
		close(purchaseResults)
	}()

	var purchaseLatency time.Duration
	var invalidationLatency time.Duration
	var maxTransactionLatency time.Duration
	var processedPurchases int
	var successfulInvalidations int
	var firstExecutionError error
	purchaseLatencies := make([]float64, 0, request.PurchaseCount)
	for result := range purchaseResults {
		if result.transactionElapsed > maxTransactionLatency {
			maxTransactionLatency = result.transactionElapsed
		}
		if result.requestLatency > 0 {
			processedPurchases++
			purchaseLatency += result.requestLatency
			purchaseLatencies = append(purchaseLatencies, durationMilliseconds(result.requestLatency))
		}
		if result.err != nil {
			if firstExecutionError == nil {
				firstExecutionError = result.err
			}
			continue
		}
		if result.commit.SoldOut {
			run.SoldOutRequests++
			continue
		}
		if result.commit.Duplicate {
			run.DuplicateRequests++
		} else {
			run.PurchaseSucceeded++
		}
		if request.Strategy == PurchaseSyncInvalidate {
			invalidationLatency += result.invalidationElapsed
			if result.invalidationErr != nil {
				if firstExecutionError == nil {
					firstExecutionError = result.invalidationErr
				}
				continue
			}
			successfulInvalidations++
		}
	}

	queryBatch := <-queryResult
	if queryBatch.err != nil && run.ErrorMessage == "" {
		run.Status = PurchaseRunFailed
		run.ErrorMessage = queryBatch.err.Error()
	}
	run.QuerySamples = queryBatch.samples
	run.QueryCompleted = len(queryBatch.samples)

	finalState, finalErr := s.store.InspectPurchaseExperimentState(materialID)
	if finalErr != nil {
		return nil, purchaseLabError("购买实验结果校验失败", materialID, finalErr)
	}
	run.FinalMySQLStock = finalState.MySQLStock
	run.FinalRedisStock = cloneInt(finalState.RedisStock)
	if run.PurchaseSucceeded > 0 || run.DuplicateRequests > 0 {
		recorder.add("purchase", "transaction_committed", "MYSQL TRANSACTIONS COMMITTED",
			fmt.Sprintf("%d 笔新订单提交，%d 笔幂等命中，库存 %d → %d",
				run.PurchaseSucceeded, run.DuplicateRequests, run.InitialStock, run.FinalMySQLStock),
			"mysql", maxTransactionLatency, run.FinalMySQLStock, run.FinalRedisStock, nil)
	}
	if run.SoldOutRequests > 0 {
		recorder.add("purchase", "sold_out", "MYSQL SOLD OUT",
			fmt.Sprintf("%d 个条件扣减影响 0 行，库存没有变成负数", run.SoldOutRequests),
			"mysql", 0, run.FinalMySQLStock, run.FinalRedisStock, nil)
	}
	if request.Strategy == PurchaseSyncInvalidate {
		if firstExecutionError == nil {
			recorder.add("purchase", "cache_invalidated", "SYNC CACHE INVALIDATED",
				fmt.Sprintf("%d 个购买响应在 Redis DEL 成功后返回", successfulInvalidations),
				"redis", invalidationLatency, run.FinalMySQLStock, run.FinalRedisStock, nil)
		} else {
			recorder.add("purchase", "cache_invalidation_failed", "CACHE DELETE FAILED",
				"MySQL 可能已经提交；同步删除重试耗尽，页面展示真实失败而不伪造完成状态",
				"redis", invalidationLatency, run.FinalMySQLStock, run.FinalRedisStock, nil)
		}
	} else if run.PurchaseSucceeded > 0 {
		run.OutboxStatus = database.PurchaseOutboxPending
		run.MQStatus = "waiting-publisher"
		recorder.add("purchase", "outbox_created", "OUTBOX COMMITTED",
			fmt.Sprintf("%d 张缓存失效凭证与订单在同一事务提交，购买响应不等待 Consumer",
				run.PurchaseSucceeded),
			"mysql", 0, run.FinalMySQLStock, run.FinalRedisStock, nil)
		select {
		case s.workerWake <- struct{}{}:
		default:
		}
	}
	for index := range run.QuerySamples {
		if run.QuerySamples[index].Old {
			run.OldReadCount++
		}
		responseStock := run.QuerySamples[index].Stock
		recorder.add("query", "query_material", "MATERIAL QUERY · "+string(run.QuerySamples[index].Source),
			"查询读取与 /api/archives/:id/cached 相同的 DTO 缓存",
			"redis", time.Duration(run.QuerySamples[index].LatencyMS*float64(time.Millisecond)),
			run.FinalMySQLStock, run.FinalRedisStock, &responseStock)
	}
	if processedPurchases > 0 {
		run.PurchaseLatencyMS = durationMilliseconds(purchaseLatency) / float64(processedPurchases)
		run.PurchaseP99MS = percentile99(purchaseLatencies)
	}
	if successfulInvalidations > 0 {
		run.CacheInvalidationLatencyMS = durationMilliseconds(invalidationLatency) / float64(successfulInvalidations)
	}
	if firstExecutionError != nil && run.ErrorMessage == "" {
		run.Status = PurchaseRunFailed
		if errors.Is(firstExecutionError, database.ErrPurchaseRequestConflict) {
			run.ErrorMessage = "购买请求编号已被不同参数使用"
		} else {
			run.ErrorMessage = firstExecutionError.Error()
		}
	}
	recorder.add("purchase", "purchase_responded", "PURCHASE RESPONSES COLLECTED",
		fmt.Sprintf("成功 %d，售罄 %d，幂等拦截 %d",
			run.PurchaseSucceeded, run.SoldOutRequests, run.DuplicateRequests),
		"response", purchaseLatency, run.FinalMySQLStock, run.FinalRedisStock, nil)
	run.Trace = recorder.steps
	if run.Status != PurchaseRunFailed {
		if request.Strategy == PurchaseSyncInvalidate {
			run.Status = PurchaseRunCompleted
		} else {
			run.Status = PurchaseRunWaitingOutbox
		}
	}
	run.ExecutedAt = time.Now()
	s.storeRun(run)
	slog.Info("purchase lab batch completed",
		"request_id", request.RequestID, "material_id", materialID, "strategy", request.Strategy,
		"requested", request.PurchaseCount, "succeeded", run.PurchaseSucceeded,
		"duplicate", run.DuplicateRequests, "sold_out", run.SoldOutRequests,
		"purchase_p99_ms", run.PurchaseP99MS, "status", run.Status)
	return s.GetRun(request.RequestID)
}

// executePurchase 只并发编排既有的单次购买语义：MySQL 条件扣减、订单幂等和 Outbox
// 原子性仍由 Store 保证；同步方案必须等 Redis DEL 完成后才计算购买响应延迟。
func (s *PurchaseLabService) executePurchase(
	ctx context.Context,
	request PurchaseExperimentRequest,
	materialID int,
	index int,
	withOutbox bool,
) purchaseExecutionResult {
	result := purchaseExecutionResult{
		childRequestID: purchaseChildRequestID(request.RequestID, index, request.PurchaseCount),
	}
	requestStarted := time.Now()
	transactionStarted := time.Now()
	result.commit, result.err = s.store.CommitMaterialPurchase(
		request.RequestID,
		result.childRequestID,
		"purchase-cache-"+result.childRequestID,
		materialID,
		1,
		string(request.Strategy),
		withOutbox,
	)
	result.transactionElapsed = time.Since(transactionStarted)
	if result.err == nil && !result.commit.SoldOut && request.Strategy == PurchaseSyncInvalidate {
		invalidationStarted := time.Now()
		result.invalidationErr = deleteMaterialCacheWithRetry(ctx, materialID, 3)
		result.invalidationElapsed = time.Since(invalidationStarted)
	}
	result.requestLatency = time.Since(requestStarted)
	if result.err == nil && !result.commit.SoldOut && !result.commit.Duplicate {
		if err := s.store.UpdatePurchaseOrderLatency(
			result.childRequestID,
			durationMilliseconds(result.requestLatency),
		); err != nil {
			slog.Warn("persist purchase lab latency failed",
				"request_id", result.childRequestID, "material_id", materialID, "error", err)
		}
	}
	return result
}

// Query 执行与材料查询店完全相同的 Cached 读路径，支持小批量真实样本。
func (s *PurchaseLabService) Query(materialID, count int) ([]PurchaseQuerySample, *AppError) {
	if count < 1 || count > maxQueryBatch {
		return nil, NewAppError(CodePurchaseLabInvalidStrategy,
			fmt.Sprintf("查询样本数必须在 1 到 %d 之间", maxQueryBatch), nil,
			"material_id", materialID, "query_count", count)
	}
	samples, err := s.executeQueryBatch(materialID, count)
	if err != nil {
		return nil, purchaseLabError("购买实验查询失败", materialID, err)
	}
	return samples, nil
}

func (s *PurchaseLabService) executeQueryBatch(materialID, count int) ([]PurchaseQuerySample, error) {
	if count <= 0 {
		return nil, nil
	}
	results := make(chan PurchaseQuerySample, count)
	errs := make(chan error, count)
	var wait sync.WaitGroup
	for index := 0; index < count; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			started := time.Now()
			detail, source, _, appErr := s.archive.ReadCached(materialID)
			if appErr != nil {
				errs <- appErr
				return
			}
			readLatency := time.Since(started)
			authoritativeStock, err := s.store.MaterialStock(materialID)
			if err != nil {
				errs <- err
				return
			}
			results <- PurchaseQuerySample{
				Source: source, Stock: detail.Stock, AuthoritativeStock: authoritativeStock,
				LatencyMS: durationMilliseconds(readLatency),
				Old:       detail.Stock != authoritativeStock,
			}
		}()
	}
	wait.Wait()
	close(results)
	close(errs)
	if err, ok := <-errs; ok {
		return nil, err
	}
	samples := make([]PurchaseQuerySample, 0, count)
	for sample := range results {
		samples = append(samples, sample)
	}
	return samples, nil
}

// GetRun 合并内存中的查询样本与 MySQL 中持久化的订单/Outbox 状态。
func (s *PurchaseLabService) GetRun(requestID string) (*PurchaseExperimentRun, *AppError) {
	if !purchaseRequestIDPattern.MatchString(requestID) {
		return nil, NewAppError(CodePurchaseLabInvalidStrategy,
			"request_id 格式无效", nil, "request_id", requestID)
	}
	orders, events, err := s.store.PurchaseBatchRecords(requestID)
	if err != nil {
		return nil, NewAppError(CodePurchaseLabUnavailable, "读取购买实验状态失败", err, "request_id", requestID)
	}
	s.runMu.RLock()
	stored := clonePurchaseExperimentRun(s.runs[requestID])
	s.runMu.RUnlock()
	if stored == nil && len(orders) == 0 && len(events) == 0 {
		return nil, NewAppError(CodePurchaseLabRunNotFound, "购买实验记录不存在", nil, "request_id", requestID)
	}
	if stored == nil {
		stored = &PurchaseExperimentRun{RequestID: requestID, Status: PurchaseRunRunning}
		if len(orders) > 0 {
			stored.MaterialID = orders[0].MaterialID
			stored.Strategy = PurchaseStrategy(orders[0].Strategy)
			stored.PurchaseRequested = len(orders)
			stored.PurchaseSucceeded = len(orders)
			stored.ExecutedAt = orders[0].CreatedAt
		}
	}
	if stored.MaterialID > 0 {
		if state, stateErr := s.store.InspectPurchaseExperimentState(stored.MaterialID); stateErr == nil {
			stored.FinalMySQLStock = state.MySQLStock
			stored.FinalRedisStock = cloneInt(state.RedisStock)
		}
	}

	var totalPurchaseLatency float64
	purchaseLatencies := make([]float64, 0, len(orders))
	for _, order := range orders {
		totalPurchaseLatency += order.PurchaseLatencyMS
		purchaseLatencies = append(purchaseLatencies, order.PurchaseLatencyMS)
	}
	if totalPurchaseLatency > 0 {
		stored.PurchaseLatencyMS = totalPurchaseLatency / float64(len(orders))
		stored.PurchaseP99MS = percentile99(purchaseLatencies)
	}
	refreshRunOutboxState(stored, events)
	s.storeRun(stored)
	return clonePurchaseExperimentRun(stored), nil
}

// RunOutboxWorker 持续认领持久化事件并发布 RocketMQ。
func (s *PurchaseLabService) RunOutboxWorker(ctx context.Context) {
	if err := s.store.RecoverPurchaseOutbox(); err != nil {
		slog.Error("recover purchase outbox failed", "error", err)
	}
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := s.publishAvailableOutbox(ctx); err != nil {
			slog.Error("publish purchase outbox failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-s.workerWake:
		case <-ticker.C:
		}
	}
}

func (s *PurchaseLabService) publishAvailableOutbox(ctx context.Context) error {
	for {
		if err := ctx.Err(); err != nil {
			return nil
		}
		event, err := s.store.ClaimNextPurchaseOutbox(time.Now())
		if err != nil {
			return err
		}
		if event == nil {
			return nil
		}
		command := database.PurchaseCacheInvalidation{EventID: event.EventID, MaterialID: event.MaterialID}
		if err := mq.SendPurchaseCacheInvalidation(command); err != nil {
			delay := purchaseOutboxRetryDelay(event.RetryCount + 1)
			if markErr := s.store.MarkPurchaseOutboxPublishFailed(event.EventID, time.Now().Add(delay), err); markErr != nil {
				return fmt.Errorf("record purchase outbox publish failure %s: %w", event.EventID, markErr)
			}
			slog.Warn("purchase outbox scheduled for retry",
				"event_id", event.EventID, "material_id", event.MaterialID,
				"retry_count", event.RetryCount+1, "retry_after", delay, "error", err)
			continue
		}
		if err := s.store.MarkPurchaseOutboxPublished(event.EventID, time.Now()); err != nil {
			return err
		}
	}
}

// ConsumeCacheInvalidation 幂等消费材料缓存失效消息。
// Redis 删除失败时返回 error 留消息未 Ack；MQ 重投会再次执行安全的 DEL。
func (s *PurchaseLabService) ConsumeCacheInvalidation(command database.PurchaseCacheInvalidation) error {
	event, err := s.store.PurchaseOutboxByEvent(command.EventID)
	if err != nil {
		return err
	}
	if event == nil || event.Status == database.PurchaseOutboxCancelled ||
		event.Status == database.PurchaseOutboxCompleted {
		return nil
	}
	if event.MaterialID != command.MaterialID {
		return fmt.Errorf("purchase invalidation material mismatch event=%s", command.EventID)
	}
	if err := database.DeleteMaterialDetailCache(command.MaterialID); err != nil {
		if recordErr := s.store.RecordPurchaseOutboxConsumerFailure(command.EventID, err); recordErr != nil {
			slog.Error("record purchase cache invalidation failure failed",
				"event_id", command.EventID, "material_id", command.MaterialID,
				"delete_error", err, "record_error", recordErr)
		}
		return err
	}
	if err := s.store.MarkPurchaseOutboxInvalidated(command.EventID, time.Now()); err != nil {
		return err
	}
	slog.Info("purchase material cache invalidated",
		"event_id", command.EventID, "material_id", command.MaterialID)
	return nil
}

func validatePurchaseExperimentRequest(materialID int, request PurchaseExperimentRequest) *AppError {
	if request.Strategy != PurchaseSyncInvalidate && request.Strategy != PurchaseOutboxMQInvalidate {
		return NewAppError(CodePurchaseLabInvalidStrategy, "购买实验方案无效", nil,
			"material_id", materialID, "strategy", request.Strategy)
	}
	if !purchaseRequestIDPattern.MatchString(request.RequestID) {
		return NewAppError(CodePurchaseLabInvalidStrategy, "request_id 格式无效", nil,
			"material_id", materialID, "request_id", request.RequestID)
	}
	if request.PurchaseCount < 1 || request.PurchaseCount > maxPurchaseBatch {
		return NewAppError(CodePurchaseLabInvalidStrategy,
			fmt.Sprintf("购买请求数必须在 1 到 %d 之间", maxPurchaseBatch), nil,
			"material_id", materialID, "purchase_count", request.PurchaseCount)
	}
	if request.QueryCount < 0 || request.QueryCount > maxQueryBatch {
		return NewAppError(CodePurchaseLabInvalidStrategy,
			fmt.Sprintf("查询请求数必须在 0 到 %d 之间", maxQueryBatch), nil,
			"material_id", materialID, "query_count", request.QueryCount)
	}
	return nil
}

func deleteMaterialCacheWithRetry(ctx context.Context, materialID, attempts int) error {
	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		if err := database.DeleteMaterialDetailCache(materialID); err == nil {
			return nil
		} else {
			lastErr = err
		}
		if attempt == attempts {
			break
		}
		timer := time.NewTimer(time.Duration(attempt*50) * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return fmt.Errorf("delete material cache after %d attempts: %w", attempts, lastErr)
}

func purchaseChildRequestID(batchID string, index, total int) string {
	if total == 1 {
		return batchID
	}
	return fmt.Sprintf("%s-p%02d", batchID, index+1)
}

func purchaseOutboxRetryDelay(retry int) time.Duration {
	if retry < 1 {
		retry = 1
	}
	if retry > 6 {
		retry = 6
	}
	return time.Duration(1<<(retry-1)) * 250 * time.Millisecond
}

func refreshRunOutboxState(run *PurchaseExperimentRun, events []database.PurchaseLabOutbox) {
	run.Outbox = make([]PurchaseOutboxView, 0, len(events))
	if run.Strategy != PurchaseOutboxMQInvalidate {
		if run.Status != PurchaseRunFailed {
			run.Status = PurchaseRunCompleted
		}
		run.OutboxStatus = "not-used"
		run.MQStatus = "not-used"
		return
	}
	if len(events) == 0 {
		run.OutboxStatus = database.PurchaseOutboxPending
		run.MQStatus = "waiting-publisher"
		run.Status = PurchaseRunWaitingOutbox
		return
	}
	allCompleted := true
	anyPublished := false
	anyRetry := false
	var totalInvalidationLatency float64
	var invalidatedEvents int
	run.RetryCount = 0
	for _, event := range events {
		run.Outbox = append(run.Outbox, PurchaseOutboxView{
			EventID: event.EventID, Status: event.Status, RetryCount: event.RetryCount,
			LastError: event.LastError, CreatedAt: event.CreatedAt,
			PublishedAt: event.PublishedAt, InvalidatedAt: event.InvalidatedAt,
		})
		run.RetryCount += event.RetryCount
		if event.Status != database.PurchaseOutboxCompleted {
			allCompleted = false
		}
		if event.Status == database.PurchaseOutboxPublished {
			anyPublished = true
		}
		if event.Status == database.PurchaseOutboxRetry {
			anyRetry = true
		}
		if event.InvalidatedAt != nil {
			latency := durationMilliseconds(event.InvalidatedAt.Sub(event.CreatedAt))
			totalInvalidationLatency += latency
			invalidatedEvents++
		}
	}
	if invalidatedEvents > 0 {
		run.CacheInvalidationLatencyMS = totalInvalidationLatency / float64(invalidatedEvents)
	}
	switch {
	case allCompleted:
		run.Status = PurchaseRunCompleted
		run.OutboxStatus = database.PurchaseOutboxCompleted
		run.MQStatus = "consumed"
	case anyPublished:
		run.Status = PurchaseRunWaitingConsumer
		run.OutboxStatus = database.PurchaseOutboxPublished
		run.MQStatus = "waiting-consumer"
	case anyRetry:
		run.Status = PurchaseRunWaitingOutbox
		run.OutboxStatus = database.PurchaseOutboxRetry
		run.MQStatus = "publisher-retrying"
	default:
		run.Status = PurchaseRunWaitingOutbox
		run.OutboxStatus = database.PurchaseOutboxPending
		run.MQStatus = "waiting-publisher"
	}
}

func (s *PurchaseLabService) storeRun(run *PurchaseExperimentRun) {
	s.runMu.Lock()
	s.runs[run.RequestID] = clonePurchaseExperimentRun(run)
	s.runMu.Unlock()
}

func clonePurchaseExperimentRun(run *PurchaseExperimentRun) *PurchaseExperimentRun {
	if run == nil {
		return nil
	}
	copy := *run
	copy.FinalRedisStock = cloneInt(run.FinalRedisStock)
	copy.Trace = append([]PurchaseTraceStep(nil), run.Trace...)
	copy.QuerySamples = append([]PurchaseQuerySample(nil), run.QuerySamples...)
	copy.Outbox = append([]PurchaseOutboxView(nil), run.Outbox...)
	return &copy
}

type purchaseTraceRecorder struct {
	mu      sync.Mutex
	started time.Time
	steps   []PurchaseTraceStep
}

func newPurchaseTraceRecorder(started time.Time) *purchaseTraceRecorder {
	return &purchaseTraceRecorder{started: started, steps: make([]PurchaseTraceStep, 0, 8)}
}

func (r *purchaseTraceRecorder) add(
	actor, action, label, detail, target string,
	duration time.Duration,
	mysqlStock int,
	redisStock, responseStock *int,
) {
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

func percentile99(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	index := int(float64(len(sorted))*0.99+0.999999) - 1
	if index < 0 {
		index = 0
	}
	if index >= len(sorted) {
		index = len(sorted) - 1
	}
	return sorted[index]
}

func purchaseLabError(message string, materialID int, err error) *AppError {
	if errors.Is(err, database.ErrMaterialArchiveNotFound) {
		return NewAppError(CodePurchaseLabMaterialNotFound, "购买实验中没有这个材料", err, "material_id", materialID)
	}
	if appErr, ok := err.(*AppError); ok {
		return appErr
	}
	return NewAppError(CodePurchaseLabUnavailable, message, err, "material_id", materialID)
}
