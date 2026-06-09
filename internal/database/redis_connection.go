package database

import (
	"log/slog"
	"silas/internal/util"

	"github.com/go-redis/redis"
)

var (
	GiftRedis *redis.Client
)

func ConnectGiftRedis(confDir, confFile, fileType string) {
	viper := util.InitViper(confDir, confFile, fileType)

	GiftRedis = redis.NewClient(&redis.Options{
		Addr:     util.EnvString("LOTTERY_REDIS_ADDR", viper.GetString("addr")),
		Password: util.EnvString("LOTTERY_REDIS_PASSWORD", viper.GetString("pass")),
		DB:       util.EnvInt("LOTTERY_REDIS_DB", viper.GetInt("db")),
	})
	if err := GiftRedis.Ping().Err(); err != nil {
		slog.Error("connect to redis failed", "error", err)
	} else {
		slog.Info("connect to redis")
	}
}

// 关闭Redis连接
func CloseGiftRedis() {
	if GiftRedis != nil {
		GiftRedis.Close()
		slog.Info("close redis")
	}
}
