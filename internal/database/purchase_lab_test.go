package database_test

import (
	"silas/internal/service"
	"testing"
)

// TestPurchaseLabWriteOrderRace 验证两种顺序都执行真实存储操作，并得到不同的最终缓存状态。
// 该测试只修改独立 purchase_lab_inventory，不触碰秒杀库存、订单或 MQ。
func TestPurchaseLabWriteOrderRace(t *testing.T) {
	if store == nil {
		t.Skip("store not initialized (needs MySQL and Redis)")
	}
	if err := store.EnsurePurchaseLabSchema(); err != nil {
		t.Fatalf("ensure purchase lab schema: %v", err)
	}
	lab := service.NewPurchaseLabService(store)
	t.Cleanup(func() {
		_, _ = lab.Reset(2)
	})

	deleteFirst, appErr := lab.Run(2, service.PurchaseDeleteThenUpdate, true)
	if appErr != nil {
		t.Fatalf("run delete-first race: %v", appErr)
	}
	if !deleteFirst.DirtyCache || deleteFirst.FinalRedisStock == nil {
		t.Fatalf("delete-first race should leave dirty cache: %+v", deleteFirst)
	}
	if deleteFirst.DBReads != 1 || deleteFirst.RedisMisses != 1 {
		t.Fatalf("delete-first T2 should miss and read DB once: %+v", deleteFirst)
	}

	updateFirst, appErr := lab.Run(2, service.PurchaseUpdateThenDelete, true)
	if appErr != nil {
		t.Fatalf("run update-first race: %v", appErr)
	}
	if updateFirst.DirtyCache || updateFirst.FinalRedisStock != nil {
		t.Fatalf("update-first should delete final cache copy: %+v", updateFirst)
	}
	if updateFirst.DBReads != 0 || updateFirst.RedisHits != 1 {
		t.Fatalf("update-first T2 should hit old cache before deletion: %+v", updateFirst)
	}
	if !updateFirst.StaleQueryResponse {
		t.Fatalf("update-first is not absolute strong consistency: expected one stale T2 response")
	}
}
