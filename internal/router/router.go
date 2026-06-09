package router

import (
	"net/http"
	"silas/internal/handler"

	"github.com/gin-gonic/gin"
)

type Handlers struct {
	Gift  *handler.GiftHandler
	Order *handler.OrderHandler
}

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
