package database

import (
	"fmt"
	"log/slog"

	"gorm.io/gorm"
)

// Gift 是 inventory 历史表名对应的限量材料配置。
// 内部继续使用 gift id 兼容订单和 Redis key；页面只展示炼金材料，不再暴露旧转盘奖品语义。
type Gift struct {
	Id int

	// Name 是材料名称，例如“月盐”“星髓”。
	Name string

	// Description 是材料在炼金市中的简要业务语义，不参与库存裁决。
	Description string

	// Price 是材料价格，页面按金币展示。
	Price int

	// Picture 是统一风格的材料卡图片路径，对应 views/img 下的静态资源。
	Picture string

	// Count 是 MySQL 中配置的活动初始库存。
	// 秒杀运行时的可抢库存以 Redis gift_count_{giftID} 为准。
	Count int
}

// defaultSeckillMaterialCatalog 是秒杀库存使用的四种炼金材料。
// 名称和价格与 materials 聚合读模型保持一致；count 是独立秒杀活动的库存基线，
// 不复用购买实验的 materials.stock，避免两个实验互相污染。
var defaultSeckillMaterialCatalog = []Gift{
	{Id: 1, Name: "月盐", Description: "月潮退去后留下的低温结晶，稳定、常见且易于计量。", Picture: "img/moon-salt-relic.png", Price: 90, Count: 3000},
	{Id: 2, Name: "雾银", Description: "能在雾中保持镜面反射的液态银，适合镜面术式与感应器。", Picture: "img/mist-silver-relic.png", Price: 360, Count: 1800},
	{Id: 3, Name: "龙息琥珀", Description: "封存古老高温吐息的琥珀核心，为高负荷炼成装置持续供能。", Picture: "img/dragon-breath-amber-relic.png", Price: 1280, Count: 900},
	{Id: 4, Name: "星髓", Description: "从坠星内部提取的高密度魔力介质，仅用于高阶炼成与能量校准。", Picture: "img/star-marrow-relic.png", Price: 5200, Count: 300},
}

// EnsureSeckillMaterialCatalog 为不会重跑 init.sql 的老数据卷迁移限量材料目录。
// 只有目录名称、描述、图片、价格或库存基线不一致时才迁移；正常重启不能重置活动库存。
//
// 旧订单的 gift id 已经对应篮球、茶叶等废弃语义，无法安全映射到新材料。因此迁移时先清掉
// Redis admission，再在同一 MySQL 事务中清空旧实验订单并全量替换 inventory。迟到 MQ 消息
// 因找不到匹配 admission 会被消费者幂等忽略，不能复活旧订单。
func (s *Store) EnsureSeckillMaterialCatalog() (bool, error) {
	if s == nil || s.db == nil {
		return false, fmt.Errorf("ensure seckill material catalog: store is nil")
	}

	var current []Gift
	if err := s.db.Order("id").Find(&current).Error; err != nil {
		return false, fmt.Errorf("load current seckill material catalog: %w", err)
	}
	if seckillMaterialCatalogMatches(current) {
		return false, nil
	}

	// Redis 先清理：如果后续 MySQL 事务失败，下次启动仍会检测到旧目录并重新迁移；
	// 反过来先提交 MySQL，进程崩溃会让旧 admission 带着已被重用的 gid 存活。
	if err := clearLotteryRedisState(); err != nil {
		return false, fmt.Errorf("clear legacy seckill redis state: %w", err)
	}

	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("DELETE FROM orders").Error; err != nil {
			return fmt.Errorf("delete legacy seckill orders: %w", err)
		}
		if err := tx.Exec("DELETE FROM inventory").Error; err != nil {
			return fmt.Errorf("delete legacy inventory catalog: %w", err)
		}
		for i := range defaultSeckillMaterialCatalog {
			material := defaultSeckillMaterialCatalog[i]
			if err := tx.Create(&material).Error; err != nil {
				return fmt.Errorf("insert seckill material %d: %w", material.Id, err)
			}
		}
		// cache_stock 是 MySQL 同步准入模式的实时库存；目录迁移是一轮新实验，
		// 必须与 count 基线同时建立，否则首次请求会立即被误判售罄。
		if err := tx.Exec("UPDATE inventory SET cache_stock = count").Error; err != nil {
			return fmt.Errorf("initialize migrated cache stock: %w", err)
		}
		return nil
	})
	if err != nil {
		return false, err
	}

	slog.Warn("legacy prize catalog migrated to alchemy materials", "material_count", len(defaultSeckillMaterialCatalog))
	return true, nil
}

func seckillMaterialCatalogMatches(current []Gift) bool {
	if len(current) != len(defaultSeckillMaterialCatalog) {
		return false
	}
	for i := range defaultSeckillMaterialCatalog {
		got := current[i]
		want := defaultSeckillMaterialCatalog[i]
		if got.Id != want.Id || got.Name != want.Name || got.Description != want.Description ||
			got.Picture != want.Picture || got.Price != want.Price || got.Count != want.Count {
			return false
		}
	}
	return true
}

// TableName 指定 Gift 使用 inventory 表。
// 结构体名是 Gift，但历史建表名是 inventory；显式指定可以避免 GORM 推断成 gifts。
func (Gift) TableName() string {
	return "inventory"
}

// GetAllGifts 返回 MySQL 中的全部限量材料配置。
// 这是兼容旧调用的便捷方法，失败时只返回空结果；关键链路应优先使用 GetAllGiftsWithError。
func (s *Store) GetAllGifts() []*Gift {
	gifts, _ := s.GetAllGiftsWithError()
	return gifts
}

// GetAllGiftsWithError 返回 MySQL 中的全部限量材料配置。
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

// GetGift 按 gift id 查询限量材料配置。
// 这是兼容旧调用的便捷方法，失败时返回 nil；关键链路应优先使用 GetGiftWithError。
func (s *Store) GetGift(id int) *Gift {
	gift, _ := s.GetGiftWithError(id)
	return gift
}

// GetGiftWithError 按 gift id 查询限量材料配置。
// 准入成功后需要用它把 Redis 中的 gift id 转成前端可展示的材料名称、价格和图片。
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
