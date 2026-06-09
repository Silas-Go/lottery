package util

import (
	"fmt"
	"path"

	"github.com/spf13/viper"
)

// FileType
const (
	JSON = "json"
	YAML = "yaml"
	ENV  = "env"
)

// Viper可以解析JSON、TOML、YAML、HCL、INI、ENV等格式的配置文件。甚至可以监听配置文件的变化(WatchConfig)，不需要重启程序就可以读到最新的值。
func InitViper(dir, file, FileType string) *viper.Viper {
	config := viper.New()
	config.AddConfigPath(dir)      // 文件所在目录
	config.SetConfigName(file)     // 文件名(不带路径，不带后缀)
	config.SetConfigType(FileType) // 文件类型

	if err := config.ReadInConfig(); err != nil {
		panic(fmt.Errorf("解析配置文件%s出错:%s", path.Join(dir, file)+"."+FileType, err)) //系统初始化阶段发生任何错误，直接结束进程。logger还没初始化，不能用logger.Fatal()
	}

	return config
}
