package database

import (
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/go-redis/redis"
	"gorm.io/gorm"
)

const purchaseLabCachePrefix = "purchase-lab:material:"

// ErrPurchaseLabMaterialNotFound 表示购买实验没有对应的材料夹具。
// 购买实验与秒杀 inventory 表完全隔离，不能把缺失材料回退成抽奖商品。
var ErrPurchaseLabMaterialNotFound = errors.New("purchase lab material not found")

// PurchaseLabInventory 是材料购买顺序实验的 MySQL 权威库存。
// 它只服务于 DELETE/UPDATE 顺序教学，不创建订单，也不参与秒杀库存裁决。
type PurchaseLabInventory struct {
	MaterialID   int       `json:"materialId" gorm:"column:material_id;primaryKey"`
	InitialStock int       `json:"initialStock" gorm:"column:initial_stock;not null"`
	Stock        int       `json:"stock" gorm:"column:stock;not null"`
	UpdatedAt    time.Time `json:"updatedAt" gorm:"column:updated_at;autoUpdateTime"`
}

func (PurchaseLabInventory) TableName() string { return "purchase_lab_inventory" }

var defaultPurchaseLabInventory = []PurchaseLabInventory{
	{MaterialID: 1, InitialStock: 64, Stock: 64},
	{MaterialID: 2, InitialStock: 48, Stock: 48},
	{MaterialID: 3, InitialStock: 24, Stock: 24},
	{MaterialID: 4, InitialStock: 12, Stock: 12},
}

// PurchaseLabState 同时返回 MySQL 权威值和 Redis 缓存副本。
// RedisStock 为 nil 表示真实 MISS，不用 0 代替，避免把“无缓存”误读成“库存为零”。
type PurchaseLabState struct {
	MaterialID   int  `json:"materialId"`
	InitialStock int  `json:"initialStock"`
	MySQLStock   int  `json:"mysqlStock"`
	RedisStock   *int `json:"redisStock"`
}

// EnsurePurchaseLabSchema 为老数据卷创建独立购买实验表并补齐四个材料基线。
func (s *Store) EnsurePurchaseLabSchema() error {
	if s == nil || s.db == nil {
		return errors.New("database store is nil")
	}
	if err := s.db.AutoMigrate(&PurchaseLabInventory{}); err != nil {
		return fmt.Errorf("migrate purchase lab inventory: %w", err)
	}
	for i := range defaultPurchaseLabInventory {
		fixture := defaultPurchaseLabInventory[i]
		if err := s.db.Where("material_id = ?", fixture.MaterialID).FirstOrCreate(&fixture).Error; err != nil {
			return fmt.Errorf("seed purchase lab material %d: %w", fixture.MaterialID, err)
		}
	}
	return nil
}

// ResetPurchaseLabMaterial 把一个材料恢复到固定 MySQL 基线，并把同值写入 Redis 形成热缓存。
// 每轮顺序实验从同一事实起点开始，结果才可比较；这里只重置当前材料，不触碰订单或秒杀库存。
func (s *Store) ResetPurchaseLabMaterial(materialID int) (*PurchaseLabState, error) {
	row, err := s.purchaseLabRow(materialID)
	if err != nil {
		return nil, err
	}
	if err := s.db.Model(&PurchaseLabInventory{}).
		Where("material_id = ?", materialID).
		Update("stock", row.InitialStock).Error; err != nil {
		return nil, fmt.Errorf("reset purchase lab material %d: %w", materialID, err)
	}
	if err := SetPurchaseLabCacheStock(materialID, row.InitialStock); err != nil {
		return nil, err
	}
	stock := row.InitialStock
	return &PurchaseLabState{
		MaterialID: materialID, InitialStock: row.InitialStock,
		MySQLStock: row.InitialStock, RedisStock: &stock,
	}, nil
}

// ReadPurchaseLabStock 代表并发查询 T2 的真实 MySQL 回源读取。
func (s *Store) ReadPurchaseLabStock(materialID int) (int, error) {
	row, err := s.purchaseLabRow(materialID)
	if err != nil {
		return 0, err
	}
	return row.Stock, nil
}

// DeductPurchaseLabStock 执行购买 T1 的真实库存扣减。
// 条件更新只用于避免演示库存变负；这里不创建订单，也不声称覆盖支付或幂等语义。
func (s *Store) DeductPurchaseLabStock(materialID int) (bool, error) {
	result := s.db.Model(&PurchaseLabInventory{}).
		Where("material_id = ? AND stock > 0", materialID).
		UpdateColumn("stock", gorm.Expr("stock - 1"))
	if result.Error != nil {
		return false, fmt.Errorf("deduct purchase lab material %d: %w", materialID, result.Error)
	}
	return result.RowsAffected == 1, nil
}

// InspectPurchaseLabState 读取实验结束后的真实 MySQL/Redis 状态用于一致性判定。
// 这次读取是实验观测，不计入 T2 请求路径的 DB Reads。
func (s *Store) InspectPurchaseLabState(materialID int) (*PurchaseLabState, error) {
	row, err := s.purchaseLabRow(materialID)
	if err != nil {
		return nil, err
	}
	redisStock, _, err := GetPurchaseLabCacheStock(materialID)
	if err != nil {
		return nil, err
	}
	return &PurchaseLabState{
		MaterialID: materialID, InitialStock: row.InitialStock,
		MySQLStock: row.Stock, RedisStock: redisStock,
	}, nil
}

func (s *Store) purchaseLabRow(materialID int) (*PurchaseLabInventory, error) {
	var row PurchaseLabInventory
	if err := s.db.First(&row, "material_id = ?", materialID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, fmt.Errorf("%w: material_id=%d", ErrPurchaseLabMaterialNotFound, materialID)
		}
		return nil, fmt.Errorf("read purchase lab material %d: %w", materialID, err)
	}
	return &row, nil
}

func purchaseLabCacheKey(materialID int) string {
	return fmt.Sprintf("%s%d:stock", purchaseLabCachePrefix, materialID)
}

// GetPurchaseLabCacheStock 读取购买实验的 Redis 库存副本。
func GetPurchaseLabCacheStock(materialID int) (*int, bool, error) {
	if GiftRedis == nil {
		return nil, false, errors.New("redis client is nil")
	}
	raw, err := GiftRedis.Get(purchaseLabCacheKey(materialID)).Result()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("read purchase lab cache %d: %w", materialID, err)
	}
	stock, err := strconv.Atoi(raw)
	if err != nil {
		_ = GiftRedis.Del(purchaseLabCacheKey(materialID)).Err()
		return nil, false, fmt.Errorf("decode purchase lab cache %d: %w", materialID, err)
	}
	return &stock, true, nil
}

// SetPurchaseLabCacheStock 回填购买实验的 Redis 库存副本。
// 该 key 不设短 TTL，确保实验结果冻结后不会因自然过期掩盖脏缓存；重置会主动覆盖它。
func SetPurchaseLabCacheStock(materialID, stock int) error {
	if GiftRedis == nil {
		return errors.New("redis client is nil")
	}
	if err := GiftRedis.Set(purchaseLabCacheKey(materialID), stock, 0).Err(); err != nil {
		return fmt.Errorf("write purchase lab cache %d: %w", materialID, err)
	}
	return nil
}

// DeletePurchaseLabCache 删除购买实验缓存，是两种 Cache-Aside 写顺序共同的真实动作。
func DeletePurchaseLabCache(materialID int) error {
	if GiftRedis == nil {
		return errors.New("redis client is nil")
	}
	if err := GiftRedis.Del(purchaseLabCacheKey(materialID)).Err(); err != nil {
		return fmt.Errorf("delete purchase lab cache %d: %w", materialID, err)
	}
	return nil
}
