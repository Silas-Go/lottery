package handler

import (
	"log/slog"
	"net/http"
	"silas/internal/service"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
)

// OrderHandler 处理支付和放弃支付 HTTP 请求。
// 它只解析表单参数并输出统一错误格式，资格认领和库存回补规则由 OrderService 保证。
type OrderHandler struct {
	order *service.OrderService
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
	// 服务端仍会到 Redis 校验 porder_{uid}，不能只相信前端传参。
	uid, err := strconv.Atoi(ctx.PostForm("uid"))
	if err != nil {
		writeAPIError(ctx, http.StatusBadRequest, "INVALID_UID", "uid 参数必须是正整数", err, "raw_uid", ctx.PostForm("uid"))
		return
	}
	// gid 是 gift id，表示用户准备支付的奖品 ID。
	// 它必须和 Redis 临时资格中保存的 gift id 一致，才能完成 claim。
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
// 主动放弃会释放 Redis 临时资格并回补库存；如果资格已支付或超时释放，会返回业务错误而不是重复回补。
func (h *OrderHandler) GiveUp(ctx *gin.Context) {
	start := time.Now()
	// uid/gid 与支付接口含义一致，用来定位并校验 Redis 临时资格。
	// 放弃不是删除前端 cookie 就结束，必须由服务端 release 回补库存。
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
