package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"silas/database"
	"silas/metrics"
	"silas/mq"
	"silas/util"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	PAY_DELAY = 600
)

type GiftHandler struct {
	store *database.Store
}

var autoLotteryUID int64 = time.Now().UnixNano() % 1000000000
var lotteryLimiter = newFixedWindowLimiter(util.EnvInt("LOTTERY_RATE_LIMIT_QPS", 0))

func NewGiftHandler(store *database.Store) *GiftHandler {
	return &GiftHandler{store: store}
}

type fixedWindowLimiter struct {
	limit  int
	mu     sync.Mutex
	window int64
	count  int
}

func newFixedWindowLimiter(limit int) *fixedWindowLimiter {
	return &fixedWindowLimiter{limit: limit}
}

func (l *fixedWindowLimiter) Allow() bool {
	if l == nil || l.limit <= 0 {
		return true
	}

	now := time.Now().Unix()
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.window != now {
		l.window = now
		l.count = 0
	}
	if l.count >= l.limit {
		return false
	}
	l.count++
	return true
}

type apiErrorResponse struct {
	Status  int    `json:"status"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Detail  string `json:"detail,omitempty"`
}

func writeAPIError(ctx *gin.Context, status int, code string, message string, err error, attrs ...any) {
	logAttrs := []any{
		"status", status,
		"code", code,
		"method", ctx.Request.Method,
		"path", ctx.Request.URL.Path,
		"client", ctx.ClientIP(),
	}
	logAttrs = append(logAttrs, attrs...)
	if err != nil {
		logAttrs = append(logAttrs, "error", err)
	}
	slog.Error("api request failed", logAttrs...)

	resp := apiErrorResponse{
		Status:  status,
		Code:    code,
		Message: message,
	}
	if err != nil {
		resp.Detail = err.Error()
	}
	ctx.Header("X-Error-Code", code)
	ctx.JSON(status, resp)
}

func rollbackInventory(giftId int, reason string) {
	if err := database.IncreaseInventory(giftId); err != nil {
		slog.Error("rollback inventory failed", "gid", giftId, "reason", reason, "error", err)
		return
	}
	metrics.RecordInventoryRollback(giftId, reason)
	slog.Info("rollback inventory success", "gid", giftId, "reason", reason)
}

func lotteryUID(ctx *gin.Context) int {
	raw := ctx.Query("uid")
	if raw == "" {
		raw = ctx.GetHeader("X-User-ID")
	}
	uid, err := strconv.Atoi(raw)
	if err != nil || uid <= 0 {
		return int(atomic.AddInt64(&autoLotteryUID, 1))
	}
	return uid
}

func (h *GiftHandler) GetAllGifts(ctx *gin.Context) {
	start := time.Now()
	slog.Info("get gifts request start", "client", ctx.ClientIP())

	gifts, err := h.store.GetAllGiftsWithError()
	if err != nil {
		writeAPIError(ctx, http.StatusServiceUnavailable, "GIFT_DB_READ_FAILED", "读取奖品列表失败", err)
		return
	}
	if len(gifts) == 0 {
		writeAPIError(ctx, http.StatusNotFound, "NO_GIFTS_CONFIGURED", "奖品列表为空，请先初始化数据库", nil)
		return
	}

	for _, gift := range gifts {
		gift.Count = 1
	}
	data, err := json.Marshal(gifts)
	if err != nil {
		writeAPIError(ctx, http.StatusInternalServerError, "GIFT_JSON_ENCODE_FAILED", "奖品列表序列化失败", err)
		return
	}

	slog.Info("get gifts request success", "count", len(gifts), "duration_ms", time.Since(start).Milliseconds())
	ctx.Data(http.StatusOK, "application/json; charset=utf-8", data)
}

func (h *GiftHandler) Lottery(ctx *gin.Context) {
	start := time.Now()
	defer func() {
		metrics.RecordRequest(time.Since(start))
	}()

	if !lotteryLimiter.Allow() {
		metrics.RecordRateLimited()
		ctx.Header("X-Error-Code", "SECKILL_RATE_LIMITED")
		ctx.JSON(http.StatusTooManyRequests, apiErrorResponse{
			Status:  http.StatusTooManyRequests,
			Code:    "SECKILL_RATE_LIMITED",
			Message: "请求过多，请稍后重试",
		})
		return
	}

	uid := lotteryUID(ctx)
	slog.Info("lottery request start", "uid", uid, "client", ctx.ClientIP())

	for try := 1; try <= 10; try++ {
		gifts, err := database.GetAllGiftInventoryWithError()
		if err != nil {
			metrics.RecordSystemError("读取 Redis 库存失败", err)
			writeAPIError(ctx, http.StatusServiceUnavailable, "REDIS_INVENTORY_READ_FAILED", "读取奖品库存失败", err, "try", try)
			return
		}

		ids := make([]int, 0, len(gifts))
		probs := make([]float64, 0, len(gifts))
		for _, gift := range gifts {
			if gift.Count > 0 {
				ids = append(ids, gift.Id)
				probs = append(probs, float64(gift.Count))
			}
		}
		if len(ids) == 0 {
			metrics.RecordStockFailed("Redis 可用库存为空")
			slog.Info("lottery request finished with no inventory", "uid", uid, "duration_ms", time.Since(start).Milliseconds())
			ctx.String(http.StatusOK, strconv.Itoa(0))
			return
		}

		index := util.Lottery(probs)
		if index < 0 || index >= len(ids) {
			err := fmt.Errorf("lottery index %d out of range, candidates=%d", index, len(ids))
			metrics.RecordSystemError("抽奖算法返回非法结果", err)
			writeAPIError(ctx, http.StatusInternalServerError, "LOTTERY_ALGO_FAILED", "抽奖算法返回非法结果", err, "try", try)
			return
		}

		giftId := ids[index]
		if err := database.ReduceInventory(giftId); err != nil {
			slog.Warn("reduce inventory failed, retrying lottery", "uid", uid, "gid", giftId, "try", try, "error", err)
			continue
		}
		metrics.RecordRedisPreDeduct(giftId)

		inst, err := h.store.GetGiftWithError(giftId)
		if err != nil {
			rollbackInventory(giftId, "gift lookup failed")
			metrics.RecordSystemError("查询中奖奖品详情失败", err)
			writeAPIError(ctx, http.StatusInternalServerError, "GIFT_LOOKUP_FAILED", "查询中奖奖品详情失败", err, "uid", uid, "gid", giftId, "try", try)
			return
		}

		if err := database.CreateTempOrder(uid, giftId); err != nil {
			rollbackInventory(giftId, "temp order create failed")
			metrics.RecordSystemError("创建临时订单失败", err)
			writeAPIError(ctx, http.StatusServiceUnavailable, "TEMP_ORDER_CREATE_FAILED", "创建临时订单失败", err, "uid", uid, "gid", giftId, "try", try)
			return
		}

		if err := mq.SendCancelOrder(database.Order{UserId: uid, GiftId: giftId}, PAY_DELAY); err != nil {
			if n := database.DeleteTempOrder(uid, giftId); n < 0 {
				slog.Error("rollback temp order failed", "uid", uid, "gid", giftId)
			}
			rollbackInventory(giftId, "rocketmq send failed")
			metrics.RecordSystemError("发送延时取消订单消息失败", err)
			writeAPIError(ctx, http.StatusServiceUnavailable, "MQ_SEND_FAILED", "发送延时取消订单消息失败", err, "uid", uid, "gid", giftId, "try", try)
			return
		}
		metrics.RecordQueueSuccess(giftId)

		cookieDomain := util.EnvString("LOTTERY_COOKIE_DOMAIN", "localhost")
		ctx.SetCookie("name", inst.Name, PAY_DELAY, "/", cookieDomain, false, false)
		ctx.SetCookie("price", strconv.Itoa(inst.Price), PAY_DELAY, "/", cookieDomain, false, false)
		ctx.SetCookie("uid", strconv.Itoa(uid), PAY_DELAY, "/", cookieDomain, false, false)
		ctx.SetCookie("gid", strconv.Itoa(giftId), PAY_DELAY, "/", cookieDomain, false, false)

		slog.Info("lottery request success", "uid", uid, "gid", giftId, "gift", inst.Name, "try", try, "duration_ms", time.Since(start).Milliseconds())
		ctx.String(http.StatusOK, strconv.Itoa(giftId))
		return
	}

	metrics.RecordStockFailed("库存扣减冲突重试耗尽")
	writeAPIError(ctx, http.StatusConflict, "INVENTORY_RETRY_EXHAUSTED", "库存扣减冲突，请稍后重试", errors.New("reduce inventory failed after 10 attempts"), "uid", uid)
}
