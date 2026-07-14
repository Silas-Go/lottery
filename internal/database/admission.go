package database

import (
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/go-redis/redis"
)

// AdmissionStatus 是 Redis 准入动作的结果，不是订单生命周期状态。
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

// LotteryAdmission 是 Redis 模式在 MySQL 订单建立前后的实时准入状态。
// Value 使用 giftID|state，例如 3|pending_payment；旧版仅保存 giftID 的值按 pending_payment 兼容读取。
type LotteryAdmission struct {
	GiftID int
	State  OrderStatus
}

// acquireAdmissionScript 原子完成防重、库存扣减和 stock_acquired 状态建立。
// KEYS[1] 是 gift_count_{gid}，KEYS[2] 是 porder_{uid}；ARGV[1] 是 gid，ARGV[2] 是 TTL 秒数。
// TTL 只负责清理长期残留状态，不负责回补库存；库存释放必须通过 releaseAdmissionScript。
var acquireAdmissionScript = redis.NewScript(`
local stockKey = KEYS[1]
local admissionKey = KEYS[2]
local giftID = ARGV[1]
local ttlSeconds = tonumber(ARGV[2])

if redis.call("EXISTS", admissionKey) == 1 then
	return "DUPLICATE"
end

local stock = tonumber(redis.call("GET", stockKey) or "0")
if stock <= 0 then
	return "SOLD_OUT"
end

redis.call("DECR", stockKey)
local value = tostring(giftID) .. "|stock_acquired"
if ttlSeconds and ttlSeconds > 0 then
	redis.call("SET", admissionKey, value, "EX", ttlSeconds)
else
	redis.call("SET", admissionKey, value)
end
return "OK"
`)

// markPendingPaymentScript 把 MQ 已成功建立 MySQL 订单的结果投影回 Redis。
// 只允许 stock_acquired -> pending_payment；重复消息看到 pending_payment 返回 2，终态返回 0。
var markPendingPaymentScript = redis.NewScript(`
local admissionKey = KEYS[1]
local giftID = tostring(ARGV[1])
local current = redis.call("GET", admissionKey)
if not current then return 0 end

local currentGiftID, state = string.match(tostring(current), "^([^|]+)|(.+)$")
if not currentGiftID then
	currentGiftID = tostring(current)
	state = "pending_payment"
end
if currentGiftID ~= giftID then return 0 end
if state == "pending_payment" then return 2 end
if state ~= "stock_acquired" then return 0 end

local ttl = redis.call("PTTL", admissionKey)
local value = giftID .. "|pending_payment"
if ttl > 0 then redis.call("SET", admissionKey, value, "PX", ttl)
else redis.call("SET", admissionKey, value) end
return 1
`)

// claimAdmissionScript 是 Redis 模式下支付与取消的并发裁决点。
// 只允许 pending_payment -> paid；重复支付看到 paid 返回 2，不删除 key，供迟到取消识别终态。
var claimAdmissionScript = redis.NewScript(`
local admissionKey = KEYS[1]
local giftID = tostring(ARGV[1])
local current = redis.call("GET", admissionKey)
if not current then return 0 end

local currentGiftID, state = string.match(tostring(current), "^([^|]+)|(.+)$")
if not currentGiftID then
	currentGiftID = tostring(current)
	state = "pending_payment"
end
if currentGiftID ~= giftID then return 0 end
if state == "paid" then return 2 end
if state ~= "pending_payment" then return 0 end

local ttl = redis.call("PTTL", admissionKey)
local value = giftID .. "|paid"
if ttl > 0 then redis.call("SET", admissionKey, value, "PX", ttl)
else redis.call("SET", admissionKey, value) end
return 1
`)

// releaseAdmissionScript 是 Redis 模式唯一允许增加库存的取消边界。
// stock_acquired/pending_payment -> cancelled 时回补一次；重复 cancelled 返回 2，paid 或不存在返回 0。
// 终态保留到 TTL，避免重复延迟消息在 key 被删除后无法判断是否已经回补。
var releaseAdmissionScript = redis.NewScript(`
local stockKey = KEYS[1]
local admissionKey = KEYS[2]
local giftID = tostring(ARGV[1])
local current = redis.call("GET", admissionKey)
if not current then return 0 end

local currentGiftID, state = string.match(tostring(current), "^([^|]+)|(.+)$")
if not currentGiftID then
	currentGiftID = tostring(current)
	state = "pending_payment"
end
if currentGiftID ~= giftID then return 0 end
if state == "cancelled" then return 2 end
if state ~= "stock_acquired" and state ~= "pending_payment" then return 0 end

redis.call("INCR", stockKey)
local ttl = redis.call("PTTL", admissionKey)
local value = giftID .. "|cancelled"
if ttl > 0 then redis.call("SET", admissionKey, value, "PX", ttl)
else redis.call("SET", admissionKey, value) end
return 1
`)

// TryAcquireLotteryAdmission 发放 Redis 库存资格并进入 stock_acquired。
func TryAcquireLotteryAdmission(uid int, giftID int, ttl time.Duration) (AdmissionStatus, error) {
	if GiftRedis == nil {
		return "", errors.New("redis client is nil")
	}
	stockKey := inventoryKey(giftID)
	admissionKey := tempOrderKey(uid)
	result, err := acquireAdmissionScript.Run(GiftRedis, []string{stockKey, admissionKey}, giftID, int(ttl.Seconds())).Result()
	if err != nil {
		return "", fmt.Errorf("run acquire admission script: %w", err)
	}
	status, ok := result.(string)
	if !ok {
		return "", fmt.Errorf("unexpected acquire admission result %T: %v", result, result)
	}
	switch AdmissionStatus(status) {
	case AdmissionAcquired:
		slog.Debug("redis admission entered stock_acquired", "uid", uid, "gid", giftID)
		return AdmissionAcquired, nil
	case AdmissionDuplicate:
		return AdmissionDuplicate, ErrAdmissionDuplicate
	case AdmissionSoldOut:
		return AdmissionSoldOut, ErrAdmissionSoldOut
	default:
		return "", fmt.Errorf("unknown admission status %q", status)
	}
}

// GetLotteryAdmission 查询 Redis 模式的实时状态；不存在时返回 nil, nil。
func GetLotteryAdmission(uid int) (*LotteryAdmission, error) {
	if GiftRedis == nil {
		return nil, errors.New("redis client is nil")
	}
	raw, err := GiftRedis.Get(tempOrderKey(uid)).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get lottery admission: %w", err)
	}
	admission, err := parseAdmission(raw)
	if err != nil {
		return nil, fmt.Errorf("parse lottery admission: %w", err)
	}
	return admission, nil
}

// UnpersistedAdmissionCounts 统计尚未写入 MySQL 的 Redis 库存占用。
// stock_acquired/pending_payment/paid 都仍占用库存；只有 cancelled 已回补，不应在恢复时重复扣除。
func (s *Store) UnpersistedAdmissionCounts(activityID int) (map[int]int, error) {
	if GiftRedis == nil {
		return nil, errors.New("redis client is nil")
	}
	counts := make(map[int]int)
	var cursor uint64
	for {
		keys, next, err := GiftRedis.Scan(cursor, TEMP_ORDER_PREFIX+"*", 256).Result()
		if err != nil {
			return nil, fmt.Errorf("scan stock_acquired admissions: %w", err)
		}
		for _, key := range keys {
			uid, parseErr := strconv.Atoi(strings.TrimPrefix(key, TEMP_ORDER_PREFIX))
			if parseErr != nil {
				continue
			}
			raw, getErr := GiftRedis.Get(key).Result()
			if errors.Is(getErr, redis.Nil) {
				continue
			}
			if getErr != nil {
				return nil, fmt.Errorf("read stock_acquired admission %q: %w", key, getErr)
			}
			admission, parseErr := parseAdmission(raw)
			if parseErr != nil || admission.State == OrderStatusCancelled {
				continue
			}
			// 消费者可能已建账但尚未来得及推进 Redis；该订单已由 CompletedOrderCounts 统计，不能重复扣除。
			_, findErr := s.FindOrder(activityID, uid)
			if findErr == nil {
				continue
			}
			if !errors.Is(findErr, ErrOrderNotFound) {
				return nil, findErr
			}
			counts[admission.GiftID]++
		}
		cursor = next
		if cursor == 0 {
			return counts, nil
		}
	}
}

// MarkLotteryAdmissionPendingPayment 在异步订单落库后推进 stock_acquired -> pending_payment。
// 返回 true 也可能表示重复消息已经推进过，因此消费者可以安全 Ack。
func MarkLotteryAdmissionPendingPayment(uid, giftID int) (bool, error) {
	if GiftRedis == nil {
		return false, errors.New("redis client is nil")
	}
	result, err := markPendingPaymentScript.Run(GiftRedis, []string{tempOrderKey(uid)}, giftID).Result()
	if err != nil {
		return false, fmt.Errorf("mark admission pending_payment: %w", err)
	}
	n, err := redisInt(result)
	return n == 1 || n == 2, err
}

// ClaimLotteryAdmission 原子执行 pending_payment -> paid。
// 返回 true 包含首次支付和 paid 幂等重试；cancelled/stock_acquired/不存在返回 false。
func ClaimLotteryAdmission(uid int, giftID int) (bool, error) {
	if GiftRedis == nil {
		return false, errors.New("redis client is nil")
	}
	result, err := claimAdmissionScript.Run(GiftRedis, []string{tempOrderKey(uid)}, giftID).Result()
	if err != nil {
		return false, fmt.Errorf("claim lottery admission: %w", err)
	}
	n, err := redisInt(result)
	return n == 1 || n == 2, err
}

// ReleaseLotteryAdmission 原子执行非终态 -> cancelled 并回补 Redis 库存。
// 返回 true 仅表示本次调用首次完成回补；重复取消返回 false，调用方可读取 admission 判断幂等终态。
func ReleaseLotteryAdmission(uid int, giftID int) (bool, error) {
	if GiftRedis == nil {
		return false, errors.New("redis client is nil")
	}
	result, err := releaseAdmissionScript.Run(GiftRedis, []string{inventoryKey(giftID), tempOrderKey(uid)}, giftID).Result()
	if err != nil {
		return false, fmt.Errorf("release lottery admission: %w", err)
	}
	n, err := redisInt(result)
	return n == 1, err
}

func parseAdmission(raw string) (*LotteryAdmission, error) {
	parts := strings.SplitN(raw, "|", 2)
	giftID, err := strconv.Atoi(parts[0])
	if err != nil {
		return nil, fmt.Errorf("invalid gift id %q: %w", parts[0], err)
	}
	state := OrderStatusPendingPayment // 兼容旧版 porder_{uid}=giftID。
	if len(parts) == 2 {
		state = OrderStatus(parts[1])
	}
	switch state {
	case OrderStatusStockAcquired, OrderStatusPendingPayment, OrderStatusPaid, OrderStatusCancelled:
		return &LotteryAdmission{GiftID: giftID, State: state}, nil
	default:
		return nil, fmt.Errorf("invalid admission state %q", state)
	}
}

func inventoryKey(giftID int) string {
	return INVENTORY_PREFIX + strconv.Itoa(giftID)
}

func tempOrderKey(uid int) string {
	return TEMP_ORDER_PREFIX + strconv.Itoa(uid)
}

func redisInt(result any) (int64, error) {
	switch value := result.(type) {
	case int64:
		return value, nil
	case int:
		return int64(value), nil
	case string:
		return strconv.ParseInt(value, 10, 64)
	default:
		return 0, fmt.Errorf("unexpected redis integer result %T: %v", result, result)
	}
}
