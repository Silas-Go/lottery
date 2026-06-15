package database

import (
	"errors"
	"fmt"
	"log/slog"
	"strconv"

	"github.com/go-redis/redis"
)

const (
	// TEMP_ORDER_PREFIX 是 Redis 用户临时资格 key 的前缀。
	// 完整 key 形如 porder_10001，表示 uid=10001 的用户当前持有某个 gift id 的待支付资格。
	TEMP_ORDER_PREFIX = "porder_"
)

// CreateTempOrder 创建用户临时资格。
// 这是旧版非 Lua 链路的辅助函数；当前秒杀主链路应使用 TryAcquireLotteryAdmission，
// 因为只有 Lua 才能把防重复、扣库存、写临时资格绑定成一个原子动作。
func CreateTempOrder(uid int, GiftId int) error {
	key := TEMP_ORDER_PREFIX + strconv.Itoa(uid)
	if err := GiftRedis.Set(key, GiftId, 0).Err(); err != nil {
		slog.Error("create temp order failed", "key", key, "uid", uid, "gid", GiftId, "error", err)
		return fmt.Errorf("create temp order %q: %w", key, err)
	}
	slog.Info("create temp order success", "key", key, "uid", uid, "gid", GiftId)
	return nil
}

// GetTempOrder 查询用户当前持有的临时资格。
// uid 是 user id，返回值是 gift id；返回 0 表示没有资格或 Redis 查询失败。
// 业务主链路不要只依赖这个结果做扣库存决策，否则会产生先查后改的竞态。
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

// DeleteTempOrder 删除用户临时资格。
// 这是旧版非 Lua 链路的辅助函数；当前释放库存必须优先使用 ReleaseLotteryAdmission，
// 因为 release 脚本会同时校验 gift id 并回补库存，避免重复释放或误释放。
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
