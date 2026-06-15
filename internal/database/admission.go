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
// admission 在本项目里表示“秒杀准入/临时抢购资格”，不是最终订单。
// 这里不用 bool，是为了把“抢到资格”“重复参与”“库存不足”区分开，
// handler 才能返回不同的业务错误和状态码，排查时也不会只看到一个模糊失败。
type AdmissionStatus string

const (
	// AdmissionAcquired 表示“准入成功”：Redis 已预扣库存，并写入用户临时资格。
	AdmissionAcquired AdmissionStatus = "OK"

	// AdmissionDuplicate 表示“重复参与”：同一 uid 已经持有临时资格。
	// uid 是 user id 的缩写，在本项目中表示参与秒杀的用户 ID。
	AdmissionDuplicate AdmissionStatus = "DUPLICATE"

	// AdmissionSoldOut 表示“库存不足”：当前 gid 对应的 Redis 库存已经为 0。
	// gid 是 gift id 的缩写，在本项目中表示奖品 ID。
	AdmissionSoldOut AdmissionStatus = "SOLD_OUT"
)

var (
	// ErrAdmissionDuplicate 表示 Redis 准入脚本判定用户已经持有临时资格。
	// 这个错误不是系统异常，而是“同一用户重复参与同一活动”的业务失败。
	ErrAdmissionDuplicate = errors.New("lottery admission duplicate")
	// ErrAdmissionSoldOut 表示 Redis 中指定奖品已经没有可预扣库存。
	// 调用方可以选择重新抽取其他奖品，或者返回活动库存不足。
	ErrAdmissionSoldOut = errors.New("lottery admission sold out")
)

// acquireAdmissionScript 是抽奖准入的 Redis 原子边界。
//
// KEYS:
//
//	KEYS[1] stockKey     奖品库存 key，例如 gift_count_3，表示 gid=3 的 Redis 可用库存。
//	KEYS[2] tempOrderKey 用户临时资格 key，例如 porder_10001，表示 uid=10001 当前占有的奖品资格。
//
// ARGV:
//
//	ARGV[1] giftID     当前候选奖品 ID，会写入 tempOrderKey，后续支付/放弃都要用它校验资格归属。
//	ARGV[2] ttlSeconds 临时资格有效期，单位秒。TTL 是 Time To Live 的缩写。
//
// 返回值:
//
//	"OK"        准入成功：已扣减 stockKey，并写入 tempOrderKey。
//	"DUPLICATE" 重复参与：该 uid 已经持有临时资格。
//	"SOLD_OUT"  库存不足：该 gid 没有可用 Redis 库存。
//
// 原子性:
//
//	秒杀入口不能把“防重复、查库存、扣库存、写临时资格”拆成多条普通命令，
//	否则高并发下会出现两个请求同时通过库存检查，最终导致超卖或重复资格。
//	Lua 脚本把这些动作绑定成一个不可插队的操作，并返回清晰的业务状态。
//
// 注意:
//
//	TTL 过期只会删除 tempOrderKey，不会自动回补 stockKey。
//	因此准入成功后仍需要 RocketMQ 延时取消消息或后续补偿任务兜底库存悬挂。
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
// release 在本项目里表示“释放临时资格并回补库存”。
//
// KEYS:
//
//	KEYS[1] stockKey     奖品库存 key，例如 gift_count_3。
//	KEYS[2] tempOrderKey 用户临时资格 key，例如 porder_10001。
//
// ARGV:
//
//	ARGV[1] giftID 当前要释放的奖品 ID，必须和 tempOrderKey 中保存的值一致。
//
// 返回值:
//
//	1 表示释放成功：删除 tempOrderKey，并给 stockKey 加 1。
//	0 表示没有释放：资格不存在、已经被支付 claim、已经被其他补偿释放，或 giftID 不匹配。
//
// 幂等性:
//
//	释放库存前必须确认临时资格仍然属于同一个用户和奖品；如果用户已经支付，
//	或资格已经被其他补偿路径释放，就不能再次加库存，否则会出现库存被回补两次。
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
// claim 在本项目里表示“用户支付前确认自己仍然持有临时资格”。
//
// KEYS:
//
//	KEYS[1] tempOrderKey 用户临时资格 key，例如 porder_10001。
//
// ARGV:
//
//	ARGV[1] giftID 当前支付的奖品 ID，必须和 tempOrderKey 中保存的值一致。
//
// 返回值:
//
//	1 表示认领成功：删除 tempOrderKey，不回补库存，后续应写入 MySQL 正式订单。
//	0 表示认领失败：资格不存在、已超时释放，或 giftID 不匹配。
//
// 并发边界:
//
//	支付路径只删除临时资格，不回补库存；MQ 超时释放路径也会尝试删除同一个资格。
//	两者共用 Redis 原子判断，保证同一份资格只能被支付或超时释放其中一方消费。
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
// 参数语义:
//
//	uid    user id，用户 ID，用来生成 tempOrderKey，防止同一用户重复持有资格。
//	giftID gift id，奖品 ID，用来定位 Redis 库存 key。
//	ttl    Time To Live，临时资格有效期；到期只删除资格 key，不自动回补库存。
//
// Redis 这里只承担高并发入口的预扣库存和临时资格控制，不直接创建最终订单。
// 如果 MQ 后续无法入队，service 会调用释放逻辑回滚，避免用户长期占着库存。
func TryAcquireLotteryAdmission(uid int, giftID int, ttl time.Duration) (AdmissionStatus, error) {
	if GiftRedis == nil {
		return "", errors.New("redis client is nil")
	}

	stockKey := inventoryKey(giftID) // stockKey 是奖品库存 key，例如 gift_count_3。
	orderKey := tempOrderKey(uid)    // orderKey 是用户临时资格 key，例如 porder_10001。
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
// 参数语义:
//
//	uid    user id，用户 ID，用来定位 porder_{uid} 临时资格。
//	giftID gift id，奖品 ID，用来校验资格归属并回补对应库存。
//
// 该函数故意和支付认领使用同一份临时资格作为并发边界，解决“用户支付”和
// “MQ 超时释放”同时发生时的竞态；返回 false 表示资格已经不存在或不匹配。
func ReleaseLotteryAdmission(uid int, giftID int) (bool, error) {
	if GiftRedis == nil {
		return false, errors.New("redis client is nil")
	}

	stockKey := inventoryKey(giftID) // stockKey 是被回补的奖品库存 key。
	orderKey := tempOrderKey(uid)    // orderKey 必须仍保存 giftID，才允许回补库存。
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
// 参数语义:
//
//	uid    user id，用户 ID，用来定位 porder_{uid} 临时资格。
//	giftID gift id，奖品 ID，用来确认用户支付的是自己抢到的奖品。
//
// 认领成功后库存不会回补，因为这份库存即将进入 MySQL 正式订单。
// 如果这里返回 false，说明用户没有资格、资格过期，或已被超时补偿释放。
func ClaimLotteryAdmission(uid int, giftID int) (bool, error) {
	if GiftRedis == nil {
		return false, errors.New("redis client is nil")
	}

	orderKey := tempOrderKey(uid) // orderKey 是支付要认领的用户临时资格 key。
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

// inventoryKey 生成 Redis 奖品库存 key。
// giftID 是 gift id，即奖品 ID；例如 giftID=3 时 key 为 gift_count_3。
// 该 key 保存当前还能被预扣的库存数量，是高并发防超卖的核心计数器。
func inventoryKey(giftID int) string {
	return INVENTORY_PREFIX + strconv.Itoa(giftID)
}

// tempOrderKey 生成 Redis 用户临时资格 key。
// uid 是 user id，即用户 ID；例如 uid=10001 时 key 为 porder_10001。
// 该 key 的值是用户抢到的 giftID，用来防重复参与、支付认领和超时释放。
func tempOrderKey(uid int) string {
	return TEMP_ORDER_PREFIX + strconv.Itoa(uid)
}

// redisBool 将 Lua 返回的 1/0 转换为 Go 布尔值。
// Redis Lua 在不同客户端版本下可能返回 int64、int 或字符串；
// 这里集中兼容，避免支付、放弃、MQ 补偿各自写一套判断导致边界不一致。
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
