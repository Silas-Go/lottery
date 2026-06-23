package database_test

import (
	"sync"
	"sync/atomic"
	"testing"
)

// TestCacheAsideNoOversell 验证旁路缓存模式在高并发扣减下绝不超卖。
//
// 这是 Cache-Aside 模式区别于"读缓存值再扣"误用的核心保证：扣减走
// UPDATE ... WHERE cache_stock > 0 的 MySQL 行锁原子操作，并发请求即使读到
// 同一份旧缓存，真正扣减仍被行锁串行化，库存只会扣到 0、绝不变负。
//
// 需要本机 MySQL/Redis 在线（复用 inventory_test.go 的 init 连接）。
// go test -v ./internal/database -run=^TestCacheAsideNoOversell$ -count=1
func TestCacheAsideNoOversell(t *testing.T) {
	if store == nil {
		t.Skip("store not initialized (needs MySQL)")
	}
	if err := store.EnsureCacheStockSchema(); err != nil {
		t.Fatalf("ensure cache stock schema: %v", err)
	}
	if err := store.ResetCacheStock(); err != nil {
		t.Fatalf("reset cache stock: %v", err)
	}

	const giftID = 2 // 篮球，初始库存较大
	before := readCacheStock(t, giftID)
	if before <= 0 {
		t.Skipf("gift %d has no stock to test", giftID)
	}

	// 并发扣减次数远超库存，验证成功扣减数恰好等于初始库存，且库存最终归零不为负。
	attempts := before + 200
	var success int64
	var wg sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, _, err := store.DeductGiftStockCacheAside(giftID)
			if err != nil {
				t.Errorf("deduct error: %v", err)
				return
			}
			if ok {
				atomic.AddInt64(&success, 1)
			}
		}()
	}
	wg.Wait()

	after := readCacheStock(t, giftID)
	if after < 0 {
		t.Fatalf("oversold! cache_stock went negative: %d", after)
	}
	if after != 0 {
		t.Fatalf("expected stock drained to 0, got %d", after)
	}
	if int(success) != before {
		t.Fatalf("successful deductions=%d should equal initial stock=%d (no oversell, no undersell)", success, before)
	}
}

func readCacheStock(t *testing.T, giftID int) int {
	t.Helper()
	gifts, _, err := store.GetAllGiftStockCacheAside()
	if err != nil {
		t.Fatalf("read cache stock: %v", err)
	}
	for _, gift := range gifts {
		if gift.Id == giftID {
			return gift.Count
		}
	}
	t.Fatalf("gift %d not found in inventory", giftID)
	return -1
}
