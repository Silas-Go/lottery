package app

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"silas/internal/database"
	"silas/internal/handler"
	"silas/internal/metrics"
	"silas/internal/mq"
	"silas/internal/router"
	"silas/internal/service"
	"silas/internal/util"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
)

// Application 持有应用运行期需要统一关闭的资源。
// 把 HTTP server、数据库和外部客户端收口到这里，是为了让启动和退出流程可追踪，
// 避免资源初始化散落在 main 或 handler 里。
type Application struct {
	store  *database.Store
	server *http.Server
}

// New 初始化依赖并创建 HTTP 应用。
// 这里集中完成基础设施和路由装配，main.go 只负责启动，方便后续排查启动阶段失败点。
func New() *Application {
	store := initInfrastructure()
	engine := initHTTP(store)
	addr := util.EnvString("LOTTERY_HTTP_ADDR", "localhost:5678")
	slog.Info("application initialized", "http_addr", addr)

	return &Application{
		store: store,
		server: &http.Server{
			Addr:    addr,
			Handler: engine,
		},
	}
}

// Run 启动 HTTP server 并等待退出信号。
// HTTP 服务运行在 goroutine 中，主 goroutine 同时监听启动错误和系统信号；
// 如果不这样收口，Ctrl+C 或容器停止时容易跳过资源关闭流程。
func (a *Application) Run() error {
	slog.Info("http server starting", "addr", a.server.Addr)
	// errCh 用来把 ListenAndServe 的异步结果带回主 goroutine。
	// 这样启动失败能立刻返回，收到退出信号时也能等待 server 正常关闭。
	errCh := make(chan error, 1)
	go func() {
		if err := a.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
			return
		}
		errCh <- nil
	}()

	// stopCh 只接收进程级退出信号。
	// 收到信号后走 Shutdown，保证 Redis、MySQL、MQ client 都有机会释放资源。
	stopCh := make(chan os.Signal, 1)
	signal.Notify(stopCh, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(stopCh)

	select {
	case err := <-errCh:
		if err != nil {
			slog.Error("http server stopped with error", "error", err)
		} else {
			slog.Info("http server stopped")
		}
		return err
	case sig := <-stopCh:
		slog.Info("receive term signal " + sig.String() + ", going to exit")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		a.Shutdown(ctx)
		return <-errCh
	}
}

// Shutdown 按顺序关闭 HTTP server 和外部依赖。
// 先停 HTTP 入口，再关闭数据库、Redis 和 MQ，避免新请求进入后依赖已经被提前释放。
func (a *Application) Shutdown(ctx context.Context) {
	if a.server != nil {
		slog.Info("http server shutting down")
		_ = a.server.Shutdown(ctx)
	}

	if a.store != nil {
		a.store.CloseGiftDB()
	}
	database.CloseGiftRedis()
	mq.StopConsumer()
	mq.StopProducter()
	slog.Info("application resources closed")
}

func initInfrastructure() *database.Store {
	util.InitSlog("./log/lottery.log")
	slog.Info("application infrastructure initializing")
	store := database.ConnectGiftDB("./conf", "mysql", util.YAML, "./log/lottery.db.log")
	database.ConnectGiftRedis("./conf", "redis", util.YAML)
	// 老数据卷不会重新执行 init.sql，所以应用启动时要补齐订单表结构。
	// 这一步保证 activity_id + user_id 唯一索引存在，MySQL 才能兜住重复参与。
	if err := store.EnsureOrderSchema(); err != nil {
		slog.Error("ensure order schema failed", "error", err)
		panic(err)
	}
	// Cache-Aside 模式用独立的 cache_stock 列维护实时库存，与预扣模式的 count 基线隔离。
	// 老数据卷同样需要在启动时补齐这一列，否则 Cache-Aside 链路读写会失败。
	if err := store.EnsureCacheStockSchema(); err != nil {
		slog.Error("ensure cache stock schema failed", "error", err)
		panic(err)
	}
	// 限制 Cache-Aside 打到 MySQL 的并发上限（模拟受限连接池），调小才能在本机压出连接等待与红灯。
	database.SetCacheAsideGateCapacity(util.EnvInt("LOTTERY_CACHEASIDE_DB_CONCURRENCY", 10))

	mq.InitRocketLog()
	if mq.Enabled() {
		// MQ consumer 必须后台运行，才能在用户未支付时消费延时补偿消息。
		// 如果不启动这个 goroutine，Redis 预扣库存会一直等到 TTL 自然过期或无法回补。
		go mq.ReceiveCancelOrder()
	} else {
		slog.Info("rocketmq disabled")
	}

	initInventoryMetrics(store)
	slog.Info("application infrastructure initialized")
	return store
}

// initHTTP 装配 HTTP 层依赖。
// rateLimitQPS 是本进程秒杀入口限流值，QPS 表示每秒请求数；0 表示关闭限流。
func initHTTP(store *database.Store) *gin.Engine {
	gin.DefaultWriter = io.Discard

	rateLimitQPS := util.EnvInt("LOTTERY_RATE_LIMIT_QPS", 0)
	lotteryService := service.NewLotteryService(store, service.LotteryOptions{
		RateLimitQPS: rateLimitQPS,
	})
	orderService := service.NewOrderService(store)
	cacheAsideService := service.NewCacheAsideLotteryService(store)
	slog.Info("http dependencies initialized", "rate_limit_qps", rateLimitQPS)

	return router.New(router.Handlers{
		Gift:  handler.NewGiftHandler(lotteryService, cacheAsideService),
		Order: handler.NewOrderHandler(orderService),
		Lab:   handler.NewLabHandler(store, cacheAsideService.ResetCircuitBreaker),
	})
}

// initInventoryMetrics 初始化 Redis 库存并建立指标基线。
// baseTotal 是 MySQL 配置的活动初始库存，redisTotal 是扣除已完成订单后的 Redis 当前可用库存。
// 这两个值不能混用，否则重启后页面会把剩余库存误当初始库存，导致超卖判断不准。
func initInventoryMetrics(store *database.Store) {
	if err := store.InitGiftInventory(); err != nil {
		slog.Error("init gift inventory failed", "error", err)
		return
	}

	baseGifts, err := store.GetAllGiftsWithError()
	if err != nil {
		slog.Error("load base inventory metrics failed", "error", err)
		return
	}
	gifts, err := database.GetAllGiftInventoryWithError()
	if err != nil {
		slog.Error("load gift inventory metrics failed", "error", err)
		return
	}

	var baseTotal int64
	for _, gift := range baseGifts {
		if gift.Count > 0 {
			baseTotal += int64(gift.Count)
		}
	}
	var redisTotal int64
	for _, gift := range gifts {
		if gift.Count > 0 {
			redisTotal += int64(gift.Count)
		}
	}
	metrics.InitInventory(baseTotal, redisTotal)
	slog.Info("inventory metrics initialized", "gift_count", len(gifts), "base_stock", baseTotal, "redis_stock", redisTotal)
}
