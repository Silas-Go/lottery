package database

import (
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/go-redis/redis"
)

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

func TryAcquireLotteryAdmission(uid int, giftID int, ttl time.Duration) (AdmissionStatus, error) {
	if GiftRedis == nil {
		return "", errors.New("redis client is nil")
	}

	result, err := acquireAdmissionScript.Run(
		GiftRedis,
		[]string{inventoryKey(giftID), tempOrderKey(uid)},
		giftID,
		int(ttl.Seconds()),
	).Result()
	if err != nil {
		return "", fmt.Errorf("run acquire admission script: %w", err)
	}

	status, ok := result.(string)
	if !ok {
		return "", fmt.Errorf("unexpected acquire admission result %T: %v", result, result)
	}

	switch AdmissionStatus(status) {
	case AdmissionAcquired:
		return AdmissionAcquired, nil
	case AdmissionDuplicate:
		return AdmissionDuplicate, ErrAdmissionDuplicate
	case AdmissionSoldOut:
		return AdmissionSoldOut, ErrAdmissionSoldOut
	default:
		return "", fmt.Errorf("unknown admission status %q", status)
	}
}

func ReleaseLotteryAdmission(uid int, giftID int) (bool, error) {
	if GiftRedis == nil {
		return false, errors.New("redis client is nil")
	}

	result, err := releaseAdmissionScript.Run(
		GiftRedis,
		[]string{inventoryKey(giftID), tempOrderKey(uid)},
		giftID,
	).Result()
	if err != nil {
		return false, fmt.Errorf("run release admission script: %w", err)
	}
	return redisBool(result)
}

func ClaimLotteryAdmission(uid int, giftID int) (bool, error) {
	if GiftRedis == nil {
		return false, errors.New("redis client is nil")
	}

	result, err := claimAdmissionScript.Run(
		GiftRedis,
		[]string{tempOrderKey(uid)},
		giftID,
	).Result()
	if err != nil {
		return false, fmt.Errorf("run claim admission script: %w", err)
	}
	return redisBool(result)
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
