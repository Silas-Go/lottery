package router

import (
	"net/http"
	"silas/internal/handler"

	"github.com/gin-gonic/gin"
)

// Handlers 汇总路由层需要的 HTTP handler。
// router 只负责 URL 到 handler 的映射，不直接依赖 service/database，保持分层边界清楚。
type Handlers struct {
	// Archive 处理材料聚合档案的只读 Cache-Aside 实验。
	Archive *handler.ArchiveHandler

	// PurchaseLab 处理共享材料库存上的同步失效与 Outbox + MQ 购买实验。
	PurchaseLab *handler.PurchaseLabHandler

	// Gift 处理限量材料列表和 /lucky 高并发抽取请求；字段名保留 gift 仅为兼容历史表与订单协议。
	Gift *handler.GiftHandler

	// Order 处理 /pay 支付和 /giveup 放弃支付请求。
	Order *handler.OrderHandler

	// Lab 处理本地实验室管理接口，例如重置压测数据。
	Lab *handler.LabHandler

	// Loadtest 只代理受控的本地 wrk2 任务，不接受任意命令或目标地址。
	Loadtest *handler.LoadtestHandler
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
	engine.StaticFile("/favicon.ico", "views/img/Silas.png")
	engine.LoadHTMLGlob("views/html/*.html")
}

func registerPages(engine *gin.Engine) {
	engine.GET("/", func(ctx *gin.Context) {
		ctx.HTML(http.StatusOK, "market-street.html", nil)
	})
	engine.GET("/material-shop", func(ctx *gin.Context) {
		// 材料店前厅已经被实验总览取代；二级页只接受首页签发的明确实验意图，
		// 避免无参数访问重新落回一层没有技术职责的世界观中转页面。
		experiment := ctx.Query("experiment")
		if experiment != "query" && experiment != "purchase" {
			ctx.Redirect(http.StatusFound, "/")
			return
		}
		ctx.HTML(http.StatusOK, "market.html", nil)
	})
	engine.GET("/seckill-lab", func(ctx *gin.Context) {
		ctx.HTML(http.StatusOK, "seckill.html", nil)
	})
	engine.GET("/lab", func(ctx *gin.Context) {
		ctx.HTML(http.StatusOK, "query-lab.html", nil)
	})
	engine.GET("/purchase-lab", func(ctx *gin.Context) {
		ctx.HTML(http.StatusOK, "purchase-lab.html", nil)
	})
	engine.GET("/result", func(ctx *gin.Context) {
		ctx.HTML(http.StatusOK, "pay.html", nil)
	})
}

func registerAPIRoutes(engine *gin.Engine, handlers Handlers) {
	engine.GET("/api/archives/:id/direct", handlers.Archive.ReadDirect)
	engine.GET("/api/archives/:id/cached", handlers.Archive.ReadCached)
	engine.POST("/api/chapters/cache-aside/reset", handlers.Archive.ResetChapter)
	engine.POST("/internal/cache-experiments/prepare", handlers.Archive.PrepareExperiment)
	engine.POST("/internal/cache-experiments/evict", handlers.Archive.EvictExperiment)
	engine.POST("/internal/cache-experiments/finish", handlers.Archive.FinishExperiment)
	engine.GET("/internal/cache-experiments/read", handlers.Archive.ReadExperiment)
	engine.GET("/api/purchase-lab/:id/state", handlers.PurchaseLab.State)
	engine.POST("/api/purchase-lab/:id/reset", handlers.PurchaseLab.Reset)
	engine.POST("/api/purchase-lab/:id/run", handlers.PurchaseLab.Run)
	engine.POST("/api/purchase-lab/:id/query", handlers.PurchaseLab.Query)
	engine.GET("/api/purchase-lab/runs/:requestId", handlers.PurchaseLab.GetRun)
	engine.GET("/api/seckill/materials", handlers.Gift.GetAllMaterials)
	engine.GET("/api/seckill/rate-limit-probe", handlers.Gift.ProbeRateLimit)
	engine.GET("/lucky", handlers.Gift.Lottery)
	engine.POST("/giveup", handlers.Order.GiveUp)
	engine.POST("/pay", handlers.Order.Pay)
	engine.GET("/api/order/status", handlers.Order.Status)
	engine.GET("/api/metrics/snapshot", handler.GetMetricsSnapshot)
	engine.GET("/api/metrics/stream", handler.StreamMetrics)
	engine.POST("/api/lab/reset", handlers.Lab.ResetLab)
	engine.POST("/api/loadtests", handlers.Loadtest.Create)
	engine.POST("/api/loadtests/connection-plan", handlers.Loadtest.PlanConnections)
	engine.GET("/api/loadtests/:id", handlers.Loadtest.Get)
	engine.GET("/api/loadtests/:id/events", handlers.Loadtest.Events)
	engine.POST("/api/loadtests/:id/stop", handlers.Loadtest.Stop)
}
