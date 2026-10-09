package app

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"silas/internal/database"
	"silas/internal/handler"
	"silas/internal/loadtest"
	"silas/internal/metrics"
	"silas/internal/mq"
	"silas/internal/router"
	"silas/internal/service"
	"silas/internal/util"
	"sync"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
)

// Application 持有应用运行期需要统一关闭的资源。
// 把 HTTP server、数据库和外部客户端收口到这里，是为了让启动和退出流程可追踪，
// 避免资源初始化散落在 main 或 handler 里。
type Application struct {
	store            *database.Store
	server           *http.Server
	backgroundCancel context.CancelFunc
	backgroundDone   <-chan struct{}
}

// New 初始化依赖并创建 HTTP 应用。
// 这里集中完成基础设施和路由装配，main.go 只负责启动，方便后续排查启动阶段失败点。
func New() *Application {
	store := initInfrastructure(false)
	engine, orderService, purchaseLabService := initHTTP(store)
	backgroundCancel, backgroundDone := startMQBackground(orderService, purchaseLabService)
	addr := util.EnvString("LOTTERY_HTTP_ADDR", "localhost:5678")
	slog.Info("application initialized", "http_addr", addr)

	return &Application{
		store: store, backgroundCancel: backgroundCancel, backgroundDone: backgroundDone,
		server: &http.Server{
			Addr:    addr,
			Handler: engine,
		},
	}
}

// startMQBackground 把三项后台职责显式拆开：订单消费、缓存失效消费、Outbox 发布。
// 两个 Consumer 使用不同 Group 和订阅集合；WaitGroup 让退出流程可以等它们停止后再关闭数据库与 Redis。
func startMQBackground(
	orderService *service.OrderService,
	purchaseLabService *service.PurchaseLabService,
) (context.CancelFunc, <-chan struct{}) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	if !mq.Enabled() {
		close(done)
		slog.Info("rocketmq disabled")
		return cancel, done
	}
	if err := mq.ValidateConsumerConfig(); err != nil {
		cancel()
		slog.Error("invalid rocketmq consumer configuration", "error", err)
		panic(err)
	}

	var workers sync.WaitGroup
	workers.Add(3)
	go func() {
		defer workers.Done()
		mq.RunOrderConsumer(ctx, orderService.CreateRedisPendingOrder, orderService.TimeoutCancel)
	}()
	go func() {
		defer workers.Done()
		mq.RunPurchaseCacheConsumer(ctx, purchaseLabService.ConsumeCacheInvalidation)
	}()
	go func() {
		defer workers.Done()
		purchaseLabService.RunOutboxWorker(ctx)
	}()
	go func() {
		workers.Wait()
		close(done)
	}()
	slog.Info("rocketmq background workers started",
		"order_consumer_group", mq.OrderConsumerGroup(),
		"purchase_cache_consumer_group", mq.PurchaseCacheConsumerGroup())
	return cancel, done
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
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		a.Shutdown(ctx)
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
	if a.backgroundCancel != nil {
		a.backgroundCancel()
	}
	// 先取消循环，让 Receive 停止拉新消息并允许已取得的小批消息完成幂等处理；
	// 等后台任务退出后再关闭两个 Consumer，最后才释放 Producer、MySQL 和 Redis。
	if a.backgroundDone != nil {
		select {
		case <-a.backgroundDone:
		case <-ctx.Done():
			slog.Warn("rocketmq background workers shutdown timed out", "error", ctx.Err())
		}
	}
	mq.StopConsumers()
	mq.StopProducter()
	if a.store != nil {
		a.store.CloseGiftDB()
	}
	database.CloseGiftRedis()
	slog.Info("application resources closed")
}

// InitializeInventory 仅供停掉全部 App 后的显式维护命令调用，不启动 HTTP 或 MQ Worker。
// 它复用原有恢复算法，不提供在线重建或跨实例重置协调。
func InitializeInventory() {
	store := initInfrastructure(true)
	defer store.CloseGiftDB()
	defer database.CloseGiftRedis()
	slog.Info("inventory initialization completed; maintenance command exiting")
}

func initInfrastructure(initializeInventory bool) *database.Store {
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
	// 目录迁移会清理订单和 Redis 库存，只允许显式维护命令执行。
	// 普通实例遇到旧目录直接退出，不能在其他实例仍接流量时偷偷重建。
	if initializeInventory {
		if _, err := store.EnsureSeckillMaterialCatalog(); err != nil {
			slog.Error("migrate seckill material catalog failed", "error", err)
			panic(err)
		}
	} else if err := store.ValidateSeckillMaterialCatalog(); err != nil {
		slog.Error("seckill material catalog requires offline initialization", "error", err)
		panic(err)
	}
	// 详情读实验使用独立材料表、组成关系与交易/评分事实；业务目录只保留星髓，
	// 组成材料仍作为 JOIN 数据存在，但不会作为可查询、购买或抢购的商品出现在页面。
	if err := store.EnsureMaterialReadModelSchema(); err != nil {
		slog.Error("ensure material read model schema failed", "error", err)
		panic(err)
	}
	// 真实购买实验复用 materials.stock 和材料 DTO 缓存。
	// 启动时补齐购买订单与 Outbox 表，避免老数据卷缺表导致事务失去原子边界。
	if err := store.EnsurePurchaseExperimentSchema(); err != nil {
		slog.Error("ensure purchase experiment schema failed", "error", err)
		panic(err)
	}
	// 限制 Cache-Aside 打到 MySQL 的并发上限（模拟受限连接池），调小才能在本机压出连接等待与红灯。
	database.SetCacheAsideGateCapacity(util.EnvInt("LOTTERY_CACHEASIDE_DB_CONCURRENCY", 10))

	mq.InitRocketLog()

	if initializeInventory {
		if err := store.InitGiftInventory(); err != nil {
			slog.Error("initialize gift inventory failed", "error", err)
			panic(err)
		}
	}
	if err := initInventoryMetrics(store); err != nil {
		slog.Error("inventory startup check failed; stop all Apps and run -init-inventory", "error", err)
		panic(err)
	}
	slog.Info("application infrastructure initialized")
	return store
}

// initHTTP 装配 HTTP 层依赖。
// rateLimitQPS 是本进程秒杀入口限流值，QPS 表示每秒请求数；0 表示关闭限流。
func initHTTP(store *database.Store) (*gin.Engine, *service.OrderService, *service.PurchaseLabService) {
	gin.DefaultWriter = io.Discard

	rateLimitQPS := util.EnvInt("LOTTERY_RATE_LIMIT_QPS", 1200)
	lotteryService := service.NewLotteryService(store, service.LotteryOptions{
		RateLimitQPS: rateLimitQPS,
	})
	orderService := service.NewOrderService(store)
	archiveService := service.NewArchiveService(store)
	purchaseLabService := service.NewPurchaseLabService(store, archiveService)
	loadtestService := service.NewLoadtestService(loadtest.NewClient(util.EnvString("LOTTERY_LOADTEST_RUNNER_URL", "http://loadtest-runner:8090")))
	resetLabRuntime := func() {
		lotteryService.ResetRateLimiter()
	}
	slog.Info("http dependencies initialized", "rate_limit_qps", rateLimitQPS)

	engine := router.New(router.Handlers{
		Archive:     handler.NewArchiveHandler(archiveService),
		PurchaseLab: handler.NewPurchaseLabHandler(purchaseLabService),
		Gift:        handler.NewGiftHandler(lotteryService),
		Order:       handler.NewOrderHandler(orderService),
		Lab:         handler.NewLabHandler(store, resetLabRuntime),
		Loadtest:    handler.NewLoadtestHandler(loadtestService),
	})
	return engine, orderService, purchaseLabService
}

// initInventoryMetrics 只读现有库存建立本机指标基线，绝不从旧快照回写库存。
// 缺失/损坏必须阻止 HTTP 和 Worker 启动；真实的零库存则是正常售罄。
func initInventoryMetrics(store *database.Store) error {
	baseGifts, err := store.GetAllGiftsWithError()
	if err != nil {
		return fmt.Errorf("load base inventory metrics: %w", err)
	}
	redisTotal, err := database.ValidateGiftInventory(baseGifts)
	if err != nil {
		return fmt.Errorf("validate gift inventory: %w", err)
	}

	var baseTotal int64
	for _, gift := range baseGifts {
		if gift.Count > 0 {
			baseTotal += int64(gift.Count)
		}
	}
	runID, runErr := database.CurrentSeckillRun()
	if runErr != nil {
		return fmt.Errorf("initialize seckill run: %w", runErr)
	}
	metrics.SetSeckillRunID(runID)
	metrics.InitInventory(baseTotal, redisTotal)
	slog.Info("inventory metrics initialized", "gift_count", len(baseGifts), "base_stock", baseTotal, "redis_stock", redisTotal)
	return nil
}
