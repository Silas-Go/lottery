package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"silas/internal/loadtest"
	"silas/internal/service"

	"github.com/gin-gonic/gin"
)

const maxLoadtestCreateBody = 4 << 10

// LoadtestHandler 适配浏览器任务 API 与 Runner SSE 流。
type LoadtestHandler struct {
	service *service.LoadtestService
}

// NewLoadtestHandler 创建压测 HTTP handler。
func NewLoadtestHandler(loadtestService *service.LoadtestService) *LoadtestHandler {
	return &LoadtestHandler{service: loadtestService}
}

// Create 严格解析白名单任务输入并异步创建任务。
func (h *LoadtestHandler) Create(ctx *gin.Context) {
	ctx.Request.Body = http.MaxBytesReader(ctx.Writer, ctx.Request.Body, maxLoadtestCreateBody)
	decoder := json.NewDecoder(ctx.Request.Body)
	decoder.DisallowUnknownFields()
	var input loadtest.CreateRequest
	if err := decoder.Decode(&input); err != nil {
		writeAPIError(ctx, http.StatusBadRequest, service.CodeLoadtestInvalidRequest, "压测请求不是有效 JSON", err)
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeAPIError(ctx, http.StatusBadRequest, service.CodeLoadtestInvalidRequest, "请求体只能包含一个 JSON 对象", nil)
		return
	}
	response, appErr := h.service.Start(ctx.Request.Context(), input)
	if appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	ctx.JSON(http.StatusAccepted, response)
}

// Get 返回任务权威快照，供刷新与 SSE 断线恢复。
func (h *LoadtestHandler) Get(ctx *gin.Context) {
	task, appErr := h.service.Get(ctx.Request.Context(), ctx.Param("id"))
	if appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	ctx.JSON(http.StatusOK, task)
}

// Stop 等待 Runner 回收子进程后返回终态。
func (h *LoadtestHandler) Stop(ctx *gin.Context) {
	task, appErr := h.service.Stop(ctx.Request.Context(), ctx.Param("id"))
	if appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	ctx.JSON(http.StatusOK, task)
}

// Events 逐块转发 Runner SSE，不在主应用缓冲整个响应。
// 浏览器断开只会取消这条订阅，不会取消后台压测任务；再次连接可通过 Last-Event-ID 回放。
func (h *LoadtestHandler) Events(ctx *gin.Context) {
	response, appErr := h.service.OpenEvents(ctx.Request.Context(), ctx.Param("id"), ctx.GetHeader("Last-Event-ID"))
	if appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	defer response.Body.Close()

	ctx.Header("Content-Type", "text/event-stream")
	ctx.Header("Cache-Control", "no-cache")
	ctx.Header("Connection", "keep-alive")
	ctx.Header("X-Accel-Buffering", "no")
	ctx.Status(http.StatusOK)
	flusher, ok := ctx.Writer.(http.Flusher)
	if !ok {
		writeAPIError(ctx, http.StatusInternalServerError, service.CodeLoadtestRunnerFailure, "当前 HTTP writer 不支持 SSE", nil)
		return
	}
	buffer := make([]byte, 4096)
	for {
		count, err := response.Body.Read(buffer)
		if count > 0 {
			if _, writeErr := ctx.Writer.Write(buffer[:count]); writeErr != nil {
				return
			}
			flusher.Flush()
		}
		if err != nil {
			if err != io.EOF && ctx.Request.Context().Err() == nil {
				_, _ = fmt.Fprintf(ctx.Writer, "event: failed\ndata: {\"code\":\"%s\",\"message\":\"SSE 转发中断\"}\n\n", service.CodeLoadtestRunnerUnavailable)
				flusher.Flush()
			}
			return
		}
	}
}
