package database

import (
	"errors"
	"log/slog"
	"strconv"

	"github.com/go-redis/redis"
)

/*
临时订单
*/
const (
	TEMP_ORDER_PREFIX = "porder_"
)

// 创建临时订单
func CreateTempOrder(uid int, GiftId int) error {
	key := "porder_" + strconv.Itoa(uid)
	//把临时订单写入redis。key用uid，value为giftId
	if err := GiftRedis.Set(key, GiftId, 0).Err(); err != nil {
		return err
	}
	return nil
}

// 查询临时订单，返回商品id
func GetTempOrder(uid int) int {
	key := TEMP_ORDER_PREFIX + strconv.Itoa(uid)
	giftId, err := GiftRedis.Get(key).Int()
	if err != nil {
		if !errors.Is(err, redis.Nil) {
			slog.Error("query redis fail", "key", key, "error", err)
		}
		return 0
	} else {
		return giftId
	}
}

// 删除临时订单，返回删除的个数
func DeleteTempOrder(uid int, GiftId int) int64 {
	key := TEMP_ORDER_PREFIX + strconv.Itoa(uid)
	if n, err := GiftRedis.Del(key).Result(); err != nil { //n是删除的key的个数
		slog.Error("delete TempOrder failed", "error", err)
		return -1
	} else {
		return n
	}
}
