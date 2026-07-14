package database

import (
	"errors"
	"fmt"
	"log/slog"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"
	"gorm.io/gorm"
)

const (
	// DefaultActivityID 是当前演示项目的默认活动 ID。
	DefaultActivityID = 1
)

// CanTransitionOrderStatus 定义统一业务状态机的单向合法边。
// 同状态重试属于幂等读取，不算新的迁移；paid/cancelled 都不能再离开终态。
func CanTransitionOrderStatus(from, to OrderStatus) bool {
	switch from {
	case OrderStatusStockAcquired:
		return to == OrderStatusPendingPayment || to == OrderStatusCancelled
	case OrderStatusPendingPayment:
		return to == OrderStatusPaid || to == OrderStatusCancelled
	default:
		return false
	}
}

// OrderStatus 是两个库存模式共同使用的订单业务状态。
// stock_acquired 主要存在于 Redis admission 中；MySQL 账本从 pending_payment 开始持久化，
// paid 和 cancelled 是互斥终态，任何迟到消息都不能把终态改回 pending_payment。
type OrderStatus string

const (
	OrderStatusStockAcquired  OrderStatus = "stock_acquired"
	OrderStatusPendingPayment OrderStatus = "pending_payment"
	OrderStatusPaid           OrderStatus = "paid"
	OrderStatusCancelled      OrderStatus = "cancelled"
)

// InventoryMode 标识订单占用的是哪一套权威库存，取消时必须据此选择唯一的回补路径。
type InventoryMode string

const (
	InventoryModeRedis InventoryMode = "redis"
	InventoryModeMySQL InventoryMode = "mysql"
)

var ErrOrderNotFound = errors.New("order not found")

// Order 是 MySQL 中的订单最终账本。
// 两个模式共享相同状态机；差别只在 pending_payment 之前如何取得库存以及如何建立账本。
type Order struct {
	Id int

	ActivityId int
	GiftId     int
	UserId     int
	Count      int

	Status        OrderStatus
	InventoryMode InventoryMode
	StockReleased bool
	ExpiresAt     time.Time
	PaidAt        *time.Time
	CancelledAt   *time.Time
	CancelReason  string
	CreateTime    time.Time `gorm:"column:create_time;autoCreateTime"`
	UpdateTime    time.Time `gorm:"column:update_time;autoUpdateTime"`
}

type giftOrderCount struct {
	GiftId int
	Total  int
}

// EnsureOrderSchema 为新旧数据卷补齐统一订单状态机字段。
// status 默认 paid 是为了把升级前已经存在的“最终订单”保持为终态；新订单会显式写 pending_payment。
func (s *Store) EnsureOrderSchema() error {
	columns := []struct {
		name string
		ddl  string
	}{
		{"activity_id", "ALTER TABLE orders ADD COLUMN activity_id int NOT NULL DEFAULT 1 COMMENT '活动id' AFTER id"},
		{"status", "ALTER TABLE orders ADD COLUMN status varchar(32) NOT NULL DEFAULT 'paid' COMMENT '订单状态' AFTER count"},
		{"inventory_mode", "ALTER TABLE orders ADD COLUMN inventory_mode varchar(16) NOT NULL DEFAULT 'redis' COMMENT '库存模式' AFTER status"},
		{"stock_released", "ALTER TABLE orders ADD COLUMN stock_released tinyint(1) NOT NULL DEFAULT 0 COMMENT '取消库存是否已回补' AFTER inventory_mode"},
		{"expires_at", "ALTER TABLE orders ADD COLUMN expires_at datetime NULL COMMENT '支付截止时间' AFTER stock_released"},
		{"paid_at", "ALTER TABLE orders ADD COLUMN paid_at datetime NULL COMMENT '支付完成时间' AFTER expires_at"},
		{"cancelled_at", "ALTER TABLE orders ADD COLUMN cancelled_at datetime NULL COMMENT '取消时间' AFTER paid_at"},
		{"cancel_reason", "ALTER TABLE orders ADD COLUMN cancel_reason varchar(64) NOT NULL DEFAULT '' COMMENT '取消原因' AFTER cancelled_at"},
		{"update_time", "ALTER TABLE orders ADD COLUMN update_time datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '订单更新时间' AFTER create_time"},
	}
	for _, column := range columns {
		if err := s.ensureColumn("orders", column.name, column.ddl); err != nil {
			return err
		}
	}
	if err := s.ensureIndex("orders", "uk_activity_user", "ALTER TABLE orders ADD UNIQUE KEY uk_activity_user (activity_id, user_id)"); err != nil {
		return err
	}
	return s.ensureIndex("orders", "idx_status_expires", "ALTER TABLE orders ADD KEY idx_status_expires (status, expires_at)")
}

// CreatePendingOrder 建立统一状态机中的待支付订单。
// duplicated=true 表示同一活动、同一用户的账本已经存在；调用方必须读取原状态，绝不能覆盖终态。
func (s *Store) CreatePendingOrder(activityID, userID, giftID int, mode InventoryMode, expiresAt time.Time) (*Order, bool, error) {
	order := &Order{
		ActivityId:    activityID,
		GiftId:        giftID,
		UserId:        userID,
		Count:         1,
		Status:        OrderStatusPendingPayment,
		InventoryMode: mode,
		ExpiresAt:     expiresAt,
	}
	if err := s.db.Create(order).Error; err != nil {
		if isDuplicateKey(err) {
			existing, findErr := s.FindOrder(activityID, userID)
			if findErr != nil {
				return nil, true, findErr
			}
			return existing, true, nil
		}
		slog.Error("create pending order failed", "activity_id", activityID, "uid", userID, "gid", giftID, "inventory_mode", mode, "error", err)
		return nil, false, fmt.Errorf("create pending order: %w", err)
	}
	return order, false, nil
}

// CreateOrder 保留旧调用兼容语义：直接写入一条已支付终态订单。
// 新秒杀链路不得调用它，应先 CreatePendingOrder，再通过条件状态迁移进入 paid。
func (s *Store) CreateOrder(activityID, userID, giftID int) (int, bool, error) {
	now := time.Now()
	order := &Order{
		ActivityId:    activityID,
		GiftId:        giftID,
		UserId:        userID,
		Count:         1,
		Status:        OrderStatusPaid,
		InventoryMode: InventoryModeRedis,
		ExpiresAt:     now,
		PaidAt:        &now,
	}
	if err := s.db.Create(order).Error; err != nil {
		if isDuplicateKey(err) {
			return 0, true, nil
		}
		return 0, false, fmt.Errorf("create paid order: %w", err)
	}
	return order.Id, false, nil
}

// FindOrder 返回用户在当前活动中的唯一订单账本。
func (s *Store) FindOrder(activityID, userID int) (*Order, error) {
	var order Order
	err := s.db.Where("activity_id = ? AND user_id = ?", activityID, userID).First(&order).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrOrderNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("find order: %w", err)
	}
	return &order, nil
}

// HasOrder 判断用户是否已经参与过当前活动。
// cancelled 也是一次已经结束的参与，默认一人一单规则不允许通过取消复活或重新抢购。
func (s *Store) HasOrder(activityID, userID int) (bool, error) {
	var count int64
	err := s.db.Model(&Order{}).
		Where("activity_id = ? AND user_id = ?", activityID, userID).
		Count(&count).Error
	if err != nil {
		return false, fmt.Errorf("check order existence: %w", err)
	}
	return count > 0, nil
}

// TransitionPendingOrderToPaid 只允许 pending_payment -> paid。
// 条件更新是 MySQL 模式下支付与取消的并发裁决点；重复支付读取 paid 后按幂等成功处理。
func (s *Store) TransitionPendingOrderToPaid(orderID int) (*Order, bool, error) {
	now := time.Now()
	result := s.db.Model(&Order{}).
		Where("id = ? AND status = ?", orderID, OrderStatusPendingPayment).
		Updates(map[string]any{
			"status":      OrderStatusPaid,
			"paid_at":     now,
			"update_time": now,
		})
	if result.Error != nil {
		return nil, false, fmt.Errorf("transition order to paid: %w", result.Error)
	}
	order, err := s.findOrderByID(orderID)
	if err != nil {
		return nil, false, err
	}
	return order, result.RowsAffected == 1, nil
}

// RecordReleasedRedisCancellation 把 Redis 已经裁决成功的取消结果写入 MySQL 最终账本。
// Redis Lua 已经把 admission 改为 cancelled 并且只回补一次库存，所以这里绝不能再次操作库存。
func (s *Store) RecordReleasedRedisCancellation(activityID, userID, giftID int, expiresAt time.Time, reason string) (*Order, bool, error) {
	now := time.Now()
	updates := map[string]any{
		"status":         OrderStatusCancelled,
		"stock_released": true,
		"cancelled_at":   now,
		"cancel_reason":  reason,
		"update_time":    now,
	}
	result := s.db.Model(&Order{}).
		Where("activity_id = ? AND user_id = ? AND gift_id = ? AND status IN ?", activityID, userID, giftID,
			[]OrderStatus{OrderStatusStockAcquired, OrderStatusPendingPayment}).
		Updates(updates)
	if result.Error != nil {
		return nil, false, fmt.Errorf("record redis cancellation: %w", result.Error)
	}
	if result.RowsAffected == 1 {
		order, err := s.FindOrder(activityID, userID)
		return order, true, err
	}

	existing, err := s.FindOrder(activityID, userID)
	if err == nil {
		if existing.GiftId != giftID || existing.InventoryMode != InventoryModeRedis {
			return nil, false, fmt.Errorf("redis cancellation conflicts with existing order id=%d mode=%s gift=%d", existing.Id, existing.InventoryMode, existing.GiftId)
		}
		if existing.Status == OrderStatusPaid {
			return nil, false, fmt.Errorf("cannot record cancelled over paid order id=%d", existing.Id)
		}
		if existing.Status == OrderStatusCancelled && !existing.StockReleased {
			if updateErr := s.db.Model(&Order{}).Where("id = ? AND status = ?", existing.Id, OrderStatusCancelled).
				Updates(map[string]any{"stock_released": true, "update_time": now}).Error; updateErr != nil {
				return nil, false, fmt.Errorf("mark cancelled redis stock released: %w", updateErr)
			}
			existing.StockReleased = true
		}
		return existing, false, nil
	}
	if !errors.Is(err, ErrOrderNotFound) {
		return nil, false, err
	}

	order := &Order{
		ActivityId:    activityID,
		GiftId:        giftID,
		UserId:        userID,
		Count:         1,
		Status:        OrderStatusCancelled,
		InventoryMode: InventoryModeRedis,
		StockReleased: true,
		ExpiresAt:     expiresAt,
		CancelledAt:   &now,
		CancelReason:  reason,
	}
	if createErr := s.db.Create(order).Error; createErr != nil {
		if isDuplicateKey(createErr) {
			// 创建消费者与取消可能同时首次落账；再次执行条件迁移即可收敛到 cancelled。
			return s.RecordReleasedRedisCancellation(activityID, userID, giftID, expiresAt, reason)
		}
		return nil, false, fmt.Errorf("create cancelled redis order: %w", createErr)
	}
	return order, true, nil
}

// CancelMySQLOrderAndRestoreStock 在同一个数据库事务中完成 pending_payment -> cancelled 和库存回补。
// 两步不可拆开，否则崩溃会留下“订单已取消但库存未回”或“库存已回但订单仍可支付”的状态。
func (s *Store) CancelMySQLOrderAndRestoreStock(orderID int, reason string) (*Order, bool, error) {
	var transitioned bool
	err := s.db.Transaction(func(tx *gorm.DB) error {
		now := time.Now()
		result := tx.Model(&Order{}).
			Where("id = ? AND inventory_mode = ? AND status = ?", orderID, InventoryModeMySQL, OrderStatusPendingPayment).
			Updates(map[string]any{
				"status":         OrderStatusCancelled,
				"stock_released": true,
				"cancelled_at":   now,
				"cancel_reason":  reason,
				"update_time":    now,
			})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return nil
		}

		var order Order
		if err := tx.First(&order, orderID).Error; err != nil {
			return err
		}
		stock := tx.Exec("UPDATE inventory SET cache_stock = cache_stock + ? WHERE id = ?", order.Count, order.GiftId)
		if stock.Error != nil {
			return stock.Error
		}
		if stock.RowsAffected != 1 {
			return fmt.Errorf("restore mysql inventory affected %d rows", stock.RowsAffected)
		}
		transitioned = true
		return nil
	})
	if err != nil {
		return nil, false, fmt.Errorf("cancel mysql order and restore stock: %w", err)
	}
	order, err := s.findOrderByID(orderID)
	if err != nil {
		return nil, false, err
	}
	if transitioned && GiftRedis != nil {
		if err := GiftRedis.Del(CACHE_ALL_STOCK_KEY).Err(); err != nil {
			slog.Warn("delete cache-aside stock cache after cancellation failed", "order_id", orderID, "error", err)
		}
	}
	return order, transitioned, nil
}

// CompletedOrderCounts 返回 Redis 模式下仍然占用库存的订单数量。
// cancelled 已经回补，不得再从启动库存中扣除；MySQL 模式使用独立的 cache_stock，也不能影响 Redis 基线。
func (s *Store) CompletedOrderCounts(activityID int) (map[int]int, error) {
	var rows []giftOrderCount
	err := s.db.Model(&Order{}).
		Select("gift_id, COALESCE(SUM(count), 0) AS total").
		Where("activity_id = ? AND inventory_mode = ? AND status IN ?", activityID, InventoryModeRedis,
			[]OrderStatus{OrderStatusPendingPayment, OrderStatusPaid}).
		Group("gift_id").
		Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("load redis reserved order counts: %w", err)
	}

	counts := make(map[int]int, len(rows))
	for _, row := range rows {
		counts[row.GiftId] = row.Total
	}
	return counts, nil
}

func (s *Store) findOrderByID(orderID int) (*Order, error) {
	var order Order
	if err := s.db.First(&order, orderID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrOrderNotFound
		}
		return nil, fmt.Errorf("find order by id: %w", err)
	}
	return &order, nil
}

// ClearOrders 清除全部订单记录，只用于测试或实验重置。
func (s *Store) ClearOrders() error {
	return s.db.Where("id>0").Delete(Order{}).Error
}

// ResetOrders 清空订单表并重置自增 ID，只用于本地实验重置。
func (s *Store) ResetOrders() error {
	if err := s.db.Exec("DELETE FROM orders").Error; err != nil {
		return fmt.Errorf("delete orders: %w", err)
	}
	if err := s.db.Exec("ALTER TABLE orders AUTO_INCREMENT = 1").Error; err != nil {
		return fmt.Errorf("reset orders auto increment: %w", err)
	}
	return nil
}

func (s *Store) ensureColumn(table, column, ddl string) error {
	exists, err := s.columnExists(table, column)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	if err := s.db.Exec(ddl).Error; err != nil {
		return fmt.Errorf("ensure column %s.%s: %w", table, column, err)
	}
	return nil
}

func (s *Store) ensureIndex(table, index, ddl string) error {
	exists, err := s.indexExists(table, index)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	if err := s.db.Exec(ddl).Error; err != nil {
		return fmt.Errorf("ensure index %s.%s: %w", table, index, err)
	}
	return nil
}

func (s *Store) columnExists(table, column string) (bool, error) {
	var count int64
	err := s.db.Raw(`
SELECT COUNT(*)
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = ?
  AND COLUMN_NAME = ?`, table, column).Scan(&count).Error
	if err != nil {
		return false, fmt.Errorf("check column %s.%s: %w", table, column, err)
	}
	return count > 0, nil
}

func (s *Store) indexExists(table, index string) (bool, error) {
	var count int64
	err := s.db.Raw(`
SELECT COUNT(*)
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = ?
  AND INDEX_NAME = ?`, table, index).Scan(&count).Error
	if err != nil {
		return false, fmt.Errorf("check index %s.%s: %w", table, index, err)
	}
	return count > 0, nil
}

func isDuplicateKey(err error) bool {
	var mysqlErr *mysqlDriver.MySQLError
	return errors.As(err, &mysqlErr) && mysqlErr.Number == 1062
}
