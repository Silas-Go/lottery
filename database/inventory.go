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

func InitGiftInventory() error {
	gifts, err := GetAllGiftsWithError()
	if err != nil {
		return err
	}

	for _, gift := range gifts {
		if gift.Count <= 0 {
			slog.Warn("gift count is zero", "id", gift.Id, "name", gift.Name)
			continue
		}

		key := INVENTORY_PREFIX + strconv.Itoa(gift.Id)
		if err := GiftRedis.Set(key, gift.Count, 0).Err(); err != nil {
			slog.Error("set gift count to redis failed", "gift_id", gift.Id, "key", key, "error", err)
			return fmt.Errorf("set gift %d inventory to redis: %w", gift.Id, err)
		}
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
