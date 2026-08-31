package database

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/go-redis/redis"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	materialDetailCachePrefix         = "archive:material-detail:v2:"
	materialDetailNegativeCachePrefix = "archive:material-detail-negative:v1:"
	materialDetailNegativeCacheValue  = "not-found"
)

const (
	materialTradeFactsPerMaterial  = 2500
	materialReviewFactsPerMaterial = 400
	// StarMarrowMaterialID 是查询、购买和抢购实验共享的唯一业务材料主键。
	StarMarrowMaterialID = 4
)

var (
	starMarrowCatalogIDs = []int{StarMarrowMaterialID, 401, 402, 403}
	starMarrowRarityIDs  = []int{1, 4}
	starMarrowSourceIDs  = []int{4}
)

// ErrMaterialArchiveNotFound 让 service 能把“没有这份材料档案”稳定映射成 404。
var ErrMaterialArchiveNotFound = errors.New("material archive not found")

// MaterialRarity 是材料稀有度字典；独立成表是为了让详情读取包含真实 JOIN，而不是把展示文本堆在一行里。
type MaterialRarity struct {
	ID    int    `gorm:"primaryKey"`
	Code  string `gorm:"size:32;uniqueIndex"`
	Label string `gorm:"size:64"`
	Rank  int
}

func (MaterialRarity) TableName() string { return "material_rarities" }

// MaterialSource 是材料来源字典，一个来源可被多种材料复用。
type MaterialSource struct {
	ID     int    `gorm:"primaryKey"`
	Code   string `gorm:"size:64;uniqueIndex"`
	Name   string `gorm:"size:128"`
	Region string `gorm:"size:128"`
}

func (MaterialSource) TableName() string { return "material_sources" }

// MaterialCatalog 保存材料的权威基础字段、当前价格和展示库存。
// 用户购买状态不放在这里，也不进入公共详情缓存，避免热点 key 按 uid 膨胀。
type MaterialCatalog struct {
	ID        int    `gorm:"primaryKey"`
	Code      string `gorm:"size:32;uniqueIndex"`
	Name      string `gorm:"size:64"`
	IsPrimary bool   `gorm:"index"`
	Title     string `gorm:"size:128"`
	Sigil     string `gorm:"size:16"`
	Accent    string `gorm:"size:16"`
	Summary   string `gorm:"size:600"`
	Oath      string `gorm:"size:255"`
	Price     int
	Stock     int
	RarityID  int    `gorm:"index"`
	SourceID  int    `gorm:"index"`
	Attribute string `gorm:"size:255"`
	Usage     string `gorm:"size:255"`
	Risk      string `gorm:"size:255"`
}

func (MaterialCatalog) TableName() string { return "materials" }

// MaterialComponent 表示详情中的组成材料，一份材料详情通常包含多行组成关系。
type MaterialComponent struct {
	ID                  int `gorm:"primaryKey"`
	MaterialID          int `gorm:"index:idx_material_component,priority:1"`
	ComponentMaterialID int `gorm:"index"`
	Quantity            int
	Unit                string `gorm:"size:24"`
	SortOrder           int    `gorm:"index:idx_material_component,priority:2"`
}

func (MaterialComponent) TableName() string { return "material_components" }

// MaterialTrade 是只读实验的交易事实。详情请求会在这些事实行上计算 24h/7d 聚合。
type MaterialTrade struct {
	ID         int64 `gorm:"primaryKey;autoIncrement:false"`
	MaterialID int   `gorm:"index:idx_material_trade_time,priority:1"`
	UnitPrice  int
	Quantity   int
	TradedAt   time.Time `gorm:"index:idx_material_trade_time,priority:2"`
}

func (MaterialTrade) TableName() string { return "trades" }

// MaterialReview 是评分事实；缓存 MISS 时会计算平均分和评价数量。
type MaterialReview struct {
	ID         int64 `gorm:"primaryKey;autoIncrement:false"`
	MaterialID int   `gorm:"index:idx_material_review_created,priority:1"`
	Score      int
	CreatedAt  time.Time `gorm:"index:idx_material_review_created,priority:2"`
}

func (MaterialReview) TableName() string { return "reviews" }

type MaterialRarityDTO struct {
	Code  string `json:"code"`
	Label string `json:"label"`
	Rank  int    `json:"rank"`
}

type MaterialSourceDTO struct {
	Code   string `json:"code"`
	Name   string `json:"name"`
	Region string `json:"region"`
}

type MaterialComponentDTO struct {
	Name     string `json:"name"`
	Quantity int    `json:"quantity"`
	Unit     string `json:"unit"`
}

type MaterialTradeStatsDTO struct {
	Volume24h       int     `json:"volume24h"`
	Transactions24h int     `json:"transactions24h"`
	AveragePrice7d  float64 `json:"averagePrice7d"`
	MaxPrice7d      int     `json:"maxPrice7d"`
	Volume7d        int     `json:"volume7d"`
}

type MaterialRatingDTO struct {
	Score float64 `json:"score"`
	Count int     `json:"count"`
}

// MaterialDetailDTO 是两条详情路径共同返回的最终接口对象。
// Redis 缓存的就是这份 JSON，而不是若干底层表行，命中时无需再次 JOIN 或聚合。
type MaterialDetailDTO struct {
	ID         int                    `json:"id"`
	Name       string                 `json:"name"`
	Title      string                 `json:"title"`
	Sigil      string                 `json:"sigil"`
	Accent     string                 `json:"accent"`
	Summary    string                 `json:"summary"`
	Oath       string                 `json:"oath"`
	Price      int                    `json:"price"`
	Stock      int                    `json:"stock"`
	Attribute  string                 `json:"attribute"`
	Usage      string                 `json:"usage"`
	Risk       string                 `json:"risk"`
	Rarity     MaterialRarityDTO      `json:"rarity"`
	Source     MaterialSourceDTO      `json:"source"`
	Components []MaterialComponentDTO `json:"components"`
	TradeStats MaterialTradeStatsDTO  `json:"tradeStats"`
	Rating     MaterialRatingDTO      `json:"rating"`
}

var defaultMaterialRarities = []MaterialRarity{
	{ID: 1, Code: "common", Label: "COMMON · 常见", Rank: 1},
	{ID: 4, Code: "legendary", Label: "LEGENDARY · 传说", Rank: 4},
}

var defaultMaterialSources = []MaterialSource{
	{ID: 4, Code: "fallen-star-basin", Name: "坠星盆地", Region: "高原观测区"},
}

var defaultMaterialCatalog = []MaterialCatalog{
	{ID: 4, Code: "star-marrow", Name: "星髓", IsPrimary: true, Title: "从坠星内部提取的高密度魔力介质", Sigil: "Ⅳ", Accent: "#8877d7", Summary: "只在高阶炼成中使用的稀缺校准材料。", Oath: "群星沉默，星髓仍在迁移。", Price: 5200, Stock: 12, RarityID: 4, SourceID: 4, Attribute: "高密度魔力 · 星光迁移", Usage: "高阶炼成与能量校准", Risk: "高密度魔力会干扰未经屏蔽的仪器。"},
}

// 组成材料也复用 materials；关系表只保存“成品材料 -> 组成材料”的外键和用量。
// 这样详情查询必须执行 material_components JOIN materials，页面展示的映射与真实 SQL 保持一致。
var defaultComponentMaterials = []MaterialCatalog{
	{ID: 401, Code: "CMP-401", Name: "坠星碎屑", RarityID: 1, SourceID: 4},
	{ID: 402, Code: "CMP-402", Name: "夜空溶剂", RarityID: 1, SourceID: 4},
	{ID: 403, Code: "CMP-403", Name: "银线封印", RarityID: 1, SourceID: 4},
}

// 材料库存进入购买实验后是可变业务数据，应用重启时不能被夹具重新覆盖。
// 其他目录字段仍允许随代码升级更新；显式排除 stock 是为了让订单账本和权威库存保持一致。
var materialCatalogSeedUpdateColumns = []string{
	"code", "name", "is_primary", "title", "sigil", "accent", "summary", "oath",
	"price", "rarity_id", "source_id", "attribute", "usage", "risk",
}

var defaultMaterialComponents = []MaterialComponent{
	{ID: 401, MaterialID: 4, ComponentMaterialID: 401, Quantity: 5, Unit: "g", SortOrder: 1},
	{ID: 402, MaterialID: 4, ComponentMaterialID: 402, Quantity: 9, Unit: "ml", SortOrder: 2},
	{ID: 403, MaterialID: 4, ComponentMaterialID: 403, Quantity: 4, Unit: "圈", SortOrder: 3},
}

// EnsureMaterialReadModelSchema 为新旧 Docker 数据卷补齐材料聚合读模型和确定性事实数据。
// 这些表只服务读实验，不复用 orders，避免把 ARC 材料错误映射成秒杀 gift。
func (s *Store) EnsureMaterialReadModelSchema() error {
	if s == nil || s.db == nil {
		return errors.New("database store is nil")
	}
	if err := s.db.AutoMigrate(&MaterialRarity{}, &MaterialSource{}, &MaterialCatalog{}, &MaterialComponent{}, &MaterialTrade{}, &MaterialReview{}); err != nil {
		return fmt.Errorf("migrate material read model: %w", err)
	}
	if err := s.removeLegacyBusinessMaterials(); err != nil {
		return err
	}
	for i := range defaultMaterialRarities {
		row := defaultMaterialRarities[i]
		if err := s.db.Clauses(clause.OnConflict{UpdateAll: true}).Create(&row).Error; err != nil {
			return fmt.Errorf("seed material rarity %d: %w", row.ID, err)
		}
	}
	for i := range defaultMaterialSources {
		row := defaultMaterialSources[i]
		if err := s.db.Clauses(clause.OnConflict{UpdateAll: true}).Create(&row).Error; err != nil {
			return fmt.Errorf("seed material source %d: %w", row.ID, err)
		}
	}
	for i := range defaultMaterialCatalog {
		row := defaultMaterialCatalog[i]
		if err := s.db.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "id"}},
			DoUpdates: clause.AssignmentColumns(materialCatalogSeedUpdateColumns),
		}).Create(&row).Error; err != nil {
			return fmt.Errorf("seed material catalog %d: %w", row.ID, err)
		}
	}
	for i := range defaultComponentMaterials {
		row := defaultComponentMaterials[i]
		if err := s.db.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "id"}},
			DoUpdates: clause.AssignmentColumns(materialCatalogSeedUpdateColumns),
		}).Create(&row).Error; err != nil {
			return fmt.Errorf("seed component material %d: %w", row.ID, err)
		}
	}
	if err := s.db.Clauses(clause.OnConflict{UpdateAll: true}).Create(&defaultMaterialComponents).Error; err != nil {
		return fmt.Errorf("seed material components: %w", err)
	}
	if err := s.ensureMaterialFactFixtures(); err != nil {
		return err
	}
	return nil
}

// removeLegacyBusinessMaterials 把旧数据卷中的其他商品、事实与孤儿字典迁出业务目录。
// 星髓详情仍需要 401～403 三种组成材料完成真实 JOIN，因此白名单不是只有主商品 ID 4。
// Redis 只保留星髓 DTO，MySQL 清理无条件执行，避免旧 materials 已删后 rarity/source 孤儿行被跳过。
func (s *Store) removeLegacyBusinessMaterials() error {
	keepCache := map[string]struct{}{
		materialDetailCacheKey(StarMarrowMaterialID): {},
	}
	if err := deleteRedisKeysExcept("archive:material-detail:*", keepCache); err != nil {
		return fmt.Errorf("remove legacy material caches: %w", err)
	}

	if err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("material_id <> ? OR component_material_id NOT IN ?", StarMarrowMaterialID, starMarrowCatalogIDs).
			Delete(&MaterialComponent{}).Error; err != nil {
			return err
		}
		if err := tx.Where("material_id <> ?", StarMarrowMaterialID).Delete(&MaterialTrade{}).Error; err != nil {
			return err
		}
		if err := tx.Where("material_id <> ?", StarMarrowMaterialID).Delete(&MaterialReview{}).Error; err != nil {
			return err
		}
		if err := tx.Where("id NOT IN ?", starMarrowCatalogIDs).Delete(&MaterialCatalog{}).Error; err != nil {
			return err
		}
		if err := tx.Where("id NOT IN ?", starMarrowRarityIDs).Delete(&MaterialRarity{}).Error; err != nil {
			return err
		}
		return tx.Where("id NOT IN ?", starMarrowSourceIDs).Delete(&MaterialSource{}).Error
	}); err != nil {
		return fmt.Errorf("remove legacy business materials: %w", err)
	}
	return nil
}

func (s *Store) ensureMaterialFactFixtures() error {
	expectedTrades := int64(len(defaultMaterialCatalog) * materialTradeFactsPerMaterial)
	var tradeCount int64
	if err := s.db.Model(&MaterialTrade{}).Count(&tradeCount).Error; err != nil {
		return fmt.Errorf("count material trade fixtures: %w", err)
	}
	if tradeCount < expectedTrades {
		baseTime := time.Now().UTC().Truncate(time.Hour).Add(-30 * time.Minute)
		trades := make([]MaterialTrade, 0, expectedTrades)
		for _, material := range defaultMaterialCatalog {
			for index := 0; index < materialTradeFactsPerMaterial; index++ {
				trades = append(trades, MaterialTrade{
					ID: int64(material.ID*100000 + index + 1), MaterialID: material.ID,
					UnitPrice: material.Price + (index%11-5)*max(1, material.Price/100), Quantity: index%3 + 1,
					TradedAt: baseTime.Add(-time.Duration(index%336) * time.Hour),
				})
			}
		}
		if err := s.db.Clauses(clause.OnConflict{DoNothing: true}).CreateInBatches(&trades, 500).Error; err != nil {
			return fmt.Errorf("seed material trade fixtures: %w", err)
		}
	}

	expectedReviews := int64(len(defaultMaterialCatalog) * materialReviewFactsPerMaterial)
	var reviewCount int64
	if err := s.db.Model(&MaterialReview{}).Count(&reviewCount).Error; err != nil {
		return fmt.Errorf("count material review fixtures: %w", err)
	}
	if reviewCount < expectedReviews {
		baseTime := time.Now().UTC().Truncate(time.Hour).Add(-15 * time.Minute)
		reviews := make([]MaterialReview, 0, expectedReviews)
		for _, material := range defaultMaterialCatalog {
			for index := 0; index < materialReviewFactsPerMaterial; index++ {
				reviews = append(reviews, MaterialReview{
					ID: int64(material.ID*100000 + index + 1), MaterialID: material.ID,
					Score: 3 + (index+material.ID)%3, CreatedAt: baseTime.Add(-time.Duration(index%1440) * time.Minute),
				})
			}
		}
		if err := s.db.Clauses(clause.OnConflict{DoNothing: true}).CreateInBatches(&reviews, 500).Error; err != nil {
			return fmt.Errorf("seed material review fixtures: %w", err)
		}
	}
	return nil
}

// GetMaterialDetail 从 MySQL 组装最终详情 DTO，并返回实际执行的 SQL 条数。
// 四次查询分别承担一对一基础 JOIN、组成列表、交易聚合和评分聚合；不使用 SLEEP 人为制造差距。
func (s *Store) GetMaterialDetail(id int) (*MaterialDetailDTO, int, error) {
	type baseRow struct {
		ID, Price, Stock, RarityRank              int
		Name, Title, Sigil, Accent, Summary, Oath string
		Attribute, Usage, Risk                    string
		RarityCode, RarityLabel                   string
		SourceCode, SourceName, SourceRegion      string
	}
	var base baseRow
	queries := 1
	err := s.db.Raw(`
		SELECT m.id, m.name, m.title, m.sigil, m.accent, m.summary, m.oath,
		       m.price, m.stock, m.attribute, m.usage, m.risk,
		       r.code AS rarity_code, r.label AS rarity_label, r.rank AS rarity_rank,
		       s.code AS source_code, s.name AS source_name, s.region AS source_region
		FROM materials m
		JOIN material_rarities r ON r.id = m.rarity_id
		JOIN material_sources s ON s.id = m.source_id
		WHERE m.id = ? AND m.is_primary = TRUE`, id).Scan(&base).Error
	if err != nil {
		return nil, queries, fmt.Errorf("read material base %d: %w", id, err)
	}
	if base.ID == 0 {
		return nil, queries, fmt.Errorf("%w: id=%d", ErrMaterialArchiveNotFound, id)
	}
	detail := &MaterialDetailDTO{
		ID: base.ID, Name: base.Name, Title: base.Title, Sigil: base.Sigil,
		Accent: base.Accent, Summary: base.Summary, Oath: base.Oath, Price: base.Price, Stock: base.Stock,
		Attribute: base.Attribute, Usage: base.Usage, Risk: base.Risk,
		Rarity:     MaterialRarityDTO{Code: base.RarityCode, Label: base.RarityLabel, Rank: base.RarityRank},
		Source:     MaterialSourceDTO{Code: base.SourceCode, Name: base.SourceName, Region: base.SourceRegion},
		Components: make([]MaterialComponentDTO, 0, 4),
	}

	queries++
	if err := s.db.Raw(`
		SELECT component.name, mc.quantity, mc.unit
		FROM material_components mc
		JOIN materials component ON component.id = mc.component_material_id
		WHERE mc.material_id = ?
		ORDER BY mc.sort_order, mc.id`, id).Scan(&detail.Components).Error; err != nil {
		return nil, queries, fmt.Errorf("read material components %d: %w", id, err)
	}

	queries++
	if err := s.db.Raw(`
		SELECT
			COALESCE(SUM(CASE WHEN traded_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR) THEN quantity ELSE 0 END), 0) AS volume24h,
			COUNT(CASE WHEN traded_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR) THEN 1 END) AS transactions24h,
			COALESCE(ROUND(AVG(CASE WHEN traded_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY) THEN unit_price END), 2), 0) AS average_price7d,
			COALESCE(MAX(CASE WHEN traded_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY) THEN unit_price END), 0) AS max_price7d,
			COALESCE(SUM(CASE WHEN traded_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY) THEN quantity ELSE 0 END), 0) AS volume7d
		FROM trades
		WHERE material_id = ?`, id).Scan(&detail.TradeStats).Error; err != nil {
		return nil, queries, fmt.Errorf("aggregate material trades %d: %w", id, err)
	}

	queries++
	if err := s.db.Raw(`
		SELECT COALESCE(ROUND(AVG(score), 2), 0) AS score, COUNT(*) AS count
		FROM reviews
		WHERE material_id = ?`, id).Scan(&detail.Rating).Error; err != nil {
		return nil, queries, fmt.Errorf("aggregate material ratings %d: %w", id, err)
	}
	return detail, queries, nil
}

func materialDetailCacheKey(id int) string {
	return fmt.Sprintf("%s%d", materialDetailCachePrefix, id)
}

// MaterialDetailCacheKey 返回服务当前真实使用的 DTO 缓存 Key。
// 实验台只展示后端生成的值，避免前端复制命名规则后与真实读路径漂移。
func MaterialDetailCacheKey(id int) string {
	return materialDetailCacheKey(id)
}

func materialDetailNegativeCacheKey(id int) string {
	return fmt.Sprintf("%s%d", materialDetailNegativeCachePrefix, id)
}

// DeleteMaterialDetailCache 删除材料详情的最终 DTO 缓存。
// 购买写路径只删除副本，不直接修改缓存内容，避免并发写把较旧的 DTO 覆盖到新库存上。
// DEL 天然幂等，因此 RocketMQ 重复投递时可以安全重复执行。
func DeleteMaterialDetailCache(id int) error {
	_, err := DeleteMaterialDetailCacheWithResult(id)
	return err
}

// DeleteMaterialDetailCacheWithResult 删除 DTO Key，并返回本次是否真的删除了一个 Key。
// 热点击穿实验用这个结果证明故障注入发生在真实 Redis 状态上，而不是只推进页面阶段。
func DeleteMaterialDetailCacheWithResult(id int) (bool, error) {
	if GiftRedis == nil {
		return false, errors.New("redis client is nil")
	}
	deleted, err := GiftRedis.Del(materialDetailCacheKey(id)).Result()
	if err != nil {
		return false, fmt.Errorf("delete material detail cache %d: %w", id, err)
	}
	return deleted > 0, nil
}

// MaterialDetailCacheState 返回 DTO Key 的真实存在状态和剩余 TTL。
// Redis 用 -1 表示无过期时间、-2 表示 Key 不存在；调用方只在任务控制面读取。
func MaterialDetailCacheState(id int) (bool, time.Duration, error) {
	if GiftRedis == nil {
		return false, 0, errors.New("redis client is nil")
	}
	key := materialDetailCacheKey(id)
	exists, err := GiftRedis.Exists(key).Result()
	if err != nil {
		return false, 0, fmt.Errorf("inspect material detail cache %d: %w", id, err)
	}
	if exists == 0 {
		return false, 0, nil
	}
	ttl, err := GiftRedis.PTTL(key).Result()
	if err != nil {
		return false, 0, fmt.Errorf("inspect material detail cache ttl %d: %w", id, err)
	}
	return true, ttl, nil
}

// GetMaterialDetailCache 读取已经组装好的最终 DTO；hit=false 时由 service 回源四条 MySQL 查询。
func GetMaterialDetailCache(id int) (*MaterialDetailDTO, bool, error) {
	if GiftRedis == nil {
		return nil, false, errors.New("redis client is nil")
	}
	raw, err := GiftRedis.Get(materialDetailCacheKey(id)).Result()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("read material detail cache %d: %w", id, err)
	}
	var detail MaterialDetailDTO
	if err := json.Unmarshal([]byte(raw), &detail); err != nil {
		_ = GiftRedis.Del(materialDetailCacheKey(id)).Err()
		return nil, false, fmt.Errorf("decode material detail cache %d: %w", id, err)
	}
	return &detail, true, nil
}

// SetMaterialDetailCache 把接口最终 DTO 作为一个带 TTL 的 JSON 副本写入 Redis。
// 未来价格、库存或组成发生写入时，写路径必须删除这个 key；TTL 只是失效兜底。
func SetMaterialDetailCache(detail *MaterialDetailDTO, ttl time.Duration) error {
	if GiftRedis == nil {
		return errors.New("redis client is nil")
	}
	raw, err := json.Marshal(detail)
	if err != nil {
		return fmt.Errorf("encode material detail cache %d: %w", detail.ID, err)
	}
	if err := GiftRedis.Set(materialDetailCacheKey(detail.ID), raw, ttl).Err(); err != nil {
		return fmt.Errorf("write material detail cache %d: %w", detail.ID, err)
	}
	return nil
}

// GetMaterialDetailNegativeCache 读取“数据库已确认不存在”的短期标记。
// 它与正常 DTO 使用不同命名空间，避免空值被误反序列化为材料详情。
func GetMaterialDetailNegativeCache(id int) (bool, error) {
	if GiftRedis == nil {
		return false, errors.New("redis client is nil")
	}
	value, err := GiftRedis.Get(materialDetailNegativeCacheKey(id)).Result()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read material negative cache %d: %w", id, err)
	}
	if value != materialDetailNegativeCacheValue {
		_ = GiftRedis.Del(materialDetailNegativeCacheKey(id)).Err()
		return false, fmt.Errorf("invalid material negative cache marker %d", id)
	}
	return true, nil
}

// SetMaterialDetailNegativeCache 只在 MySQL 明确返回 not found 后写入短期标记。
func SetMaterialDetailNegativeCache(id int, ttl time.Duration) error {
	if GiftRedis == nil {
		return errors.New("redis client is nil")
	}
	if err := GiftRedis.Set(materialDetailNegativeCacheKey(id), materialDetailNegativeCacheValue, ttl).Err(); err != nil {
		return fmt.Errorf("write material negative cache %d: %w", id, err)
	}
	return nil
}

// DeleteMaterialDetailNegativeCache 清理任务级负缓存；DEL 幂等，终态清理可安全重试。
func DeleteMaterialDetailNegativeCache(id int) error {
	if GiftRedis == nil {
		return errors.New("redis client is nil")
	}
	if err := GiftRedis.Del(materialDetailNegativeCacheKey(id)).Err(); err != nil {
		return fmt.Errorf("delete material negative cache %d: %w", id, err)
	}
	return nil
}

// ClearMaterialDetailCache 清空本章全部 DTO 缓存，保证冷热缓存实验可重复。
func ClearMaterialDetailCache() error {
	if GiftRedis == nil {
		return errors.New("redis client is nil")
	}
	return deleteRedisKeysByPattern("archive:*")
}
