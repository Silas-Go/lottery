package database

import (
	"log/slog"
	"silas/internal/util"

	"github.com/go-redis/redis"
)

var (
	// GiftRedis 是秒杀链路的 Redis 客户端。
	// Redis 在本项目中承接高并发库存、临时资格和 Lua 原子操作，不是最终订单事实源。
	GiftRedis *redis.Client
)

// ConnectGiftRedis 连接抽奖系统使用的 Redis。
// confDir/confFile/fileType 指向配置文件；LOTTERY_REDIS_* 环境变量会覆盖配置，
// 这样本机 Go 进程可以直接访问 Docker 映射出来的 Redis 端口。
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

// CloseGiftRedis 关闭 Redis 客户端连接。
// 关闭只释放客户端资源，不会清理 Redis 中的库存 key 或临时资格 key。
func CloseGiftRedis() {
	if GiftRedis != nil {
		GiftRedis.Close()
		slog.Info("close redis")
	}
}
