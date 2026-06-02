package main

import (
	"context"
	"dqq/go/frame/lottery/database"
	"dqq/go/frame/lottery/handler"
	"dqq/go/frame/lottery/mq"
	"dqq/go/frame/lottery/util"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
)

var (
	server *http.Server
)

func Init() {
	util.InitSlog("./log/lottery.log")
	database.ConnectGiftDB("./conf", "mysql", util.YAML, "./log/lottery.db.log")
	database.ConnectGiftRedis("./conf", "redis", util.YAML)
	mq.InitRocketLog()
	go mq.ReceiveCancelOrder()
	if err := database.InitGiftInventory(); err != nil {
		slog.Error("init gift inventory failed", "error", err)
	}
}

func ListenTermSignal() {
	c := make(chan os.Signal, 1)
	signal.Notify(c, syscall.SIGINT, syscall.SIGTERM)
	sig := <-c
	slog.Info("receive term signal " + sig.String() + ", going to exit")

	// 释放各种资源
	database.CloseGiftDB()
	database.CloseGiftRedis()
	mq.StopConsumer()
	mq.StopProducter()

	// 等Web Server完全终止
	if server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(ctx) //Shutdown会结束Go进程
	}
}

func main() {
	Init()
	go ListenTermSignal()

	gin.SetMode(gin.ReleaseMode)   //GIN线上发布模式
	gin.DefaultWriter = io.Discard //禁止GIN的输出
	engine := gin.Default()

	// 修改静态资源不需要重启GIN，刷新页面即可
	engine.Static("/js", "views/js")
	engine.Static("/img", "views/img")
	engine.StaticFile("/favicon.ico", "views/img/dqq.png")
	engine.LoadHTMLGlob("views/html/*.html")

	engine.GET("/", func(ctx *gin.Context) {
		ctx.HTML(http.StatusOK, "lottery.html", nil)
	})
	engine.GET("/gifts", handler.GetAllGifts) //获取所有奖品信息
	engine.GET("/lucky", handler.Lottery)     //点击抽奖按钮
	engine.POST("/giveup", handler.GiveUp)
	engine.POST("/pay", handler.Pay)
	engine.GET("/result", func(ctx *gin.Context) {
		ctx.HTML(http.StatusOK, "pay.html", nil)
	})

	server = &http.Server{
		Addr:    "localhost:5678",
		Handler: engine,
	}
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		panic(err)
	}
}

// go run ./lottery
// 浏览器访问，http://localhost:5678/，项目中用到cookie，要使用localhost这个域名
