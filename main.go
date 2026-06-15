package main

import "silas/internal/app"

func main() {
	// main 只负责进程入口，启动细节集中在 internal/app。
	// 这样路由、依赖初始化和优雅退出不会再堆回入口文件，后续排查启动链路更清楚。
	if err := app.New().Run(); err != nil {
		panic(err)
	}
}
