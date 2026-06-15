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
		// 按小时切分日志，避免压测时单个日志文件过大，排查某次压测窗口也更容易定位。
		logFile+".%Y%m%d%H",
		rotatelogs.WithRotationTime(1*time.Hour),
		// 本项目主要用于本地演示和面试讲解，保留 7 天足够回看问题，同时不会长期占用磁盘。
		rotatelogs.WithMaxAge(7*24*time.Hour),
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

	handler := slog.NewTextHandler(
		fout,
		&slog.HandlerOptions{
			// 打开源码位置是为了定位空返回、MQ 失败、Redis 脚本失败这类链路问题。
			// 压测时日志量会变大，所以通过 LOTTERY_LOG_LEVEL 控制最低输出级别。
			AddSource: true,
			Level:     level,
			ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
				if a.Key == slog.TimeKey {
					t := a.Value.Time()
					// 固定毫秒级时间格式，方便把 HTTP、Redis、MQ 三段日志按时间线串起来。
					a.Value = slog.StringValue(t.Format("2006-01-02 15:04:05.000"))
				}
				return a
			},
		},
	)
	logger := slog.New(handler)

	slog.SetDefault(logger)
}
