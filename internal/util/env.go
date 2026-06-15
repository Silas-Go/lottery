package util

import (
	"os"
	"strconv"
)

// EnvString 读取字符串环境变量。
// fallback 表示兜底值；本项目用它让本机脚本覆盖 conf 配置，而 Docker/默认配置仍可直接运行。
func EnvString(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

// EnvInt 读取整数环境变量。
// 如果变量不存在或不是合法整数，会返回 fallback，避免配置写错导致入口链路直接崩溃。
func EnvInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	n, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return n
}

// EnvBool 读取布尔环境变量。
// 支持 Go 标准布尔解析，例如 true/false；解析失败时返回 fallback。
func EnvBool(key string, fallback bool) bool {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	b, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return b
}
