package router

import (
	"net/http"
	"silas/internal/handler"

	"github.com/gin-gonic/gin"
)

// Handlers 汇总路由层需要的 HTTP handler。
// router 只负责 URL 到 handler 的映射，不直接依赖 service/database，保持分层边界清楚。
type Handlers struct {
	// Gift 处理奖品列表和 /lucky 抽奖请求。
	Gift *handler.GiftHandler

	// Order 处理 /pay 支付和 /giveup 放弃支付请求。
	Order *handler.OrderHandler
}

// New 创建 Gin HTTP 引擎并注册页面、静态资源和 API 路由。
// 这里集中注册路由，避免业务 handler 分散修改全局路由导致链路难追踪。
func New(handlers Handlers) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	engine := gin.Default()

	registerStaticAssets(engine)
	registerPages(engine)
	registerAPIRoutes(engine, handlers)

	return engine
}

func registerStaticAssets(engine *gin.Engine) {
	engine.Static("/js", "views/js")
	engine.Static("/img", "views/img")
	engine.Static("/css", "views/css")
	engine.StaticFile("/favicon.ico", "views/img/dqq.png")
	engine.LoadHTMLGlob("views/html/*.html")
}

func registerPages(engine *gin.Engine) {
	engine.GET("/", func(ctx *gin.Context) {
		ctx.HTML(http.StatusOK, "lottery.html", nil)
	})
	engine.GET("/result", func(ctx *gin.Context) {
		ctx.HTML(http.StatusOK, "pay.html", nil)
	})
}

func registerAPIRoutes(engine *gin.Engine, handlers Handlers) {
	engine.GET("/gifts", handlers.Gift.GetAllGifts)
	engine.GET("/lucky", handlers.Gift.Lottery)
	engine.POST("/giveup", handlers.Order.GiveUp)
	engine.POST("/pay", handlers.Order.Pay)
	engine.GET("/api/metrics/snapshot", handler.GetMetricsSnapshot)
	engine.GET("/api/metrics/stream", handler.StreamMetrics)
}
