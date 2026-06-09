package database

import (
	"errors"
	"fmt"
	"log/slog"
	"strconv"

	"github.com/go-redis/redis"
)

const (
	TEMP_ORDER_PREFIX = "porder_"
)

func CreateTempOrder(uid int, GiftId int) error {
	key := TEMP_ORDER_PREFIX + strconv.Itoa(uid)
	if err := GiftRedis.Set(key, GiftId, 0).Err(); err != nil {
		slog.Error("create temp order failed", "key", key, "uid", uid, "gid", GiftId, "error", err)
		return fmt.Errorf("create temp order %q: %w", key, err)
	}
	slog.Info("create temp order success", "key", key, "uid", uid, "gid", GiftId)
	return nil
}

func GetTempOrder(uid int) int {
	key := TEMP_ORDER_PREFIX + strconv.Itoa(uid)
	giftId, err := GiftRedis.Get(key).Int()
	if err != nil {
		if !errors.Is(err, redis.Nil) {
			slog.Error("query temp order failed", "key", key, "uid", uid, "error", err)
		}
		return 0
	}
	return giftId
}

func DeleteTempOrder(uid int, GiftId int) int64 {
	key := TEMP_ORDER_PREFIX + strconv.Itoa(uid)
	n, err := GiftRedis.Del(key).Result()
	if err != nil {
		slog.Error("delete temp order failed", "key", key, "uid", uid, "gid", GiftId, "error", err)
		return -1
	}
	slog.Info("delete temp order success", "key", key, "uid", uid, "gid", GiftId, "deleted", n)
	return n
}
