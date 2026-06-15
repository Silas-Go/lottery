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
)

// InitGiftInventory 从 MySQL 恢复 Redis 活动库存。
// Redis 不能简单恢复成 inventory.count 初始值，必须扣掉当前活动已完成订单；
// 否则服务重启后会把已经卖出的库存重新放回奖池，压测时看起来不超卖，长期运行却会超发。
func (s *Store) InitGiftInventory() error {
	gifts, err := s.GetAllGiftsWithError()
	if err != nil {
		return err
	}
	completedCounts, err := s.CompletedOrderCounts(DefaultActivityID)
	if err != nil {
		return err
	}

	for _, gift := range gifts {
		sold := completedCounts[gift.Id]
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
		slog.Info("gift inventory restored to redis", "activity_id", DefaultActivityID, "gift_id", gift.Id, "initial", gift.Count, "sold", sold, "remaining", remaining)
	}

	return nil
}

// GetAllGiftInventory 读取 Redis 中全部奖品实时库存。
// 这是兼容旧调用的便捷方法，失败时返回空结果；关键链路应优先使用 GetAllGiftInventoryWithError。
func GetAllGiftInventory() []*Gift {
	gifts, _ := GetAllGiftInventoryWithError()
	return gifts
}

// GetAllGiftInventoryWithError 读取 Redis 中全部奖品实时库存。
// 返回的 Gift 只保证 Id 和 Count 有业务意义；名称、价格、图片仍应从 MySQL inventory 表读取。
// 当前实现使用 KEYS 扫描 gift_count_*，奖品少时足够直观；大量活动或大量 key 时应改为活动维度 hash/MGET。
func GetAllGiftInventoryWithError() ([]*Gift, error) {
	if GiftRedis == nil {
		return nil, errors.New("redis client is nil")
	}

	keys, err := GiftRedis.Keys(INVENTORY_PREFIX + "*").Result()
	if err != nil {
		slog.Error("iterate all gift keys failed", "error", err)
		return nil, fmt.Errorf("iterate redis inventory keys: %w", err)
	}

	gifts := make([]*Gift, 0, len(keys))
	for _, key := range keys {
		idStr := key[len(INVENTORY_PREFIX):]
		id, err := strconv.Atoi(idStr)
		if err != nil {
			slog.Error("gift id is not int", "key", key, "error", err)
			return nil, fmt.Errorf("parse gift id from redis key %q: %w", key, err)
		}

		count, err := GiftRedis.Get(key).Int()
		if err != nil {
			slog.Error("gift count is not int", "key", key, "error", err)
			return nil, fmt.Errorf("read redis inventory %q: %w", key, err)
		}

		gifts = append(gifts, &Gift{Id: id, Count: count})
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

// IncreaseInventory 回补单个奖品的 Redis 库存。
// GiftId 是 gift id，即奖品 ID；该函数不检查用户资格，只适合在支付 claim 已删除临时资格后做失败兜底。
// 用户放弃和 MQ 超时释放仍应优先走 ReleaseLotteryAdmission，避免重复回补。
func IncreaseInventory(GiftId int) error {
	key := INVENTORY_PREFIX + strconv.Itoa(GiftId)
	if _, err := GiftRedis.Incr(key).Result(); err != nil {
		slog.Error("incr key failed", "key", key, "error", err)
		return fmt.Errorf("incr redis inventory %q: %w", key, err)
	}
	return nil
}
