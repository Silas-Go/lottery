package database

import (
	"errors"
	"fmt"
	"log/slog"

	mysqlDriver "github.com/go-sql-driver/mysql"
)

const (
	// DefaultActivityID 是当前演示项目的默认活动 ID。
	// 先不引入完整活动表，是为了保持个人项目结构轻量；但订单唯一约束必须带活动维度，
	// 否则用户历史订单会影响后续活动，也无法证明“同一活动内只中奖一次”。
	DefaultActivityID = 1
)

// Order 表示用户最终支付完成后的正式订单。
// Redis 只负责高并发临时资格，最终是否中奖以 orders 中的记录为准。
type Order struct {
	Id int

	// ActivityId 表示活动 ID。
	// 当前项目只有一个默认活动，但唯一约束必须包含活动维度，避免历史订单影响下一场活动。
	ActivityId int

	// GiftId 表示 gift id，即奖品 ID，对应 inventory.id。
	GiftId int

	// UserId 表示 user id，即参与秒杀的用户 ID。
	UserId int

	// Count 表示订单购买数量。
	// 当前秒杀链路一次只发一份资格，所以固定为 1；保留字段是为了和库存聚合语义一致。
	Count int
}

type giftOrderCount struct {
	GiftId int
	Total  int
}

// EnsureOrderSchema 确保订单表具备当前秒杀链路需要的兜底约束。
// init.sql 只会在全新数据卷中执行；老数据卷升级时必须在应用启动阶段补齐字段和唯一索引，
// 否则 Redis 防重一旦失效，MySQL 无法兜住重复中奖。
func (s *Store) EnsureOrderSchema() error {
	if err := s.ensureColumn("orders", "activity_id", "ALTER TABLE orders ADD COLUMN activity_id int NOT NULL DEFAULT 1 COMMENT '活动id' AFTER id"); err != nil {
		return err
	}
	if err := s.ensureIndex("orders", "uk_activity_user", "ALTER TABLE orders ADD UNIQUE KEY uk_activity_user (activity_id, user_id)"); err != nil {
		return err
	}
	return nil
}

// CreateOrder 写入用户在当前活动中的正式订单。
//
// 参数语义:
//
//	activityID 活动 ID，用来隔离不同秒杀活动的参与记录。
//	userid     user id，用户 ID；当前活动内同一用户只能有一条正式订单。
//	giftid     gift id，奖品 ID；表示用户最终获得哪个奖品。
//
// MySQL 唯一索引是 Redis 防重之外的最后兜底；如果并发或重试绕过了临时资格，
// 唯一索引会拒绝同一用户在同一活动重复落库。
// 返回值中的 duplicated 表示命中了唯一索引，调用方要把本次已经 claim 的 Redis 库存回补。
func (s *Store) CreateOrder(activityID, userid, giftid int) (int, bool, error) {
	order := Order{ActivityId: activityID, GiftId: giftid, UserId: userid, Count: 1}
	if err := s.db.Create(&order).Error; err != nil {
		if isDuplicateKey(err) {
			slog.Warn("create order skipped duplicate user", "activity_id", activityID, "userid", userid, "giftid", giftid, "error", err)
			return 0, true, nil
		}
		slog.Error("create order failed", "error", err, "activity_id", activityID, "userid", userid, "giftid", giftid)
		return 0, false, err
	}
	return order.Id, false, nil
}

// HasOrder 判断用户在当前活动中是否已经有正式订单。
//
// 参数语义:
//
//	activityID 活动 ID。
//	userid     user id，用户 ID。
//
// 抽奖入口先查一次数据库，可以避免已支付用户再次进入 Redis 预扣库存；
// MySQL 唯一索引仍然保留，负责兜住并发竞态和接口重试。
func (s *Store) HasOrder(activityID, userid int) (bool, error) {
	var count int64
	err := s.db.Model(&Order{}).
		Where("activity_id = ? AND user_id = ?", activityID, userid).
		Count(&count).Error
	if err != nil {
		slog.Error("check order existence failed", "activity_id", activityID, "userid", userid, "error", err)
		return false, fmt.Errorf("check order existence: %w", err)
	}
	return count > 0, nil
}

// CompletedOrderCounts 统计当前活动每个奖品已经完成的订单数。
//
// 返回 map 的 key 是 gift id，value 是该奖品已完成订单数量。
// Redis 库存恢复必须扣掉这些正式订单，否则应用重启会把已经卖出的库存重新放回 Redis。
func (s *Store) CompletedOrderCounts(activityID int) (map[int]int, error) {
	var rows []giftOrderCount
	err := s.db.Model(&Order{}).
		Select("gift_id, COALESCE(SUM(count), 0) AS total").
		Where("activity_id = ?", activityID).
		Group("gift_id").
		Scan(&rows).Error
	if err != nil {
		slog.Error("load completed order counts failed", "activity_id", activityID, "error", err)
		return nil, fmt.Errorf("load completed order counts: %w", err)
	}

	counts := make(map[int]int, len(rows))
	for _, row := range rows {
		counts[row.GiftId] = row.Total
	}
	return counts, nil
}

// ClearOrders 清除全部订单记录。
// 该函数只用于本地测试或重新压测前清理数据，不应该出现在正式业务链路中。
func (s *Store) ClearOrders() error {
	return s.db.Where("id>0").Delete(Order{}).Error
}

// ResetOrders 清空订单表并重置自增 ID。
// 实验 reset 需要连订单主键一起回到初始状态，避免下一轮录屏还带着上一轮的订单 ID 增长痕迹。
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
		slog.Error("ensure column failed", "table", table, "column", column, "error", err)
		return fmt.Errorf("ensure column %s.%s: %w", table, column, err)
	}
	slog.Info("database column ensured", "table", table, "column", column)
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
		slog.Error("ensure index failed", "table", table, "index", index, "error", err)
		return fmt.Errorf("ensure index %s.%s: %w", table, index, err)
	}
	slog.Info("database index ensured", "table", table, "index", index)
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
