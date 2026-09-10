package service

import (
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-redis/redis"
	driver "github.com/go-sql-driver/mysql"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"silas/internal/database"
	"silas/internal/metrics"
)

// TestOrderIdentityReplay 在专用测试库中重放跨轮消息；默认不访问运行中的实验数据。
func TestOrderIdentityReplay(t *testing.T) {
	dsn, addr := os.Getenv("LOTTERY_IDENTITY_MYSQL_DSN"), os.Getenv("LOTTERY_REDIS_TEST_ADDR")
	if dsn == "" || addr == "" {
		t.Skip("requires dedicated identity MySQL and Redis test services")
	}
	cfg, err := driver.ParseDSN(dsn)
	if err != nil || !strings.HasPrefix(cfg.DBName, "lottery_identity_test_") {
		t.Fatal("refusing non-test MySQL database")
	}
	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	defer sqlDB.Close()
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	// 从旧表结构升级，验证已有数据卷也能补齐身份字段和唯一索引。
	check(db.Exec("DROP TABLE IF EXISTS orders").Error)
	check(db.Exec("CREATE TABLE orders (id int AUTO_INCREMENT PRIMARY KEY, gift_id int NOT NULL, user_id int NOT NULL, count int NOT NULL DEFAULT 1, create_time datetime DEFAULT CURRENT_TIMESTAMP)").Error)
	store := database.NewStore(db)
	check(store.EnsureOrderSchema())
	check(store.EnsureOrderSchema())
	client := redis.NewClient(&redis.Options{Addr: addr, DB: 14})
	check(client.Ping().Err())
	oldClient := database.GiftRedis
	database.GiftRedis = client
	defer func() { database.GiftRedis = oldClient; client.Close() }()
	const uid, gid = 19990001, 4
	stockKey, admissionKey := database.INVENTORY_PREFIX+"4", database.TEMP_ORDER_PREFIX+"19990001"
	previousRun, runErr := client.Get(database.SeckillRunKey).Result()
	defer func() {
		client.Del(stockKey, admissionKey)
		if runErr == nil {
			client.Set(database.SeckillRunKey, previousRun, 0)
		} else {
			client.Del(database.SeckillRunKey)
		}
	}()
	service := NewOrderService(store)
	reset := func() {
		defer database.BeginSeckillReset()()
		check(store.ResetOrders())
		check(database.RotateSeckillRun())
		check(client.Del(admissionKey).Err())
		check(client.Set(stockKey, 1, 0).Err())
		run, err := database.CurrentSeckillRun()
		check(err)
		metrics.SetSeckillRunID(run)
		metrics.ResetAll(1, 1)
	}
	acquire := func(expiry time.Time) database.Order {
		run, err := database.CurrentSeckillRun()
		check(err)
		id, err := database.NewIdentityID()
		check(err)
		command := database.Order{OrderID: id, RunID: run, ActivityId: 1, GiftId: gid, UserId: uid, Count: 1, ExpiresAt: expiry}
		result, err := database.TryAcquireLotteryAdmission(uid, gid, time.Hour, command.Identity())
		check(err)
		if result != database.AdmissionAcquired {
			t.Fatalf("acquire=%s", result)
		}
		// 使用真实消息结构的 JSON 往返，防止身份字段在传输中丢失。
		body, err := json.Marshal(command)
		check(err)
		var decoded database.Order
		check(json.Unmarshal(body, &decoded))
		if decoded.Identity() != command.Identity() {
			t.Fatal("message lost identity")
		}
		return decoded
	}
	assertState := func(command database.Order, status database.OrderStatus, stock int) {
		t.Helper()
		order, err := store.FindOrderIdentity(1, uid, command.Identity())
		check(err)
		admission, err := database.GetLotteryAdmission(uid)
		check(err)
		actual, err := client.Get(stockKey).Int()
		check(err)
		if order.Status != status || !admission.Matches(gid, command.Identity()) || admission.State != status || actual != stock {
			t.Fatalf("order=%+v admission=%+v stock=%d want=%s/%d", order, admission, actual, status, stock)
		}
	}
	reset()
	old := acquire(time.Now().Add(-time.Minute))
	check(service.CreateRedisPendingOrder(old))
	oldLedger, err := store.FindOrderIdentity(1, uid, old.Identity())
	check(err)
	reset()
	current := acquire(time.Now().Add(time.Hour))
	check(service.CreateRedisPendingOrder(current))
	newLedger, err := store.FindOrderIdentity(1, uid, current.Identity())
	check(err)
	if oldLedger.Id != newLedger.Id {
		t.Fatal("fixture must reproduce reused auto increment ID")
	}
	legacy := old
	legacy.OrderID = ""
	legacy.RunID = ""
	sameRunWrongOrder := old
	sameRunWrongOrder.RunID = current.RunID
	for _, stale := range []database.Order{old, legacy, sameRunWrongOrder} {
		check(service.CreateRedisPendingOrder(stale))
		released, err := service.TimeoutCancel(stale)
		check(err)
		if released {
			t.Fatal("old message restored new stock")
		}
		if service.Pay(uid, gid, stale.Identity()) == nil || service.GiveUp(uid, gid, stale.Identity()) == nil {
			t.Fatal("old client operated new order")
		}
		assertState(current, database.OrderStatusPendingPayment, 0)
	}
	for i := 0; i < 3; i++ {
		check(service.CreateRedisPendingOrder(current))
	}
	if got := metrics.SnapshotNow().CreateOrderConsumed; got != 1 {
		t.Fatalf("duplicate create metric=%d", got)
	}
	if _, _, err := store.RecordReleasedRedisCancellation(1, uid, gid, old.ExpiresAt, "stale", old.Identity()); err == nil {
		t.Fatal("stale cancellation overwrote current ledger")
	}
	assertState(current, database.OrderStatusPendingPayment, 0)
	if err := service.Pay(uid, gid, current.Identity()); err != nil {
		t.Fatal(err)
	}
	expiredCurrent := current
	expiredCurrent.ExpiresAt = time.Now().Add(-time.Minute)
	released, err := service.TimeoutCancel(expiredCurrent)
	check(err)
	if released {
		t.Fatal("paid order released")
	}
	assertState(current, database.OrderStatusPaid, 0)
	// 超时消息先到、普通落单后到，以及重复超时，均不得复活或重复回补。
	reset()
	cancelled := acquire(time.Now().Add(-time.Minute))
	released, err = service.TimeoutCancel(cancelled)
	check(err)
	if !released {
		t.Fatal("first cancel did not restore")
	}
	released, err = service.TimeoutCancel(cancelled)
	check(err)
	if released {
		t.Fatal("duplicate cancel restored twice")
	}
	check(service.CreateRedisPendingOrder(cancelled))
	assertState(cancelled, database.OrderStatusCancelled, 1)
	if err := service.Pay(uid, gid, cancelled.Identity()); err == nil {
		t.Fatal("cancelled order paid")
	}
	// 新身份下支付/取消并发，终态只能二选一，库存与账本必须一致。
	for i := 0; i < 20; i++ {
		reset()
		raced := acquire(time.Now().Add(time.Hour))
		check(service.CreateRedisPendingOrder(raced))
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); service.Pay(uid, gid, raced.Identity()) }()
		go func() { defer wg.Done(); service.GiveUp(uid, gid, raced.Identity()) }()
		wg.Wait()
		order, err := store.FindOrderIdentity(1, uid, raced.Identity())
		check(err)
		switch order.Status {
		case database.OrderStatusPaid:
			assertState(raced, order.Status, 0)
		case database.OrderStatusCancelled:
			assertState(raced, order.Status, 1)
		default:
			t.Fatalf("unexpected terminal state %s", order.Status)
		}
	}
	// 旧 MySQL 账本仍可超时取消，无须存在 Redis 资格。
	reset()
	check(db.Exec("CREATE TABLE IF NOT EXISTS inventory (id int PRIMARY KEY, cache_stock int NOT NULL)").Error)
	check(db.Exec("REPLACE INTO inventory (id,cache_stock) VALUES (4,0)").Error)
	mysqlOrder, _, err := store.CreatePendingOrder(1, uid, gid, database.InventoryModeMySQL, time.Now().Add(-time.Minute))
	check(err)
	released, err = service.TimeoutCancel(*mysqlOrder)
	check(err)
	if !released {
		t.Fatal("legacy MySQL timeout did not release")
	}
	var mysqlStock int
	check(db.Raw("SELECT cache_stock FROM inventory WHERE id=4").Scan(&mysqlStock).Error)
	if mysqlStock != 1 {
		t.Fatalf("legacy MySQL stock=%d", mysqlStock)
	}
	// 真实建账暂停时，重置必须等消费者完成；重置之后重放旧消息不产生账本。
	reset()
	inFlight := acquire(time.Now().Add(time.Hour))
	entered, resume := make(chan struct{}), make(chan struct{})
	check(db.Callback().Create().Before("gorm:create").Register("identity_barrier", func(tx *gorm.DB) {
		if tx.Statement.Table == "orders" {
			close(entered)
			<-resume
		}
	}))
	done := make(chan error, 1)
	go func() { done <- service.CreateRedisPendingOrder(inFlight) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("create did not enter")
	}
	resetAcquired := make(chan struct{})
	resetDone := make(chan struct{})
	go func() { unlock := database.BeginSeckillReset(); close(resetAcquired); unlock(); close(resetDone) }()
	select {
	case <-resetAcquired:
		t.Fatal("reset entered halfway through consumer")
	case <-time.After(100 * time.Millisecond):
	}
	close(resume)
	check(<-done)
	<-resetDone
	check(db.Callback().Create().Remove("identity_barrier"))
	reset()
	check(service.CreateRedisPendingOrder(inFlight))
	var count int64
	check(db.Model(&database.Order{}).Count(&count).Error)
	if count != 0 {
		t.Fatal("stale create resurrected order")
	}
}
