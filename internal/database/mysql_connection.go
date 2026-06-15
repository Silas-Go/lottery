package database

import (
	"fmt"
	"log"
	"log/slog"
	"os"
	"path"
	"silas/internal/util"
	"time"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Store 封装 MySQL 连接。
// service 层只依赖 Store 暴露的业务方法，不直接操作 gorm.DB，避免 SQL 细节泄漏到业务流程中。
type Store struct {
	db *gorm.DB
}

// NewStore 使用已有 gorm.DB 创建 Store。
// 主要用于集中管理数据库访问边界，后续测试也可以注入替代连接。
func NewStore(db *gorm.DB) *Store {
	return &Store{db: db}
}

// ConnectGiftDB 连接抽奖系统使用的 MySQL 数据库。
//
// 参数语义:
//
//	confDir  配置文件目录，例如 ./conf。
//	confFile 配置文件名，不带后缀，例如 mysql。
//	fileType 配置文件类型，例如 util.YAML。
//	logDir   GORM SQL 日志文件路径。
//
// 环境变量 LOTTERY_MYSQL_* 会覆盖配置文件，方便“依赖跑 Docker，Go app 本机跑”的本地开发模式。
func ConnectGiftDB(confDir, confFile, fileType, logDir string) *Store {
	viper := util.InitViper(confDir, confFile, fileType)
	user := viper.GetString("lottery.user")
	pass := viper.GetString("lottery.pass")
	host := viper.GetString("lottery.host")
	port := viper.GetInt("lottery.port")
	dbname := "lottery"
	logFileName := viper.GetString("lottery.log")
	user = util.EnvString("LOTTERY_MYSQL_USER", user)
	pass = util.EnvString("LOTTERY_MYSQL_PASSWORD", pass)
	host = util.EnvString("LOTTERY_MYSQL_HOST", host)
	port = util.EnvInt("LOTTERY_MYSQL_PORT", port)
	dbname = util.EnvString("LOTTERY_MYSQL_DATABASE", dbname)
	DataSourceName := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?charset=utf8mb4&collation=utf8mb4_unicode_ci&parseTime=True&loc=Local", user, pass, host, port, dbname)

	//日志控制
	logFile, _ := os.OpenFile(path.Join(logDir, logFileName), os.O_CREATE|os.O_APPEND|os.O_WRONLY, os.ModePerm)
	newLogger := logger.New(
		log.New(logFile, "\r\n", log.LstdFlags), // io writer，可以输出到文件，也可以输出到os.Stdout
		logger.Config{
			SlowThreshold:             100 * time.Millisecond, //耗时超过此值认定为慢查询
			LogLevel:                  logger.Info,            // LogLevel的最低阈值，Silent为不输出日志
			IgnoreRecordNotFoundError: true,                   // 忽略RecordNotFound这种错误日志
			Colorful:                  false,                  // 禁用颜色
		},
	)
	db, err := gorm.Open(mysql.Open(DataSourceName), &gorm.Config{
		PrepareStmt:            true,      //执行任何SQL时都会创建一个prepared statement并将其缓存，以提高后续的效率
		SkipDefaultTransaction: true,      // 为了确保数据一致性，GORM 会在事务里执行写入操作（创建、更新、删除）。如果没有这方面的要求，您可以在初始化时禁用它，这将获得大约 30%+ 性能提升。
		Logger:                 newLogger, //日志控制
	})
	if err != nil {
		panic(err)
	}

	//连接池控制参数
	sqlDB, _ := db.DB()
	//池子里空闲连接的数量上限（超出此上限就把相应的连接关闭掉）
	sqlDB.SetMaxIdleConns(10)
	//最多开这么多连接
	sqlDB.SetMaxOpenConns(100)
	//一个连接最多可使用这么长时间，超时后连接会自动关闭（因为数据库本身可能也对NoActive连接设置了超时时间，我们的应对办法：定期ping，或者SetConnMaxLifetime）
	sqlDB.SetConnMaxLifetime(time.Hour)
	return NewStore(db)
}

// PingGiftDB 主动 ping MySQL，保持连接活跃。
// 这个方法不是业务健康检查，只用于避免长时间空闲连接被数据库或网络层断开后才在请求中暴露问题。
func (s *Store) PingGiftDB() {
	if s != nil && s.db != nil {
		sqlDB, _ := s.db.DB()
		sqlDB.Ping()
		slog.Info("ping post db")
	}
}

// CloseGiftDB 关闭 MySQL 连接池。
// 应用退出时先停止 HTTP 入口再关闭连接池，避免新请求进来后拿到已关闭的连接。
func (s *Store) CloseGiftDB() {
	if s != nil && s.db != nil {
		sqlDB, _ := s.db.DB()
		sqlDB.Close()
		slog.Info("close GiftDB")
	}
}
