package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"silas/database"
	"silas/handler"
	"silas/mq"
	"silas/util"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
)

var (
	server *http.Server
)

func Init() *database.Store {
	util.InitSlog("./log/lottery.log")
	store := database.ConnectGiftDB("./conf", "mysql", util.YAML, "./log/lottery.db.log")
	database.ConnectGiftRedis("./conf", "redis", util.YAML)
	mq.InitRocketLog()
	if mq.Enabled() {
		go mq.ReceiveCancelOrder()
	} else {
		slog.Info("rocketmq disabled")
	}
	if err := store.InitGiftInventory(); err != nil {
		slog.Error("init gift inventory failed", "error", err)
	}
	return store
}

func ListenTermSignal(store *database.Store) {
	c := make(chan os.Signal, 1)
	signal.Notify(c, syscall.SIGINT, syscall.SIGTERM)
	sig := <-c
	slog.Info("receive term signal " + sig.String() + ", going to exit")

	// 释放各种资源
	store.CloseGiftDB()
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
	store := Init()
	go ListenTermSignal(store)

	gin.SetMode(gin.ReleaseMode)   //GIN线上发布模式
	gin.DefaultWriter = io.Discard //禁止GIN的输出
	engine := gin.Default()
	giftHandler := handler.NewGiftHandler(store)
	orderHandler := handler.NewOrderHandler(store)

	// 修改静态资源不需要重启GIN，刷新页面即可
	engine.Static("/js", "views/js")
	engine.Static("/img", "views/img")
	engine.Static("/css", "views/css")
	engine.StaticFile("/favicon.ico", "views/img/dqq.png")
	engine.LoadHTMLGlob("views/html/*.html")

	engine.GET("/", func(ctx *gin.Context) {
		ctx.HTML(http.StatusOK, "lottery.html", nil)
	})
	engine.GET("/gifts", giftHandler.GetAllGifts) //获取所有奖品信息
	engine.GET("/lucky", giftHandler.Lottery)     //点击抽奖按钮
	engine.POST("/giveup", orderHandler.GiveUp)
	engine.POST("/pay", orderHandler.Pay)
	engine.GET("/result", func(ctx *gin.Context) {
		ctx.HTML(http.StatusOK, "pay.html", nil)
	})

	server = &http.Server{
		Addr:    util.EnvString("LOTTERY_HTTP_ADDR", "localhost:5678"),
		Handler: engine,
	}
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		panic(err)
	}
}

// go run ./lottery
// 浏览器访问，http://localhost:5678/，项目中用到cookie，要使用localhost这个域名
