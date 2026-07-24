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
		_, _ = lab.Reset(2)
	})

	baseline, appErr := lab.Reset(2)
	if appErr != nil {
		t.Fatalf("reset shared purchase fixture: %v", appErr)
	}
	requestID := purchaseIntegrationID("sync-shared")
	run, appErr := lab.RunExperiment(context.Background(), 2, service.PurchaseExperimentRequest{
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

	direct, _, _, appErr := archive.ReadDirect(2)
	if appErr != nil {
		t.Fatalf("read direct after purchase: %v", appErr)
	}
	cached, source, _, appErr := archive.ReadCached(2)
	if appErr != nil {
		t.Fatalf("read cached after purchase: %v", appErr)
	}
	if direct.Stock != baseline.InitialStock-1 || cached.Stock != direct.Stock {
		t.Fatalf("purchase and archive reads do not share stock: direct=%d cached=%d", direct.Stock, cached.Stock)
	}
	if source != service.ArchiveSourceCacheMiss {
		t.Fatalf("first cached read after sync DEL should refill from MySQL, source=%s", source)
	}

	retry, appErr := lab.RunExperiment(context.Background(), 2, service.PurchaseExperimentRequest{
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
// Consumer 可以安全重复删除同一个 DTO key，并把事件收敛到 completed。
func TestPurchaseExperimentOutboxConsumerIsIdempotent(t *testing.T) {
	if store == nil {
		t.Skip("store not initialized (needs MySQL and Redis)")
	}
	ensurePurchaseExperimentFixtures(t)
	lab := service.NewPurchaseLabService(store)
	archive := service.NewArchiveService(store)
	t.Cleanup(func() {
		_, _ = lab.Reset(3)
	})

	baseline, appErr := lab.Reset(3)
	if appErr != nil {
		t.Fatalf("reset outbox fixture: %v", appErr)
	}
	requestID := purchaseIntegrationID("outbox-idempotent")
	run, appErr := lab.RunExperiment(context.Background(), 3, service.PurchaseExperimentRequest{
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
		EventID: run.Outbox[0].EventID, MaterialID: 3,
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

	direct, _, _, appErr := archive.ReadDirect(3)
	if appErr != nil {
		t.Fatalf("read direct after outbox invalidation: %v", appErr)
	}
	cached, source, _, appErr := archive.ReadCached(3)
	if appErr != nil {
		t.Fatalf("read cached after outbox invalidation: %v", appErr)
	}
	if source != service.ArchiveSourceCacheMiss || cached.Stock != direct.Stock {
		t.Fatalf("cached query must refill the purchased stock: source=%s direct=%d cached=%d",
			source, direct.Stock, cached.Stock)
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
		_, _ = lab.Reset(1)
	})
	baseline, appErr := lab.Reset(1)
	if appErr != nil {
		t.Fatalf("reset outbox rollback fixture: %v", appErr)
	}

	eventID := purchaseIntegrationID("shared-event")
	firstBatch := purchaseIntegrationID("outbox-first")
	if _, err := store.CommitMaterialPurchase(
		firstBatch, firstBatch, eventID, 1, 1,
		string(service.PurchaseOutboxMQInvalidate), true,
	); err != nil {
		t.Fatalf("commit first outbox transaction: %v", err)
	}
	secondBatch := purchaseIntegrationID("outbox-second")
	if _, err := store.CommitMaterialPurchase(
		secondBatch, secondBatch, eventID, 1, 1,
		string(service.PurchaseOutboxMQInvalidate), true,
	); err == nil {
		t.Fatal("duplicate event_id should reject the second transaction")
	}

	stock, err := store.MaterialStock(1)
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
// 服务端会并发释放 150 个唯一 request_id，并复用单次事务语义完成真实扣库和订单写入。
func TestPurchaseExperimentRuns150UniquePurchases(t *testing.T) {
	if store == nil {
		t.Skip("store not initialized (needs MySQL and Redis)")
	}
	ensurePurchaseExperimentFixtures(t)
	lab := service.NewPurchaseLabService(store)
	t.Cleanup(func() {
		_, _ = lab.Reset(1)
	})
	baseline, appErr := lab.Reset(1)
	if appErr != nil {
		t.Fatalf("reset 150 purchase fixture: %v", appErr)
	}

	requestID := purchaseIntegrationID("buyers-150")
	run, appErr := lab.RunExperiment(context.Background(), 1, service.PurchaseExperimentRequest{
		RequestID: requestID, Strategy: service.PurchaseSyncInvalidate,
		PurchaseCount: 150, QueryCount: 0,
	})
	if appErr != nil {
		t.Fatalf("run 150 concurrent purchases: %v", appErr)
	}
	if run.Status != service.PurchaseRunCompleted ||
		run.PurchaseSucceeded != 150 ||
		run.SoldOutRequests != 0 ||
		run.DuplicateRequests != 0 {
		t.Fatalf("unexpected 150 purchase result: %+v", run)
	}
	if run.FinalMySQLStock != baseline.InitialStock-150 || run.PurchaseP99MS <= 0 {
		t.Fatalf("150 purchases did not produce real stock and latency evidence: %+v", run)
	}
	orders, _, err := store.PurchaseBatchRecords(requestID)
	if err != nil {
		t.Fatalf("read 150 purchase orders: %v", err)
	}
	if len(orders) != 150 {
		t.Fatalf("expected 150 persisted unique orders, got %d", len(orders))
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
		_, _ = lab.Reset(4)
	})
	baseline, appErr := lab.Reset(4)
	if appErr != nil {
		t.Fatalf("reset oversell fixture: %v", appErr)
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
				batchID, requestID, "", 4, 1,
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
	stock, err := store.MaterialStock(4)
	if err != nil {
		t.Fatalf("read stock after contention: %v", err)
	}
	if stock != 0 || succeeded != baseline.InitialStock || soldOut != attempts-baseline.InitialStock {
		t.Fatalf("oversell guard failed: stock=%d succeeded=%d soldOut=%d", stock, succeeded, soldOut)
	}
}
