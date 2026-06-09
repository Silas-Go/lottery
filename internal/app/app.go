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

type Application struct {
	store  *database.Store
	server *http.Server
}

func New() *Application {
	store := initInfrastructure()
	engine := initHTTP(store)

	return &Application{
		store: store,
		server: &http.Server{
			Addr:    util.EnvString("LOTTERY_HTTP_ADDR", "localhost:5678"),
			Handler: engine,
		},
	}
}

func (a *Application) Run() error {
	errCh := make(chan error, 1)
	go func() {
		if err := a.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
			return
		}
		errCh <- nil
	}()

	stopCh := make(chan os.Signal, 1)
	signal.Notify(stopCh, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(stopCh)

	select {
	case err := <-errCh:
		return err
	case sig := <-stopCh:
		slog.Info("receive term signal " + sig.String() + ", going to exit")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		a.Shutdown(ctx)
		return <-errCh
	}
}

func (a *Application) Shutdown(ctx context.Context) {
	if a.server != nil {
		_ = a.server.Shutdown(ctx)
	}

	if a.store != nil {
		a.store.CloseGiftDB()
	}
	database.CloseGiftRedis()
	mq.StopConsumer()
	mq.StopProducter()
}

func initInfrastructure() *database.Store {
	util.InitSlog("./log/lottery.log")
	store := database.ConnectGiftDB("./conf", "mysql", util.YAML, "./log/lottery.db.log")
	database.ConnectGiftRedis("./conf", "redis", util.YAML)

	mq.InitRocketLog()
	if mq.Enabled() {
		go mq.ReceiveCancelOrder()
	} else {
		slog.Info("rocketmq disabled")
	}

	initInventoryMetrics(store)
	return store
}

func initHTTP(store *database.Store) *gin.Engine {
	gin.DefaultWriter = io.Discard

	lotteryService := service.NewLotteryService(store, service.LotteryOptions{
		RateLimitQPS: util.EnvInt("LOTTERY_RATE_LIMIT_QPS", 0),
	})
	orderService := service.NewOrderService(store)

	return router.New(router.Handlers{
		Gift:  handler.NewGiftHandler(lotteryService),
		Order: handler.NewOrderHandler(orderService),
	})
}

func initInventoryMetrics(store *database.Store) {
	if err := store.InitGiftInventory(); err != nil {
		slog.Error("init gift inventory failed", "error", err)
		return
	}

	gifts, err := database.GetAllGiftInventoryWithError()
	if err != nil {
		slog.Error("load gift inventory metrics failed", "error", err)
		return
	}

	var total int64
	for _, gift := range gifts {
		if gift.Count > 0 {
			total += int64(gift.Count)
		}
	}
	metrics.InitInventory(total)
}
