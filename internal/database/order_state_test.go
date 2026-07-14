package database

import (
	"errors"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/go-redis/redis"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestCanTransitionOrderStatus(t *testing.T) {
	tests := []struct {
		name string
		from OrderStatus
		to   OrderStatus
		want bool
	}{
		{"acquired to pending", OrderStatusStockAcquired, OrderStatusPendingPayment, true},
		{"acquired to cancelled", OrderStatusStockAcquired, OrderStatusCancelled, true},
		{"pending to paid", OrderStatusPendingPayment, OrderStatusPaid, true},
		{"pending to cancelled", OrderStatusPendingPayment, OrderStatusCancelled, true},
		{"paid cannot cancel", OrderStatusPaid, OrderStatusCancelled, false},
		{"cancelled cannot pay", OrderStatusCancelled, OrderStatusPaid, false},
		{"late create cannot revive cancellation", OrderStatusCancelled, OrderStatusPendingPayment, false},
		{"idempotent retry is not a transition", OrderStatusPaid, OrderStatusPaid, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := CanTransitionOrderStatus(tt.from, tt.to); got != tt.want {
				t.Fatalf("CanTransitionOrderStatus(%q, %q)=%v, want %v", tt.from, tt.to, got, tt.want)
			}
		})
	}
}

func TestParseAdmission(t *testing.T) {
	tests := []struct {
		raw       string
		giftID    int
		state     OrderStatus
		wantError bool
	}{
		{"3|stock_acquired", 3, OrderStatusStockAcquired, false},
		{"3|pending_payment", 3, OrderStatusPendingPayment, false},
		{"3|paid", 3, OrderStatusPaid, false},
		{"3|cancelled", 3, OrderStatusCancelled, false},
		{"3", 3, OrderStatusPendingPayment, false}, // 旧版 Redis value 兼容。
		{"bad|paid", 0, "", true},
		{"3|unknown", 0, "", true},
	}
	for _, tt := range tests {
		admission, err := parseAdmission(tt.raw)
		if tt.wantError {
			if err == nil {
				t.Fatalf("parseAdmission(%q) expected error", tt.raw)
			}
			continue
		}
		if err != nil {
			t.Fatalf("parseAdmission(%q): %v", tt.raw, err)
		}
		if admission.GiftID != tt.giftID || admission.State != tt.state {
			t.Fatalf("parseAdmission(%q)=%+v, want gift=%d state=%s", tt.raw, admission, tt.giftID, tt.state)
		}
	}
}

// TestRedisPayCancelRace 使用独立 Redis DB 验证真实 Lua 竞态。
// 默认跳过，显式设置 LOTTERY_REDIS_INTEGRATION=1 后运行，不会触碰应用使用的 DB 2。
func TestRedisPayCancelRace(t *testing.T) {
	if os.Getenv("LOTTERY_REDIS_INTEGRATION") != "1" {
		t.Skip("set LOTTERY_REDIS_INTEGRATION=1 to run Redis Lua integration test")
	}
	addr := os.Getenv("LOTTERY_REDIS_TEST_ADDR")
	if addr == "" {
		addr = "127.0.0.1:6379"
	}
	client := redis.NewClient(&redis.Options{Addr: addr, DB: 15})
	if err := client.Ping().Err(); err != nil {
		t.Fatalf("connect redis test db: %v", err)
	}
	oldClient := GiftRedis
	GiftRedis = client
	defer func() {
		GiftRedis = oldClient
		_ = client.Close()
	}()

	base := int(time.Now().UnixNano() % 1000000000)
	for i := 0; i < 50; i++ {
		uid := base + i + 1
		giftID := base + i + 1000
		stockKey := INVENTORY_PREFIX + strconv.Itoa(giftID)
		admissionKey := TEMP_ORDER_PREFIX + strconv.Itoa(uid)
		if err := client.Set(stockKey, 1, 0).Err(); err != nil {
			t.Fatal(err)
		}
		defer client.Del(stockKey, admissionKey)

		status, err := TryAcquireLotteryAdmission(uid, giftID, time.Minute)
		if err != nil || status != AdmissionAcquired {
			t.Fatalf("acquire iteration %d: status=%s err=%v", i, status, err)
		}
		if duplicate, duplicateErr := TryAcquireLotteryAdmission(uid, giftID, time.Minute); duplicate != AdmissionDuplicate || !errors.Is(duplicateErr, ErrAdmissionDuplicate) {
			t.Fatalf("duplicate acquire iteration %d: status=%s err=%v", i, duplicate, duplicateErr)
		}
		if stock, _ := client.Get(stockKey).Int(); stock != 0 {
			t.Fatalf("duplicate acquire iteration %d changed stock to %d", i, stock)
		}
		if ok, err := MarkLotteryAdmissionPendingPayment(uid, giftID); err != nil || !ok {
			t.Fatalf("mark pending iteration %d: ok=%v err=%v", i, ok, err)
		}

		var claimed, released bool
		var claimErr, releaseErr error
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			claimed, claimErr = ClaimLotteryAdmission(uid, giftID)
		}()
		go func() {
			defer wg.Done()
			released, releaseErr = ReleaseLotteryAdmission(uid, giftID)
		}()
		wg.Wait()
		if claimErr != nil || releaseErr != nil {
			t.Fatalf("race iteration %d: claimErr=%v releaseErr=%v", i, claimErr, releaseErr)
		}
		if claimed == released {
			t.Fatalf("race iteration %d: exactly one terminal transition must win, claimed=%v released=%v", i, claimed, released)
		}

		admission, err := GetLotteryAdmission(uid)
		if err != nil {
			t.Fatal(err)
		}
		stock, err := client.Get(stockKey).Int()
		if err != nil {
			t.Fatal(err)
		}
		if claimed && (admission.State != OrderStatusPaid || stock != 0) {
			t.Fatalf("paid invariant iteration %d: state=%s stock=%d", i, admission.State, stock)
		}
		if released && (admission.State != OrderStatusCancelled || stock != 1) {
			t.Fatalf("cancelled invariant iteration %d: state=%s stock=%d", i, admission.State, stock)
		}
		if again, err := ReleaseLotteryAdmission(uid, giftID); err != nil || again {
			t.Fatalf("second release iteration %d must be idempotent: released=%v err=%v", i, again, err)
		}
		if after, _ := client.Get(stockKey).Int(); after != stock {
			t.Fatalf("second release iteration %d changed stock: before=%d after=%d", i, stock, after)
		}
	}
}

// TestMySQLPayCancelRace 在显式提供的隔离 MySQL 中验证事务扣减，以及支付/取消条件更新只有一方获胜。
func TestMySQLPayCancelRace(t *testing.T) {
	dsn := os.Getenv("LOTTERY_MYSQL_STATE_TEST_DSN")
	if dsn == "" {
		t.Skip("set LOTTERY_MYSQL_STATE_TEST_DSN to run MySQL state-machine integration test")
	}
	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{SkipDefaultTransaction: true, Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("connect mysql state test: %v", err)
	}
	for _, ddl := range []string{
		`DROP TABLE IF EXISTS orders`,
		`DROP TABLE IF EXISTS inventory`,
		`CREATE TABLE inventory (
            id int PRIMARY KEY,
            count int NOT NULL,
            cache_stock int NOT NULL
        )`,
		`CREATE TABLE orders (
            id int AUTO_INCREMENT PRIMARY KEY,
            activity_id int NOT NULL,
            gift_id int NOT NULL,
            user_id int NOT NULL,
            count int NOT NULL,
            create_time datetime DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_activity_user (activity_id, user_id)
        )`,
		`INSERT INTO inventory(id, count, cache_stock) VALUES (1, 1, 1)`,
		`INSERT INTO orders(activity_id, gift_id, user_id, count) VALUES (1, 1, 999999, 1)`,
	} {
		if err := db.Exec(ddl).Error; err != nil {
			t.Fatalf("prepare mysql state test: %v", err)
		}
	}

	store := NewStore(db)
	if err := store.EnsureOrderSchema(); err != nil {
		t.Fatalf("migrate legacy order schema: %v", err)
	}
	legacy, err := store.FindOrder(1, 999999)
	if err != nil {
		t.Fatalf("read migrated legacy order: %v", err)
	}
	if legacy.Status != OrderStatusPaid || legacy.InventoryMode != InventoryModeRedis {
		t.Fatalf("legacy order migration=%+v, want paid/redis", legacy)
	}
	oldRedis := GiftRedis
	GiftRedis = nil
	defer func() { GiftRedis = oldRedis }()

	for i := 0; i < 50; i++ {
		if err := db.Exec("DELETE FROM orders").Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Exec("UPDATE inventory SET cache_stock = 1 WHERE id = 1").Error; err != nil {
			t.Fatal(err)
		}
		order, soldOut, duplicated, _, err := store.AcquireMySQLStockAndCreatePendingOrder(1, i+1, 1, time.Now().Add(time.Minute))
		if err != nil || soldOut || duplicated {
			t.Fatalf("acquire iteration %d: order=%+v soldOut=%v duplicated=%v err=%v", i, order, soldOut, duplicated, err)
		}
		duplicateOrder, duplicateSoldOut, duplicate, _, duplicateErr := store.AcquireMySQLStockAndCreatePendingOrder(1, i+1, 1, time.Now().Add(time.Minute))
		if duplicateErr != nil || duplicateSoldOut || !duplicate || duplicateOrder.Id != order.Id {
			t.Fatalf("duplicate acquire iteration %d: order=%+v soldOut=%v duplicated=%v err=%v", i, duplicateOrder, duplicateSoldOut, duplicate, duplicateErr)
		}

		start := make(chan struct{})
		var paidOrder, cancelledOrder *Order
		var paid, cancelled bool
		var payErr, cancelErr error
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			paidOrder, paid, payErr = store.TransitionPendingOrderToPaid(order.Id)
		}()
		go func() {
			defer wg.Done()
			<-start
			cancelledOrder, cancelled, cancelErr = store.CancelMySQLOrderAndRestoreStock(order.Id, "race_test")
		}()
		close(start)
		wg.Wait()
		if payErr != nil || cancelErr != nil {
			t.Fatalf("race iteration %d: payErr=%v cancelErr=%v", i, payErr, cancelErr)
		}
		if paid == cancelled {
			t.Fatalf("race iteration %d: exactly one transition must win, paid=%v cancelled=%v paidOrder=%+v cancelledOrder=%+v", i, paid, cancelled, paidOrder, cancelledOrder)
		}

		finalOrder, err := store.findOrderByID(order.Id)
		if err != nil {
			t.Fatal(err)
		}
		var stock int
		if err := db.Raw("SELECT cache_stock FROM inventory WHERE id = 1").Scan(&stock).Error; err != nil {
			t.Fatal(err)
		}
		if paid && (finalOrder.Status != OrderStatusPaid || stock != 0) {
			t.Fatalf("paid invariant iteration %d: state=%s stock=%d", i, finalOrder.Status, stock)
		}
		if cancelled && (finalOrder.Status != OrderStatusCancelled || !finalOrder.StockReleased || stock != 1) {
			t.Fatalf("cancelled invariant iteration %d: order=%+v stock=%d", i, finalOrder, stock)
		}
	}
}
