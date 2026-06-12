package database

import (
	"errors"
	"fmt"
	"log/slog"
	"strconv"
)

const (
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

func GetAllGiftInventory() []*Gift {
	gifts, _ := GetAllGiftInventoryWithError()
	return gifts
}

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

func GetGiftInventory(GiftId int) int {
	key := INVENTORY_PREFIX + strconv.Itoa(GiftId)
	count, err := GiftRedis.Get(key).Int()
	if err == nil {
		return count
	}
	slog.Error("gift count is not int", "key", key, "error", err)
	return -1
}

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

func IncreaseInventory(GiftId int) error {
	key := INVENTORY_PREFIX + strconv.Itoa(GiftId)
	if _, err := GiftRedis.Incr(key).Result(); err != nil {
		slog.Error("incr key failed", "key", key, "error", err)
		return fmt.Errorf("incr redis inventory %q: %w", key, err)
	}
	return nil
}
