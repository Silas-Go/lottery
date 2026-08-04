package database_test

import (
	"context"
	"fmt"
	"silas/internal/database"
	"silas/internal/service"
	"sync"
	"testing"
	"time"
)

const starMarrowMaterialID = database.StarMarrowMaterialID

func purchaseIntegrationID(prefix string) string {
	return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
}

func ensurePurchaseExperimentFixtures(t *testing.T) {
	t.Helper()
	if err := store.EnsureMaterialReadModelSchema(); err != nil {
		t.Fatalf("ensure shared material schema: %v", err)
	}
	if err := store.EnsurePurchaseExperimentSchema(); err != nil {
		t.Fatalf("ensure purchase experiment schema: %v", err)
	}
}

// TestPurchaseExperimentSyncInvalidateSharesArchiveData 验证购买事务与 Direct/Cached
// 查询共同使用 materials.stock 和 archive:material-detail:v2:{id}，并验证 request_id 重试不重复扣减。
func TestPurchaseExperimentSyncInvalidateSharesArchiveData(t *testing.T) {
	if store == nil {
		t.Skip("store not initialized (needs MySQL and Redis)")
	}
	ensurePurchaseExperimentFixtures(t)
	lab := service.NewPurchaseLabService(store)
	archive := service.NewArchiveService(store)
	t.Cleanup(func() {
		_, _ = lab.Reset(starMarrowMaterialID)
	})

	baseline, appErr := lab.Reset(starMarrowMaterialID)
	if appErr != nil {
		t.Fatalf("reset shared purchase fixture: %v", appErr)
	}
	requestID := purchaseIntegrationID("sync-shared")
	run, appErr := lab.RunExperiment(context.Background(), starMarrowMaterialID, service.PurchaseExperimentRequest{
		RequestID: requestID, Strategy: service.PurchaseSyncInvalidate,
		PurchaseCount: 1, QueryCount: 0,
	})
	if appErr != nil {
		t.Fatalf("run sync invalidation: %v", appErr)
	}
	if run.Status != service.PurchaseRunCompleted || run.PurchaseSucceeded != 1 {
		t.Fatalf("unexpected sync result: %+v", run)
	}
	if run.FinalMySQLStock != baseline.InitialStock-1 || run.FinalRedisStock != nil {
		t.Fatalf("sync invalidation must commit stock and delete DTO cache: %+v", run)
	}

	direct, _, _, appErr := archive.ReadDirect(starMarrowMaterialID)
	if appErr != nil {
		t.Fatalf("read direct after purchase: %v", appErr)
	}
	cached, source, _, appErr := archive.ReadCached(starMarrowMaterialID)
	if appErr != nil {
		t.Fatalf("read cached after purchase: %v", appErr)
	}
	if direct.Stock != baseline.InitialStock-1 || cached.Stock != direct.Stock {
		t.Fatalf("purchase and archive reads do not share stock: direct=%d cached=%d", direct.Stock, cached.Stock)
	}
	if source != service.ArchiveSourceCacheMiss {
		t.Fatalf("first cached read after sync DEL should refill from MySQL, source=%s", source)
	}

	retry, appErr := lab.RunExperiment(context.Background(), starMarrowMaterialID, service.PurchaseExperimentRequest{
		RequestID: requestID, Strategy: service.PurchaseSyncInvalidate,
		PurchaseCount: 1, QueryCount: 0,
	})
	if appErr != nil {
		t.Fatalf("retry sync invalidation: %v", appErr)
	}
	if retry.DuplicateRequests != 1 || retry.FinalMySQLStock != direct.Stock {
		t.Fatalf("same request_id must not decrement twice: %+v", retry)
	}
}

// TestPurchaseExperimentOutboxConsumerIsIdempotent 验证订单与 Outbox 同事务落库后，
// 缓存失效 Consumer 可以安全重复删除同一个 DTO key，并把事件收敛到 completed。
func TestPurchaseExperimentOutboxConsumerIsIdempotent(t *testing.T) {
	if store == nil {
		t.Skip("store not initialized (needs MySQL and Redis)")
	}
	ensurePurchaseExperimentFixtures(t)
	lab := service.NewPurchaseLabService(store)
	archive := service.NewArchiveService(store)
	t.Cleanup(func() {
		_, _ = lab.Reset(starMarrowMaterialID)
	})

	baseline, appErr := lab.Reset(starMarrowMaterialID)
	if appErr != nil {
		t.Fatalf("reset outbox fixture: %v", appErr)
	}
	requestID := purchaseIntegrationID("outbox-idempotent")
	run, appErr := lab.RunExperiment(context.Background(), starMarrowMaterialID, service.PurchaseExperimentRequest{
		RequestID: requestID, Strategy: service.PurchaseOutboxMQInvalidate,
		PurchaseCount: 1, QueryCount: 0,
	})
	if appErr != nil {
		t.Fatalf("run outbox purchase: %v", appErr)
	}
	if run.PurchaseSucceeded != 1 || len(run.Outbox) != 1 {
		t.Fatalf("order and outbox should commit together: %+v", run)
	}
	command := database.PurchaseCacheInvalidation{
		EventID: run.Outbox[0].EventID, MaterialID: starMarrowMaterialID,
	}
	if err := lab.ConsumeCacheInvalidation(command); err != nil {
		t.Fatalf("consume invalidation: %v", err)
	}
	if err := lab.ConsumeCacheInvalidation(command); err != nil {
		t.Fatalf("duplicate invalidation must be idempotent: %v", err)
	}

	completed, appErr := lab.GetRun(requestID)
	if appErr != nil {
		t.Fatalf("read completed outbox run: %v", appErr)
	}
	if completed.Status != service.PurchaseRunCompleted ||
		completed.OutboxStatus != database.PurchaseOutboxCompleted {
		t.Fatalf("outbox did not reach completed: %+v", completed)
	}
	if completed.FinalRedisStock != nil || completed.FinalMySQLStock != baseline.InitialStock-1 {
		t.Fatalf("consumer must delete shared cache without changing committed stock: %+v", completed)
	}

	direct, _, _, appErr := archive.ReadDirect(starMarrowMaterialID)
	if appErr != nil {
		t.Fatalf("read direct after outbox invalidation: %v", appErr)
	}
	cached, source, _, appErr := archive.ReadCached(starMarrowMaterialID)
	if appErr != nil {
		t.Fatalf("read cached after outbox invalidation: %v", appErr)
	}
	if source != service.ArchiveSourceCacheMiss || cached.Stock != direct.Stock {
		t.Fatalf("cached query must refill the purchased stock: source=%s direct=%d cached=%d",
			source, direct.Stock, cached.Stock)
	}
}

// TestRecoverPurchaseOutboxRequeuesPublishedEvent 验证切换缓存失效 Consumer Group 或进程重启时，
// 已发布但尚未 completed 的事件会重新进入 retry；重复发布只会触发幂等 DEL，不会再次扣库存。
func TestRecoverPurchaseOutboxRequeuesPublishedEvent(t *testing.T) {
	if store == nil {
		t.Skip("store not initialized (needs MySQL and Redis)")
	}
	ensurePurchaseExperimentFixtures(t)
	lab := service.NewPurchaseLabService(store)
	t.Cleanup(func() {
		_, _ = lab.Reset(starMarrowMaterialID)
	})
	if _, appErr := lab.Reset(starMarrowMaterialID); appErr != nil {
		t.Fatalf("reset outbox recovery fixture: %v", appErr)
	}

	requestID := purchaseIntegrationID("outbox-recovery")
	eventID := purchaseIntegrationID("outbox-recovery-event")
	if _, err := store.CommitMaterialPurchase(
		requestID, requestID, eventID, starMarrowMaterialID, 1,
		string(service.PurchaseOutboxMQInvalidate), true,
	); err != nil {
		t.Fatalf("commit recovery outbox: %v", err)
	}
	event, err := store.ClaimNextPurchaseOutbox(time.Now())
	if err != nil || event == nil || event.EventID != eventID {
		t.Fatalf("claim recovery outbox: event=%+v err=%v", event, err)
	}
	if err := store.MarkPurchaseOutboxPublished(eventID, time.Now()); err != nil {
		t.Fatalf("mark recovery outbox published: %v", err)
	}

	if err := store.RecoverPurchaseOutbox(); err != nil {
		t.Fatalf("recover published outbox: %v", err)
	}
	recovered, err := store.PurchaseOutboxByEvent(eventID)
	if err != nil {
		t.Fatalf("read recovered outbox: %v", err)
	}
	if recovered == nil || recovered.Status != database.PurchaseOutboxRetry || recovered.RetryCount != 1 {
		t.Fatalf("published outbox must become retry exactly once: %+v", recovered)
	}
}

// TestPurchaseExperimentOutboxConflictRollsBackStock 验证 Outbox 唯一键冲突会让
// 库存扣减和订单创建整体回滚，不会留下“扣了库存但没有事件”的半事务。
func TestPurchaseExperimentOutboxConflictRollsBackStock(t *testing.T) {
	if store == nil {
		t.Skip("store not initialized (needs MySQL and Redis)")
	}
	ensurePurchaseExperimentFixtures(t)
	lab := service.NewPurchaseLabService(store)
	t.Cleanup(func() {
		_, _ = lab.Reset(starMarrowMaterialID)
	})
	baseline, appErr := lab.Reset(starMarrowMaterialID)
	if appErr != nil {
		t.Fatalf("reset outbox rollback fixture: %v", appErr)
	}

	eventID := purchaseIntegrationID("shared-event")
	firstBatch := purchaseIntegrationID("outbox-first")
	if _, err := store.CommitMaterialPurchase(
		firstBatch, firstBatch, eventID, starMarrowMaterialID, 1,
		string(service.PurchaseOutboxMQInvalidate), true,
	); err != nil {
		t.Fatalf("commit first outbox transaction: %v", err)
	}
	secondBatch := purchaseIntegrationID("outbox-second")
	if _, err := store.CommitMaterialPurchase(
		secondBatch, secondBatch, eventID, starMarrowMaterialID, 1,
		string(service.PurchaseOutboxMQInvalidate), true,
	); err == nil {
		t.Fatal("duplicate event_id should reject the second transaction")
	}

	stock, err := store.MaterialStock(starMarrowMaterialID)
	if err != nil {
		t.Fatalf("read stock after rolled-back outbox: %v", err)
	}
	if stock != baseline.InitialStock-1 {
		t.Fatalf("failed outbox insert must roll back stock: got=%d want=%d", stock, baseline.InitialStock-1)
	}
	orders, events, err := store.PurchaseBatchRecords(secondBatch)
	if err != nil {
		t.Fatalf("read rolled-back batch: %v", err)
	}
	if len(orders) != 0 || len(events) != 0 {
		t.Fatalf("rolled-back transaction left records: orders=%d events=%d", len(orders), len(events))
	}
}

// TestPurchaseExperimentRuns150UniquePurchases 验证页面固定的 150 人购买不是前端动画：
// 星髓首发 100 份，因此服务端应真实落下 100 单，并明确拒绝其余 50 个售罄请求。
func TestPurchaseExperimentRuns150UniquePurchases(t *testing.T) {
	if store == nil {
		t.Skip("store not initialized (needs MySQL and Redis)")
	}
	ensurePurchaseExperimentFixtures(t)
	lab := service.NewPurchaseLabService(store)
	t.Cleanup(func() {
		_, _ = lab.Reset(starMarrowMaterialID)
	})
	baseline, appErr := lab.Reset(starMarrowMaterialID)
	if appErr != nil {
		t.Fatalf("reset 150 purchase fixture: %v", appErr)
	}

	requestID := purchaseIntegrationID("buyers-150")
	run, appErr := lab.RunExperiment(context.Background(), starMarrowMaterialID, service.PurchaseExperimentRequest{
		RequestID: requestID, Strategy: service.PurchaseSyncInvalidate,
		PurchaseCount: 150, QueryCount: 0,
	})
	if appErr != nil {
		t.Fatalf("run 150 concurrent purchases: %v", appErr)
	}
	if run.Status != service.PurchaseRunCompleted ||
		run.PurchaseSucceeded != baseline.InitialStock ||
		run.SoldOutRequests != 150-baseline.InitialStock ||
		run.DuplicateRequests != 0 {
		t.Fatalf("unexpected 150 purchase result: %+v", run)
	}
	if run.FinalMySQLStock != 0 || run.PurchaseP99MS <= 0 {
		t.Fatalf("150 purchases did not produce real stock and latency evidence: %+v", run)
	}
	orders, _, err := store.PurchaseBatchRecords(requestID)
	if err != nil {
		t.Fatalf("read 150 purchase orders: %v", err)
	}
	if len(orders) != baseline.InitialStock {
		t.Fatalf("expected %d persisted successful orders, got %d", baseline.InitialStock, len(orders))
	}
}

// TestPurchaseExperimentConcurrentStockNeverNegative 用超过库存的并发请求验证条件更新：
// 只有基线库存数量的请求能成功，其余请求明确 sold_out，materials.stock 保持为 0。
func TestPurchaseExperimentConcurrentStockNeverNegative(t *testing.T) {
	if store == nil {
		t.Skip("store not initialized (needs MySQL and Redis)")
	}
	ensurePurchaseExperimentFixtures(t)
	lab := service.NewPurchaseLabService(store)
	t.Cleanup(func() {
		_, _ = lab.Reset(starMarrowMaterialID)
	})
	baseline, appErr := lab.Reset(starMarrowMaterialID)
	if appErr != nil {
		t.Fatalf("reset oversell fixture: %v", appErr)
	}
	if baseline.InitialStock != 100 {
		t.Fatalf("star marrow launch stock must be 100, got %d", baseline.InitialStock)
	}

	batchID := purchaseIntegrationID("oversell")
	attempts := baseline.InitialStock + 8
	var wait sync.WaitGroup
	var lock sync.Mutex
	var succeeded, soldOut int
	var firstErr error
	for index := 0; index < attempts; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			requestID := fmt.Sprintf("%s-%02d", batchID, index)
			result, err := store.CommitMaterialPurchase(
				batchID, requestID, "", starMarrowMaterialID, 1,
				string(service.PurchaseSyncInvalidate), false,
			)
			lock.Lock()
			defer lock.Unlock()
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				return
			}
			if result.SoldOut {
				soldOut++
			} else {
				succeeded++
			}
		}(index)
	}
	wait.Wait()
	if firstErr != nil {
		t.Fatalf("concurrent purchase failed unexpectedly: %v", firstErr)
	}
	stock, err := store.MaterialStock(starMarrowMaterialID)
	if err != nil {
		t.Fatalf("read stock after contention: %v", err)
	}
	if stock != 0 || succeeded != baseline.InitialStock || soldOut != attempts-baseline.InitialStock {
		t.Fatalf("oversell guard failed: stock=%d succeeded=%d soldOut=%d", stock, succeeded, soldOut)
	}
}
