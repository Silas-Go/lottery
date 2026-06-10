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

func writeServiceError(ctx *gin.Context, err *service.AppError) {
	writeAPIError(ctx, statusForCode(err.Code), err.Code, err.Message, err.Err, err.Attrs...)
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

func statusForCode(code string) int {
	switch code {
	case service.CodeNoGiftsConfigured:
		return http.StatusNotFound
	case service.CodeRateLimited:
		return http.StatusTooManyRequests
	case service.CodeDuplicateParticipation,
		service.CodeInventoryRetryExhaust:
		return http.StatusConflict
	case service.CodeOrderNotOwned:
		return http.StatusForbidden
	case service.CodeGiftDBReadFailed,
		service.CodeAdmissionFailed,
		service.CodeRedisInventoryReadFail,
		service.CodeTempOrderCreateFailed,
		service.CodeMQSendFailed:
		return http.StatusServiceUnavailable
	default:
		return http.StatusInternalServerError
	}
}
