package handler

import (
	"log/slog"
	"net/http"
	"silas/internal/service"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
)

// OrderHandler 处理状态查询、支付和取消请求。
// 它只做 HTTP 适配，两个库存模式的状态机和库存回补规则由 OrderService 保证。
type OrderHandler struct {
	order *service.OrderService
}

// Status 返回 stock_acquired/pending_payment/paid/cancelled 统一状态，供异步落单页面轮询。
func (h *OrderHandler) Status(ctx *gin.Context) {
	uid, err := strconv.Atoi(ctx.Query("uid"))
	if err != nil || uid <= 0 {
		writeAPIError(ctx, http.StatusBadRequest, "INVALID_UID", "uid 参数必须是正整数", err, "raw_uid", ctx.Query("uid"))
		return
	}
	gid, err := strconv.Atoi(ctx.Query("gid"))
	if err != nil || gid <= 0 {
		writeAPIError(ctx, http.StatusBadRequest, "INVALID_GID", "gid 参数必须是正整数", err, "raw_gid", ctx.Query("gid"), "uid", uid)
		return
	}
	state, appErr := h.order.Status(uid, gid)
	if appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	ctx.JSON(http.StatusOK, state)
}

// NewOrderHandler 创建订单相关的 HTTP handler。
// 通过注入 service，handler 不需要知道 Redis、MySQL、MQ 的具体协作细节。
func NewOrderHandler(order *service.OrderService) *OrderHandler {
	return &OrderHandler{order: order}
}

// Pay 处理用户支付请求。
// 该接口必须返回明确状态码和响应体；否则前端只能看到空响应，无法判断是参数错误、
// 资格过期，还是正式订单创建失败。
func (h *OrderHandler) Pay(ctx *gin.Context) {
	start := time.Now()
	// uid 是 user id，来自支付页 cookie 回填的表单字段。
	// 服务端会读取权威订单状态，不能只相信前端传参。
	uid, err := strconv.Atoi(ctx.PostForm("uid"))
	if err != nil {
		writeAPIError(ctx, http.StatusBadRequest, "INVALID_UID", "uid 参数必须是正整数", err, "raw_uid", ctx.PostForm("uid"))
		return
	}
	// gid 是 gift id，表示用户准备支付的奖品 ID。
	// 它必须和权威订单或 Redis admission 中保存的 gift id 一致。
	gid, err := strconv.Atoi(ctx.PostForm("gid"))
	if err != nil {
		writeAPIError(ctx, http.StatusBadRequest, "INVALID_GID", "gid 参数必须是正整数", err, "raw_gid", ctx.PostForm("gid"), "uid", uid)
		return
	}

	slog.Info("pay http request accepted", "uid", uid, "gid", gid, "client", ctx.ClientIP(), "method", ctx.Request.Method, "path", ctx.Request.URL.Path)
	if appErr := h.order.Pay(uid, gid); appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	slog.Info("pay http request success", "uid", uid, "gid", gid, "status", http.StatusOK, "duration_ms", time.Since(start).Milliseconds())
	ctx.String(http.StatusOK, "支付成功")
}

// GiveUp 处理用户主动放弃支付请求。
// 主动放弃会按 inventory_mode 进入 cancelled 并回补一次库存；paid 终态不能取消。
func (h *OrderHandler) GiveUp(ctx *gin.Context) {
	start := time.Now()
	// uid/gid 与支付接口含义一致，用来定位唯一订单；删除前端 cookie 不代表服务端取消完成。
	uid, err := strconv.Atoi(ctx.PostForm("uid"))
	if err != nil {
		writeAPIError(ctx, http.StatusBadRequest, "INVALID_UID", "uid 参数必须是正整数", err, "raw_uid", ctx.PostForm("uid"))
		return
	}
	gid, err := strconv.Atoi(ctx.PostForm("gid"))
	if err != nil {
		writeAPIError(ctx, http.StatusBadRequest, "INVALID_GID", "gid 参数必须是正整数", err, "raw_gid", ctx.PostForm("gid"), "uid", uid)
		return
	}

	slog.Info("give up http request accepted", "uid", uid, "gid", gid, "client", ctx.ClientIP(), "method", ctx.Request.Method, "path", ctx.Request.URL.Path)
	if appErr := h.order.GiveUp(uid, gid); appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	slog.Info("give up http request success", "uid", uid, "gid", gid, "status", http.StatusOK, "duration_ms", time.Since(start).Milliseconds())
	ctx.String(http.StatusOK, "已放弃")
}
