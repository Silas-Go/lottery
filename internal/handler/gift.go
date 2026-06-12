package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"silas/internal/metrics"
	"silas/internal/service"
	"silas/internal/util"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
)

// GiftHandler 处理奖品展示和抽奖 HTTP 请求。
// 它只负责 HTTP 适配和 cookie 写入，抽奖准入、库存、MQ 补偿等业务规则都交给 service。
type GiftHandler struct {
	lottery *service.LotteryService
}

var autoLotteryUID int64 = time.Now().UnixNano() % 1000000000

// NewGiftHandler 创建奖品相关的 HTTP handler。
// handler 通过依赖注入拿到 LotteryService，便于保持路由层和业务层解耦。
func NewGiftHandler(lottery *service.LotteryService) *GiftHandler {
	return &GiftHandler{lottery: lottery}
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

// GetAllGifts 返回转盘展示用的奖品列表。
// 展示列表不承担库存真实性保证，真实可抢库存会在抽奖时重新从 Redis 读取。
func (h *GiftHandler) GetAllGifts(ctx *gin.Context) {
	start := time.Now()
	slog.Info("get gifts request start", "client", ctx.ClientIP())

	gifts, appErr := h.lottery.ListGifts()
	if appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}

	data, err := json.Marshal(gifts)
	if err != nil {
		writeAPIError(ctx, http.StatusInternalServerError, "GIFT_JSON_ENCODE_FAILED", "奖品列表序列化失败", err)
		return
	}

	slog.Info("get gifts request success", "count", len(gifts), "duration_ms", time.Since(start).Milliseconds())
	ctx.Data(http.StatusOK, "application/json; charset=utf-8", data)
}

// Lottery 处理一次抽奖请求。
// 成功抢到时会把临时资格写入 cookie，支付页再用 uid/gid 完成资格认领；
// 如果没有库存则保持历史协议返回 "0"，避免旧前端误判为系统错误。
func (h *GiftHandler) Lottery(ctx *gin.Context) {
	start := time.Now()
	defer func() {
		metrics.RecordRequest(time.Since(start))
	}()

	uid := lotteryUID(ctx)
	slog.Info("lottery http request accepted", "uid", uid, "client", ctx.ClientIP(), "method", ctx.Request.Method, "path", ctx.Request.URL.Path)
	result, appErr := h.lottery.Draw(uid)
	if appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	if result.GiftID == 0 {
		slog.Info("lottery http response no stock", "uid", uid, "status", http.StatusOK, "duration_ms", time.Since(start).Milliseconds())
		ctx.String(http.StatusOK, "0")
		return
	}

	cookieDomain := util.EnvString("LOTTERY_COOKIE_DOMAIN", "localhost")
	ctx.SetCookie("name", result.GiftName, result.Delay, "/", cookieDomain, false, false)
	ctx.SetCookie("price", strconv.Itoa(result.Price), result.Delay, "/", cookieDomain, false, false)
	ctx.SetCookie("uid", strconv.Itoa(result.UID), result.Delay, "/", cookieDomain, false, false)
	ctx.SetCookie("gid", strconv.Itoa(result.GiftID), result.Delay, "/", cookieDomain, false, false)

	slog.Info("lottery request response", "uid", result.UID, "gid", result.GiftID, "duration_ms", time.Since(start).Milliseconds())
	ctx.String(http.StatusOK, strconv.Itoa(result.GiftID))
}
