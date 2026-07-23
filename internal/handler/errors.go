package handler

import (
	"log/slog"
	"net/http"
	"silas/internal/service"

	"github.com/gin-gonic/gin"
)

type apiErrorResponse struct {
	Status  int    `json:"status"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Detail  string `json:"detail,omitempty"`
}

// writeServiceError 将 service 层业务错误转换成 HTTP 状态码和 JSON 响应。
// handler 不直接猜测底层错误类型，而是只依赖 AppError.Code，
// 这样 Redis、MQ、MySQL 的失败都能稳定落到前端可识别的状态码上。
func writeServiceError(ctx *gin.Context, err *service.AppError) {
	writeAPIError(ctx, statusForCode(err.Code), err.Code, err.Message, err.Err, err.Attrs...)
}

// writeAPIError 统一输出接口错误响应和结构化日志。
// 这里同时写 X-Error-Code 响应头，是为了浏览器 Network 面板即使响应体没展开，
// 也能一眼看到失败原因，避免再次出现“接口空返回但不知道哪里坏了”的情况。
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

// statusForCode 定义业务错误码到 HTTP 状态码的映射。
// 映射放在 handler 层，是因为 HTTP 只是其中一种入口协议；
// service 层只表达业务失败原因，不绑定具体的网络响应语义。
func statusForCode(code string) int {
	switch code {
	case service.CodeNoGiftsConfigured,
		service.CodeArchiveNotFound,
		service.CodePurchaseLabMaterialNotFound,
		service.CodePurchaseLabRunNotFound:
		return http.StatusNotFound
	case service.CodeRateLimited:
		return http.StatusTooManyRequests
	case service.CodePurchaseLabInvalidStrategy:
		return http.StatusBadRequest
	case service.CodeLoadtestInvalidRequest:
		return http.StatusBadRequest
	case service.CodeDuplicateParticipation,
		service.CodeInventoryRetryExhaust,
		service.CodeOrderCancelled,
		service.CodeOrderAlreadyPaid,
		service.CodeOrderStateConflict,
		service.CodePurchaseLabSoldOut,
		service.CodePurchaseLabRequestConflict,
		service.CodeLoadtestAlreadyRunning:
		return http.StatusConflict
	case service.CodeLoadtestNotFound:
		return http.StatusNotFound
	case service.CodeOrderProcessing:
		return http.StatusTooEarly
	case service.CodeOrderNotOwned:
		return http.StatusForbidden
	case service.CodeGiftDBReadFailed,
		service.CodeAdmissionFailed,
		service.CodeRedisInventoryReadFail,
		service.CodeTempOrderCreateFailed,
		service.CodeMQSendFailed,
		service.CodeCacheAsideOverload,
		service.CodeArchiveDBReadFailed,
		service.CodeArchiveCacheResetFailed,
		service.CodePurchaseLabUnavailable,
		service.CodeLoadtestRunnerFailure,
		service.CodeLoadtestRunnerUnavailable:
		return http.StatusServiceUnavailable
	case service.CodeLoadtestStopTimeout:
		return http.StatusGatewayTimeout
	default:
		return http.StatusInternalServerError
	}
}
