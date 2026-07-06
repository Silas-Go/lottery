package database

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/go-redis/redis"
)

const (
	// CACHE_ALL_STOCK_KEY 是旁路缓存(Cache-Aside)模式下的聚合库存缓存 key。
	// 它保存一份 map[giftID]stock 的 JSON 快照，作为 MySQL cache_stock 列的只读缓存副本。
	//
	// 这个 key 和预扣模式的 gift_count_{id} 完全隔离：
	//   - 预扣模式：Redis 是库存权威源，直接在 Redis 上 Lua 原子扣减；
	//   - Cache-Aside 模式：MySQL.cache_stock 是权威源，Redis 只是加速读的缓存副本，
	//     任何一次扣减写都会删除这个 key，下次读再回源 MySQL 回填。
	CACHE_ALL_STOCK_KEY = "gift_cache_all_stock"

	// cacheStockTTLSeconds 是聚合库存缓存的过期时间，单位秒。
	// 故意设得短，是为了贴近真实 Cache-Aside 语义：缓存只是临时加速副本，
	// 即使没有写操作删除它，也会很快过期回源，避免长期读到陈旧库存。
	cacheStockTTLSeconds = 2

	// defaultCacheAsideDBConcurrency 是 Cache-Aside 链路允许同时打到 MySQL 的并发上限默认值。
	// 它模拟"受限数据库连接池"：超过这个并发的请求必须排队等待，等待时长计入响应耗时。
	// 调小是为了在本机演示时也能真实压出连接等待和 RT 飙升，从而触发红灯预警与熔断。
	defaultCacheAsideDBConcurrency = 10

	// CacheAsideDBOperationRead/Write 用于把库存侧 MySQL 压力拆成读回源和写扣减。
	CacheAsideDBOperationRead  = "read"
	CacheAsideDBOperationWrite = "write"
)

// CacheAsideStat 描述一次 Cache-Aside 库存访问的耗时分解和缓存命中情况。
// service 层用它上报指标（DB RT、连接池占用、缓存命中/击穿），并驱动熔断器判断系统压力。
type CacheAsideStat struct {
	// CacheHit 表示本次读是否命中 Redis 缓存。写操作该字段无意义。
	CacheHit bool

	// HitDB 表示本次操作是否真的访问了 MySQL（即穿过了 DB 并发闸门）。
	// 缓存命中的读不打 DB，HitDB 为 false，不占连接池也不计入 DB 压力。
	HitDB bool

	// Operation 标识本次 DB 操作类型：read=库存回源查询，write=行锁扣减写入。
	Operation string

	// WaitMs 是等待 DB 并发闸门（连接池）放行的耗时，单位毫秒。
	// 连接池被占满时这个值会显著升高，是系统过载最直接的信号。
	WaitMs int64

	// DBMs 是实际 MySQL 操作耗时，单位毫秒，不含排队等待。
	DBMs int64

	// PoolInUse 是穿过闸门那一刻的连接池占用数，在持有令牌时采样，能捕捉到过载峰值。
	// 放在 stat 里随结果返回，避免 metrics 层反向依赖 database 层去读全局闸门状态。
	PoolInUse int

	// PoolCapacity 是连接池容量（闸门令牌总数），用于计算占用率百分比。
	PoolCapacity int
}

// dbGate 是 Cache-Aside 链路的数据库并发闸门，用带缓冲 channel 模拟受限连接池。
// 它和真实连接池语义一致：令牌（连接）用满后，新请求阻塞排队，从而把过载压力
// 转化为可观测的"等待耗时 + 占用率"，而不是直接把 MySQL 打挂。
type dbGate struct {
	tokens chan struct{}
}

func newDBGate(capacity int) *dbGate {
	if capacity < 1 {
		capacity = 1
	}
	return &dbGate{tokens: make(chan struct{}, capacity)}
}

// acquire 申请一个 DB 并发令牌，返回排队等待的耗时。
// 闸门未满时立即返回 0；满时阻塞直到有请求释放令牌，等待时长由调用方计入 RT。
func (g *dbGate) acquire() time.Duration {
	start := time.Now()
	g.tokens <- struct{}{}
	return time.Since(start)
}

func (g *dbGate) release() {
	<-g.tokens
}

func (g *dbGate) inUse() int { return len(g.tokens) }

func (g *dbGate) capacity() int { return cap(g.tokens) }

// cacheAsideGate 是全局唯一的 Cache-Aside DB 并发闸门。
// 用包级变量是为了让 database 读写方法、指标查询共享同一份占用状态。
var cacheAsideGate = newDBGate(defaultCacheAsideDBConcurrency)

// SetCacheAsideGateCapacity 在应用启动早期重建 DB 并发闸门容量。
// channel 容量无法动态修改，因此通过重建实现；必须在任何 Cache-Aside 请求进入前调用，避免并发竞态。
func SetCacheAsideGateCapacity(capacity int) {
	cacheAsideGate = newDBGate(capacity)
	slog.Info("cache-aside db gate capacity set", "capacity", cacheAsideGate.capacity())
}

// CacheAsideGateInUse 返回当前正在占用 DB 并发令牌的请求数。
func CacheAsideGateInUse() int { return cacheAsideGate.inUse() }

// CacheAsideGateCapacity 返回 DB 并发闸门容量（模拟的连接池大小）。
func CacheAsideGateCapacity() int { return cacheAsideGate.capacity() }

// EnsureCacheStockSchema 为 inventory 表补齐 Cache-Aside 专用的实时库存列。
//
// 预扣模式把 inventory.count 当作"只读初始库存基线"（重启时据此恢复 Redis），
// 如果 Cache-Aside 直接扣 count 会破坏这个基线。因此 Cache-Aside 改用独立的
// cache_stock 列，两个模式共享同一张表但读写不同列，彻底隔离互不干扰。
//
// 列首次创建时用 count 初始化；已存在则保留上次状态，压测前可调用 ResetCacheStock 重置。
func (s *Store) EnsureCacheStockSchema() error {
	exists, err := s.columnExists("inventory", "cache_stock")
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	if err := s.db.Exec("ALTER TABLE inventory ADD COLUMN cache_stock int NOT NULL DEFAULT 0 COMMENT 'Cache-Aside 模式实时库存，与预扣模式 count 基线隔离'").Error; err != nil {
		slog.Error("add cache_stock column failed", "error", err)
		return fmt.Errorf("add cache_stock column: %w", err)
	}
	if err := s.db.Exec("UPDATE inventory SET cache_stock = count").Error; err != nil {
		slog.Error("init cache_stock column failed", "error", err)
		return fmt.Errorf("init cache_stock column: %w", err)
	}
	slog.Info("cache_stock column ensured and initialized from count")
	return nil
}

// ResetCacheStock 把 Cache-Aside 实时库存重置回初始库存基线。
// Cache-Aside 压测会真实扣减 MySQL.cache_stock，重新压测前调用它恢复库存，避免越压越空。
func (s *Store) ResetCacheStock() error {
	if err := s.db.Exec("UPDATE inventory SET cache_stock = count").Error; err != nil {
		return fmt.Errorf("reset cache_stock: %w", err)
	}
	if GiftRedis != nil {
		GiftRedis.Del(CACHE_ALL_STOCK_KEY)
	}
	slog.Info("cache-aside stock reset to baseline")
	return nil
}

type cacheStockRow struct {
	Id    int
	Stock int
}

// GetAllGiftStockCacheAside 以旁路缓存方式读取全部奖品的实时库存。
//
// 流程（标准 Cache-Aside 读路径）：
//  1. 先读 Redis 聚合缓存 CACHE_ALL_STOCK_KEY，命中直接解析返回；
//  2. 未命中（缓存击穿）→ 穿过 DB 并发闸门回源 MySQL.cache_stock；
//  3. 把最新库存回填缓存（短 TTL），供后续请求加速读。
//
// 高并发下大量扣减会不断删除聚合缓存，导致几乎每次读都击穿回源 MySQL，
// 缓存近乎失效、链路退化为直接打 DB——这正是 Cache-Aside 在写密集场景的真实代价。
func (s *Store) GetAllGiftStockCacheAside() ([]*Gift, CacheAsideStat, error) {
	if GiftRedis != nil {
		cached, err := GiftRedis.Get(CACHE_ALL_STOCK_KEY).Result()
		if err == nil {
			var stocks map[int]int
			if jsonErr := json.Unmarshal([]byte(cached), &stocks); jsonErr == nil {
				gifts := make([]*Gift, 0, len(stocks))
				for id, count := range stocks {
					gifts = append(gifts, &Gift{Id: id, Count: count})
				}
				return gifts, CacheAsideStat{CacheHit: true}, nil
			}
			slog.Warn("cache-aside parse cached stock failed, fallback to db")
		} else if !errors.Is(err, redis.Nil) {
			slog.Warn("cache-aside read cache failed, fallback to db", "error", err)
		}
	}

	// 缓存未命中：回源 MySQL，受 DB 并发闸门保护。
	stat := CacheAsideStat{CacheHit: false, HitDB: true, Operation: CacheAsideDBOperationRead}
	wait := cacheAsideGate.acquire()
	defer cacheAsideGate.release()
	stat.WaitMs = wait.Milliseconds()
	stat.PoolInUse = cacheAsideGate.inUse()
	stat.PoolCapacity = cacheAsideGate.capacity()

	dbStart := time.Now()
	var rows []cacheStockRow
	dbErr := s.db.Raw("SELECT id, cache_stock AS stock FROM inventory").Scan(&rows).Error
	stat.DBMs = time.Since(dbStart).Milliseconds()
	if dbErr != nil {
		slog.Error("cache-aside load stock from mysql failed", "error", dbErr)
		return nil, stat, fmt.Errorf("cache-aside load stock from mysql: %w", dbErr)
	}

	stocks := make(map[int]int, len(rows))
	gifts := make([]*Gift, 0, len(rows))
	for _, row := range rows {
		stocks[row.Id] = row.Stock
		gifts = append(gifts, &Gift{Id: row.Id, Count: row.Stock})
	}

	if GiftRedis != nil {
		if data, jErr := json.Marshal(stocks); jErr == nil {
			if err := GiftRedis.Set(CACHE_ALL_STOCK_KEY, data, cacheStockTTLSeconds*time.Second).Err(); err != nil {
				slog.Warn("cache-aside backfill stock cache failed", "error", err)
			}
		}
	}
	return gifts, stat, nil
}

// DeductGiftStockCacheAside 以旁路缓存方式扣减单个奖品库存。
//
// 写策略（标准 Cache-Aside）：先改 MySQL，再删缓存。
//
//	UPDATE inventory SET cache_stock = cache_stock - 1 WHERE id = ? AND cache_stock > 0
//
// WHERE cache_stock > 0 让扣减由 MySQL 行锁串行化：并发请求即使读到同一份旧缓存库存，
// 真正的扣减仍是原子的，售罄时影响行数为 0——所以 Cache-Aside 绝不超卖（强一致），
// 代价是每次扣减都要抢 MySQL 行锁和 DB 连接。返回 ok=false 表示库存已售罄。
func (s *Store) DeductGiftStockCacheAside(giftID int) (bool, CacheAsideStat, error) {
	stat := CacheAsideStat{HitDB: true, Operation: CacheAsideDBOperationWrite}
	wait := cacheAsideGate.acquire()
	defer cacheAsideGate.release()
	stat.WaitMs = wait.Milliseconds()
	stat.PoolInUse = cacheAsideGate.inUse()
	stat.PoolCapacity = cacheAsideGate.capacity()

	dbStart := time.Now()
	res := s.db.Exec("UPDATE inventory SET cache_stock = cache_stock - 1 WHERE id = ? AND cache_stock > 0", giftID)
	stat.DBMs = time.Since(dbStart).Milliseconds()
	if res.Error != nil {
		slog.Error("cache-aside deduct stock failed", "gid", giftID, "error", res.Error)
		return false, stat, fmt.Errorf("cache-aside deduct stock gid %d: %w", giftID, res.Error)
	}
	if res.RowsAffected == 0 {
		return false, stat, nil
	}

	// 扣减成功后删除聚合缓存，保证下次读回源拿到最新库存。
	if GiftRedis != nil {
		if err := GiftRedis.Del(CACHE_ALL_STOCK_KEY).Err(); err != nil {
			slog.Warn("cache-aside delete stock cache failed", "gid", giftID, "error", err)
		}
	}
	return true, stat, nil
}

// RestoreGiftStockCacheAside 回补单个奖品的 Cache-Aside 库存。
// 仅用于"扣减成功但后续写正式订单失败"的兜底回滚，回补后同样删除聚合缓存。
func (s *Store) RestoreGiftStockCacheAside(giftID int) error {
	if err := s.db.Exec("UPDATE inventory SET cache_stock = cache_stock + 1 WHERE id = ?", giftID).Error; err != nil {
		slog.Error("cache-aside restore stock failed", "gid", giftID, "error", err)
		return fmt.Errorf("cache-aside restore stock gid %d: %w", giftID, err)
	}
	if GiftRedis != nil {
		GiftRedis.Del(CACHE_ALL_STOCK_KEY)
	}
	return nil
}
