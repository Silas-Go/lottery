package database

import (
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/go-redis/redis"
)

// AdmissionStatus 表示 Redis 准入脚本返回的业务状态。
// 这里不用 bool，是为了把“抢到资格”“重复参与”“库存不足”区分开，
// handler 才能返回不同的业务错误和状态码，排查时也不会只看到一个模糊失败。
type AdmissionStatus string

const (
	AdmissionAcquired  AdmissionStatus = "OK"
	AdmissionDuplicate AdmissionStatus = "DUPLICATE"
	AdmissionSoldOut   AdmissionStatus = "SOLD_OUT"
)

var (
	ErrAdmissionDuplicate = errors.New("lottery admission duplicate")
	ErrAdmissionSoldOut   = errors.New("lottery admission sold out")
)

// acquireAdmissionScript 是抽奖准入的 Redis 原子边界。
//
// 秒杀入口不能把“防重复、查库存、扣库存、写临时资格”拆成多条普通命令，
// 否则高并发下会出现两个请求同时通过库存检查，最终导致超卖或重复资格。
// Lua 脚本把这些动作绑定成一个不可插队的操作，并返回清晰的业务状态。
var acquireAdmissionScript = redis.NewScript(`
local stockKey = KEYS[1]
local tempOrderKey = KEYS[2]
local giftID = ARGV[1]
local ttlSeconds = tonumber(ARGV[2])

if redis.call("EXISTS", tempOrderKey) == 1 then
	return "DUPLICATE"
end

local stock = tonumber(redis.call("GET", stockKey) or "0")
if stock <= 0 then
	return "SOLD_OUT"
end

redis.call("DECR", stockKey)
if ttlSeconds and ttlSeconds > 0 then
	redis.call("SET", tempOrderKey, giftID, "EX", ttlSeconds)
else
	redis.call("SET", tempOrderKey, giftID)
end

return "OK"
`)

// releaseAdmissionScript 统一处理用户放弃、MQ 超时补偿和失败回滚。
//
// 释放库存前必须确认临时资格仍然属于同一个用户和奖品；如果用户已经支付，
// 或资格已经被其他补偿路径释放，就不能再次加库存，否则会出现库存被回补两次。
var releaseAdmissionScript = redis.NewScript(`
local stockKey = KEYS[1]
local tempOrderKey = KEYS[2]
local giftID = ARGV[1]

local currentGiftID = redis.call("GET", tempOrderKey)
if not currentGiftID then
	return 0
end
if tostring(currentGiftID) ~= tostring(giftID) then
	return 0
end

redis.call("DEL", tempOrderKey)
redis.call("INCR", stockKey)
return 1
`)

// claimAdmissionScript 用于支付认领临时资格。
//
// 支付路径只删除临时资格，不回补库存；MQ 超时释放路径也会尝试删除同一个资格。
// 两者共用 Redis 原子判断，保证同一份资格只能被支付或超时释放其中一方消费。
var claimAdmissionScript = redis.NewScript(`
local tempOrderKey = KEYS[1]
local giftID = ARGV[1]

local currentGiftID = redis.call("GET", tempOrderKey)
if not currentGiftID then
	return 0
end
if tostring(currentGiftID) ~= tostring(giftID) then
	return 0
end

redis.call("DEL", tempOrderKey)
return 1
`)

// TryAcquireLotteryAdmission 尝试为用户发放指定奖品的临时抢购资格。
//
// Redis 这里只承担高并发入口的预扣库存和临时资格控制，不直接创建最终订单。
// 如果 MQ 后续无法入队，service 会调用释放逻辑回滚，避免用户长期占着库存。
func TryAcquireLotteryAdmission(uid int, giftID int, ttl time.Duration) (AdmissionStatus, error) {
	if GiftRedis == nil {
		return "", errors.New("redis client is nil")
	}

	stockKey := inventoryKey(giftID)
	orderKey := tempOrderKey(uid)
	result, err := acquireAdmissionScript.Run(
		GiftRedis,
		[]string{stockKey, orderKey},
		giftID,
		int(ttl.Seconds()),
	).Result()
	if err != nil {
		slog.Error("redis admission acquire script failed", "uid", uid, "gid", giftID, "stock_key", stockKey, "temp_order_key", orderKey, "ttl_seconds", int(ttl.Seconds()), "error", err)
		return "", fmt.Errorf("run acquire admission script: %w", err)
	}

	status, ok := result.(string)
	if !ok {
		slog.Error("redis admission acquire script returned unexpected type", "uid", uid, "gid", giftID, "stock_key", stockKey, "temp_order_key", orderKey, "result", result)
		return "", fmt.Errorf("unexpected acquire admission result %T: %v", result, result)
	}

	switch AdmissionStatus(status) {
	case AdmissionAcquired:
		slog.Debug("redis admission acquired", "uid", uid, "gid", giftID, "stock_key", stockKey, "temp_order_key", orderKey)
		return AdmissionAcquired, nil
	case AdmissionDuplicate:
		slog.Debug("redis admission duplicate", "uid", uid, "gid", giftID, "stock_key", stockKey, "temp_order_key", orderKey)
		return AdmissionDuplicate, ErrAdmissionDuplicate
	case AdmissionSoldOut:
		slog.Debug("redis admission sold out", "uid", uid, "gid", giftID, "stock_key", stockKey, "temp_order_key", orderKey)
		return AdmissionSoldOut, ErrAdmissionSoldOut
	default:
		slog.Error("redis admission acquire script returned unknown status", "uid", uid, "gid", giftID, "stock_key", stockKey, "temp_order_key", orderKey, "status", status)
		return "", fmt.Errorf("unknown admission status %q", status)
	}
}

// ReleaseLotteryAdmission 释放用户尚未支付的临时抢购资格并回补库存。
//
// 该函数故意和支付认领使用同一份临时资格作为并发边界，解决“用户支付”和
// “MQ 超时释放”同时发生时的竞态；返回 false 表示资格已经不存在或不匹配。
func ReleaseLotteryAdmission(uid int, giftID int) (bool, error) {
	if GiftRedis == nil {
		return false, errors.New("redis client is nil")
	}

	stockKey := inventoryKey(giftID)
	orderKey := tempOrderKey(uid)
	result, err := releaseAdmissionScript.Run(
		GiftRedis,
		[]string{stockKey, orderKey},
		giftID,
	).Result()
	if err != nil {
		slog.Error("redis admission release script failed", "uid", uid, "gid", giftID, "stock_key", stockKey, "temp_order_key", orderKey, "error", err)
		return false, fmt.Errorf("run release admission script: %w", err)
	}
	released, err := redisBool(result)
	if err != nil {
		slog.Error("redis admission release script returned unexpected result", "uid", uid, "gid", giftID, "stock_key", stockKey, "temp_order_key", orderKey, "result", result, "error", err)
		return false, err
	}
	slog.Debug("redis admission release completed", "uid", uid, "gid", giftID, "released", released, "stock_key", stockKey, "temp_order_key", orderKey)
	return released, nil
}

// ClaimLotteryAdmission 在支付前认领用户的临时抢购资格。
//
// 认领成功后库存不会回补，因为这份库存即将进入 MySQL 正式订单。
// 如果这里返回 false，说明用户没有资格、资格过期，或已被超时补偿释放。
func ClaimLotteryAdmission(uid int, giftID int) (bool, error) {
	if GiftRedis == nil {
		return false, errors.New("redis client is nil")
	}

	orderKey := tempOrderKey(uid)
	result, err := claimAdmissionScript.Run(
		GiftRedis,
		[]string{orderKey},
		giftID,
	).Result()
	if err != nil {
		slog.Error("redis admission claim script failed", "uid", uid, "gid", giftID, "temp_order_key", orderKey, "error", err)
		return false, fmt.Errorf("run claim admission script: %w", err)
	}
	claimed, err := redisBool(result)
	if err != nil {
		slog.Error("redis admission claim script returned unexpected result", "uid", uid, "gid", giftID, "temp_order_key", orderKey, "result", result, "error", err)
		return false, err
	}
	slog.Debug("redis admission claim completed", "uid", uid, "gid", giftID, "claimed", claimed, "temp_order_key", orderKey)
	return claimed, nil
}

func inventoryKey(giftID int) string {
	return INVENTORY_PREFIX + strconv.Itoa(giftID)
}

func tempOrderKey(uid int) string {
	return TEMP_ORDER_PREFIX + strconv.Itoa(uid)
}

func redisBool(result any) (bool, error) {
	switch value := result.(type) {
	case int64:
		return value == 1, nil
	case int:
		return value == 1, nil
	case string:
		return value == "1", nil
	default:
		return false, fmt.Errorf("unexpected redis boolean result %T: %v", result, result)
	}
}
