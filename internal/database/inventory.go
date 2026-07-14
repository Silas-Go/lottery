package database

import (
	"errors"
	"fmt"
	"log/slog"
	"strconv"
)

const (
	// INVENTORY_PREFIX 是 Redis 奖品库存 key 的前缀。
	// 完整 key 形如 gift_count_3，表示 gift id 为 3 的奖品当前可抢库存。
	INVENTORY_PREFIX = "gift_count_"

	// INVENTORY_IDS_KEY 是奖品 ID 注册表（Redis SET）的 key，保存当前活动的全部 gift id。
	// 读取实时库存时用 SMEMBERS 拿到 id 列表，再用一次 MGET 批量取库存，
	// 取代原来的 KEYS gift_count_* 全库扫描。它由 InitGiftInventory 在启动时按 MySQL 配置重建，
	// 是读取库存的权威来源：手动往 Redis 塞 gift_count_* 而不更新注册表的 key 不会被读到。
	INVENTORY_IDS_KEY = "gift_ids"
)

// InitGiftInventory 从 MySQL 账本和 Redis stock_acquired 状态恢复活动库存及奖品 ID 注册表。
// 恢复量必须扣掉 Redis 模式的 pending_payment/paid 订单，以及尚未异步落账的 stock_acquired；
// cancelled 已经完成回补，MySQL 模式使用独立库存，二者都不能从 Redis 基线重复扣除。
//
// 该函数同时用 MySQL 奖品配置重建 INVENTORY_IDS_KEY（gift_ids SET），
// 供后续 GetAllGiftInventoryWithError 用 SMEMBERS + MGET 批量读取库存，
// 不再需要在 /lucky 热路径上逐请求 KEYS 全库扫描。
func (s *Store) InitGiftInventory() error {
	gifts, err := s.GetAllGiftsWithError()
	if err != nil {
		return err
	}
	completedCounts, err := s.CompletedOrderCounts(DefaultActivityID)
	if err != nil {
		return err
	}
	unpersistedAdmissionCounts, err := s.UnpersistedAdmissionCounts(DefaultActivityID)
	if err != nil {
		return err
	}

	ids := make([]any, 0, len(gifts))
	for _, gift := range gifts {
		sold := completedCounts[gift.Id] + unpersistedAdmissionCounts[gift.Id]
		remaining := gift.Count - sold
		if remaining < 0 {
			slog.Error("completed orders exceed initial inventory", "activity_id", DefaultActivityID, "gift_id", gift.Id, "name", gift.Name, "initial", gift.Count, "sold", sold)
			remaining = 0
		}

		key := INVENTORY_PREFIX + strconv.Itoa(gift.Id)
		if err := GiftRedis.Set(key, remaining, 0).Err(); err != nil {
			slog.Error("set gift count to redis failed", "gift_id", gift.Id, "key", key, "error", err)
			return fmt.Errorf("set gift %d inventory to redis: %w", gift.Id, err)
		}
		ids = append(ids, gift.Id)
		slog.Info("gift inventory restored to redis", "activity_id", DefaultActivityID, "gift_id", gift.Id, "initial", gift.Count, "sold", sold, "remaining", remaining)
	}

	// 重建奖品 ID 注册表（全量替换，保证与 MySQL 配置一致）。
	// 先用 DEL 清空旧注册表，再用 SADD 写入当前奖品 ID 集合；两步不是原子的，
	// 但此函数只在启动初始化时调用一次，不存在并发写入竞争。
	if err := GiftRedis.Del(INVENTORY_IDS_KEY).Err(); err != nil {
		slog.Error("clear gift id registry failed", "key", INVENTORY_IDS_KEY, "error", err)
		return fmt.Errorf("clear gift id registry: %w", err)
	}
	if len(ids) > 0 {
		if err := GiftRedis.SAdd(INVENTORY_IDS_KEY, ids...).Err(); err != nil {
			slog.Error("create gift id registry failed", "key", INVENTORY_IDS_KEY, "count", len(ids), "error", err)
			return fmt.Errorf("create gift id registry: %w", err)
		}
	}
	slog.Info("gift id registry rebuilt", "key", INVENTORY_IDS_KEY, "count", len(ids))

	return nil
}

// GetAllGiftInventory 读取 Redis 中全部奖品实时库存。
// 这是兼容旧调用的便捷方法，失败时返回空结果；关键链路应优先使用 GetAllGiftInventoryWithError。
func GetAllGiftInventory() []*Gift {
	gifts, _ := GetAllGiftInventoryWithError()
	return gifts
}

// GetAllGiftInventoryWithError 用一次 SMEMBERS + 一次 MGET 批量读取全部奖品库存。
// 依赖 InitGiftInventory 在启动时建好的 INVENTORY_IDS_KEY 注册表拿到 id 列表，
// 再用 MGET 一次拉回全部 gift_count_{id} 值，总往返固定 2 次，不随奖品数增长。
//
// 原来的实现用 KEYS gift_count_* 扫描 + 逐 key GET，在 /lucky 每次请求 + 10 次重试
// 的热路径上会反复触发 O(N) keyspace 扫描并阻塞 Redis 单线程，压测越大越吃亏。
func GetAllGiftInventoryWithError() ([]*Gift, error) {
	if GiftRedis == nil {
		return nil, errors.New("redis client is nil")
	}

	// 1. SMEMBERS 拿奖品 ID 列表（O(M)，M=奖品数，通常 10 个左右）
	rawIDs, err := GiftRedis.SMembers(INVENTORY_IDS_KEY).Result()
	if err != nil {
		slog.Error("read gift id registry failed", "key", INVENTORY_IDS_KEY, "error", err)
		return nil, fmt.Errorf("read gift id registry: %w", err)
	}
	if len(rawIDs) == 0 {
		return nil, nil
	}

	// 2. 拼出 gift_count_{id} key 列表，一次 MGET 取回全部库存
	keys := make([]string, len(rawIDs))
	for i, raw := range rawIDs {
		keys[i] = INVENTORY_PREFIX + raw
	}

	values, err := GiftRedis.MGet(keys...).Result()
	if err != nil {
		slog.Error("mget gift inventory failed", "keys", keys, "error", err)
		return nil, fmt.Errorf("mget gift inventory: %w", err)
	}

	gifts := make([]*Gift, 0, len(rawIDs))
	for i, raw := range rawIDs {
		giftID, err := strconv.Atoi(raw)
		if err != nil {
			slog.Error("gift id in registry is not int", "raw", raw, "error", err)
			return nil, fmt.Errorf("parse gift id from registry %q: %w", raw, err)
		}

		count := 0
		if v := values[i]; v != nil {
			switch vv := v.(type) {
			case string:
				count, err = strconv.Atoi(vv)
			case int64:
				count = int(vv)
			default:
				err = fmt.Errorf("unexpected mget value type %T: %v", v, v)
			}
			if err != nil {
				slog.Error("parse gift count failed", "key", keys[i], "value", v, "error", err)
				return nil, fmt.Errorf("parse gift count %q: %w", keys[i], err)
			}
		}

		gifts = append(gifts, &Gift{Id: giftID, Count: count})
	}

	return gifts, nil
}

// GetGiftInventory 读取单个奖品的 Redis 实时库存。
// GiftId 是 gift id，即奖品 ID；返回 -1 表示读取失败，调用方不能把 -1 当作真实库存。
func GetGiftInventory(GiftId int) int {
	key := INVENTORY_PREFIX + strconv.Itoa(GiftId)
	count, err := GiftRedis.Get(key).Int()
	if err == nil {
		return count
	}
	slog.Error("gift count is not int", "key", key, "error", err)
	return -1
}

// ReduceInventory 直接扣减单个奖品 Redis 库存。
// 该函数只保留给旧测试或非核心场景；秒杀主链路必须走 TryAcquireLotteryAdmission 的 Lua 原子准入，
// 因为单独 DECR 不能同时保证防重复参与和写临时资格。
func ReduceInventory(GiftId int) error {
	key := INVENTORY_PREFIX + strconv.Itoa(GiftId)
	n, err := GiftRedis.Decr(key).Result()
	if err != nil {
		slog.Error("decr key failed", "key", key, "error", err)
		return fmt.Errorf("decr redis inventory %q: %w", key, err)
	}
	if n < 0 {
		msg := fmt.Sprintf("gift %d inventory is exhausted", GiftId)
		slog.Error(msg, "key", key, "count", n)
		if _, err := GiftRedis.Incr(key).Result(); err != nil {
			slog.Error("rollback negative inventory failed", "key", key, "error", err)
			return fmt.Errorf("%s and rollback failed: %w", msg, err)
		}
		return errors.New(msg)
	}
	return nil
}

// IncreaseInventory 仅保留给旧测试和人工修复使用。
// 新订单状态机必须走 ReleaseLotteryAdmission，把 cancelled 状态和首次回补绑定；直接 INCR 无法防止重复回补。
func IncreaseInventory(GiftId int) error {
	key := INVENTORY_PREFIX + strconv.Itoa(GiftId)
	if _, err := GiftRedis.Incr(key).Result(); err != nil {
		slog.Error("incr key failed", "key", key, "error", err)
		return fmt.Errorf("incr redis inventory %q: %w", key, err)
	}
	return nil
}
