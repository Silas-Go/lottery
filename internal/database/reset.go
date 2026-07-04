package database

import (
	"errors"
	"fmt"
	"log/slog"
)

// ResetExperimentState 把本地秒杀实验恢复到一轮新压测前的真实业务状态。
// 它会清空正式订单、恢复 Cache-Aside 库存、清掉 Redis 临时资格和旧库存缓存，然后重建 Redis 预扣库存。
func (s *Store) ResetExperimentState() error {
	if s == nil {
		return errors.New("database store is nil")
	}
	if err := s.ResetOrders(); err != nil {
		return err
	}
	if err := s.ResetCacheStock(); err != nil {
		return err
	}
	if err := clearLotteryRedisState(); err != nil {
		return err
	}
	if err := s.InitGiftInventory(); err != nil {
		return err
	}
	slog.Info("experiment state reset")
	return nil
}

func clearLotteryRedisState() error {
	if GiftRedis == nil {
		return errors.New("redis client is nil")
	}
	patterns := []string{
		INVENTORY_PREFIX + "*",
		TEMP_ORDER_PREFIX + "*",
	}
	for _, pattern := range patterns {
		if err := deleteRedisKeysByPattern(pattern); err != nil {
			return err
		}
	}
	if err := GiftRedis.Del(INVENTORY_IDS_KEY, CACHE_ALL_STOCK_KEY).Err(); err != nil {
		return fmt.Errorf("delete redis reset keys: %w", err)
	}
	return nil
}

func deleteRedisKeysByPattern(pattern string) error {
	var cursor uint64
	for {
		keys, next, err := GiftRedis.Scan(cursor, pattern, 256).Result()
		if err != nil {
			return fmt.Errorf("scan redis keys %q: %w", pattern, err)
		}
		if len(keys) > 0 {
			if err := GiftRedis.Del(keys...).Err(); err != nil {
				return fmt.Errorf("delete redis keys %q: %w", pattern, err)
			}
		}
		cursor = next
		if cursor == 0 {
			return nil
		}
	}
}
