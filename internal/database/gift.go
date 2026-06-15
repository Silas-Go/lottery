package database

import (
	"fmt"
	"log/slog"
)

// EMPTY_GIFT 表示空奖品“谢谢参与”的固定 gift id。
// 这里保留常量，是为了在业务讲解时明确：不是所有抽奖结果都代表真实实物奖品。
const EMPTY_GIFT = 1

// Gift 表示奖品配置和初始库存。
// 该结构体映射 MySQL 的 inventory 表；其中 Count 是活动初始库存，不是 Redis 实时库存。
type Gift struct {
	Id int

	// Name 是奖品名称，例如“手机”“水杯”。
	Name string

	// Price 是奖品价值，单位按项目页面展示理解为元。
	Price int

	// Picture 是前端展示图片路径，对应 views/img 下的静态资源。
	Picture string

	// Count 是 MySQL 中配置的活动初始库存。
	// 秒杀运行时的可抢库存以 Redis gift_count_{giftID} 为准。
	Count int
}

// TableName 指定 Gift 使用 inventory 表。
// 结构体名是 Gift，但历史建表名是 inventory；显式指定可以避免 GORM 推断成 gifts。
func (Gift) TableName() string {
	return "inventory"
}

// GetAllGifts 返回 MySQL 中的全部奖品配置。
// 这是兼容旧调用的便捷方法，失败时只返回空结果；关键链路应优先使用 GetAllGiftsWithError。
func (s *Store) GetAllGifts() []*Gift {
	gifts, _ := s.GetAllGiftsWithError()
	return gifts
}

// GetAllGiftsWithError 返回 MySQL 中的全部奖品配置。
// 该函数读取的是配置和初始库存，不代表当前 Redis 可抢库存。
func (s *Store) GetAllGiftsWithError() ([]*Gift, error) {
	var gifts []*Gift
	err := s.db.Select("*").Find(&gifts).Error
	if err != nil {
		slog.Error("scan table inventory failed", "error", err)
		return nil, fmt.Errorf("scan inventory table: %w", err)
	}
	return gifts, nil
}

// GetGift 按 gift id 查询奖品配置。
// 这是兼容旧调用的便捷方法，失败时返回 nil；关键链路应优先使用 GetGiftWithError。
func (s *Store) GetGift(id int) *Gift {
	gift, _ := s.GetGiftWithError(id)
	return gift
}

// GetGiftWithError 按 gift id 查询奖品配置。
// 抽奖成功后需要用它把 Redis 中的 gift id 转成前端可展示的名称、价格和图片。
func (s *Store) GetGiftWithError(id int) (*Gift, error) {
	gift := Gift{Id: id}
	err := s.db.Select("*").Find(&gift).Error
	if err != nil {
		slog.Error("get gift by id failed", "error", err, "gid", id)
		return nil, fmt.Errorf("get gift by id %d: %w", id, err)
	}
	if gift.Id == 0 {
		err := fmt.Errorf("gift %d not found", id)
		slog.Error("get gift by id failed", "error", err, "gid", id)
		return nil, err
	}
	return &gift, nil
}
