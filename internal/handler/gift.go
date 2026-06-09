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

type GiftHandler struct {
	lottery *service.LotteryService
}

var autoLotteryUID int64 = time.Now().UnixNano() % 1000000000

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

func (h *GiftHandler) Lottery(ctx *gin.Context) {
	start := time.Now()
	defer func() {
		metrics.RecordRequest(time.Since(start))
	}()

	uid := lotteryUID(ctx)
	result, appErr := h.lottery.Draw(uid)
	if appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	if result.GiftID == 0 {
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
