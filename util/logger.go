package util

import (
	"log/slog"
	"time"

	rotatelogs "github.com/lestrrat-go/file-rotatelogs"
)

func InitSlog(logFile string) {
	fout, err := rotatelogs.New(
		logFile+".%Y%m%d%H",                      //指定日志文件的路径和名称，路径不存在时会创建
		rotatelogs.WithLinkName(logFile),         //为最新的一份日志创建软链接
		rotatelogs.WithRotationTime(1*time.Hour), //每隔1小时生成一份新的日志文件
		rotatelogs.WithMaxAge(7*24*time.Hour),    //只留最近7天的日志，或使用WithRotationCount只保留最近的几份日志
	)
	if err != nil {
		panic(err)
	}

	handler := slog.NewTextHandler( //json格式
		fout, //指定输出到文件
		&slog.HandlerOptions{
			AddSource: true,           //上报文件名和行号
			Level:     slog.LevelInfo, //设置最低级别
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
