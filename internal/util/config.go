package util

import (
	"fmt"
	"path"

	"github.com/spf13/viper"
)

// 配置文件类型常量。
// fileType 参数会传给 Viper，用来告诉它按 JSON/YAML/ENV 哪种格式解析配置文件。
const (
	JSON = "json"
	YAML = "yaml"
	ENV  = "env"
)

// InitViper 读取指定配置文件并返回独立的 Viper 实例。
//
// 参数语义:
//
//	dir      配置文件目录，例如 ./conf。
//	file     配置文件名，不带后缀，例如 mysql。
//	FileType 配置文件类型，例如 YAML；这里保留历史参数名，语义是 file type。
//
// 初始化阶段配置读取失败会直接 panic，因为数据库、Redis、MQ 的连接参数不完整时，
// 服务继续启动只会在后续链路中产生更难定位的错误。
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
