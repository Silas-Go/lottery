package database

import (
	"dqq/go/frame/lottery/util"
	"log/slog"

	"github.com/go-redis/redis"
)

var (
	GiftRedis *redis.Client
)

func ConnectGiftRedis(confDir, confFile, fileType string) {
	viper := util.InitViper(confDir, confFile, fileType)

	GiftRedis = redis.NewClient(&redis.Options{
		Addr:     viper.GetString("addr"),
		Password: viper.GetString("pass"),
		DB:       viper.GetInt("db"),
	})
	if err := GiftRedis.Ping().Err(); err != nil {
		slog.Error("connect to redis failed", "error", err)
	} else {
		slog.Info("connect to redis")
	}
}

// 关闭Redis连接
func CloseGiftRedis() {
	if GiftDB != nil {
		GiftRedis.Close()
		slog.Info("close redis")
	}
}
