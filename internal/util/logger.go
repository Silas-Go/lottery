package util

import (
	"log/slog"
	"strings"
	"time"

	rotatelogs "github.com/lestrrat-go/file-rotatelogs"
)

// InitSlog 初始化应用结构化日志。
// 日志级别通过 LOTTERY_LOG_LEVEL 控制，默认 info；排查 Redis/MQ 细节时可以切到 debug，
// 避免平时压测产生过多低价值日志，又保留需要深挖时的观察入口。
func InitSlog(logFile string) {
	fout, err := rotatelogs.New(
		logFile+".%Y%m%d%H",                      //指定日志文件的路径和名称，路径不存在时会创建
		rotatelogs.WithRotationTime(1*time.Hour), //每隔1小时生成一份新的日志文件
		rotatelogs.WithMaxAge(7*24*time.Hour),    //只留最近7天的日志，或使用WithRotationCount只保留最近的几份日志
	)
	if err != nil {
		panic(err)
	}

	level := slog.LevelInfo
	switch strings.ToLower(EnvString("LOTTERY_LOG_LEVEL", "info")) {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}

	handler := slog.NewTextHandler( //json格式
		fout, //指定输出到文件
		&slog.HandlerOptions{
			AddSource: true,  //上报文件名和行号
			Level:     level, //设置最低级别
			ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
				if a.Key == slog.TimeKey { //如果Key=="time"
					t := a.Value.Time()
					a.Value = slog.StringValue(t.Format("2006-01-02 15:04:05.000")) //替换Value
				}
				return a
			},
		},
	)
	logger := slog.New(handler)

	slog.SetDefault(logger)
}
