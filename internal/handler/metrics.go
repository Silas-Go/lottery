package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"silas/internal/metrics"
	"time"

	"github.com/gin-gonic/gin"
)

// GetMetricsSnapshot 返回当前秒杀指标快照。
// snapshot 是“某一时刻的指标截面”，用于页面首次加载或手动排查，不会驱动业务状态变化。
func GetMetricsSnapshot(ctx *gin.Context) {
	ctx.JSON(http.StatusOK, metrics.SnapshotNow())
}

// StreamMetrics 通过 SSE 持续推送秒杀指标。
// SSE 是 Server-Sent Events，浏览器只接收服务端推送，不需要 WebSocket 双向连接。
// 指标流只展示真实服务端 metrics，不能用前端模拟数据替代。
func StreamMetrics(ctx *gin.Context) {
	ctx.Header("Content-Type", "text/event-stream")
	ctx.Header("Cache-Control", "no-cache")
	ctx.Header("Connection", "keep-alive")
	ctx.Header("X-Accel-Buffering", "no")

	flusher, ok := ctx.Writer.(http.Flusher)
	if !ok {
		ctx.String(http.StatusInternalServerError, "streaming is not supported")
		return
	}

	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	writeMetricsEvent(ctx, flusher)
	for {
		select {
		case <-ctx.Request.Context().Done():
			return
		case <-ticker.C:
			writeMetricsEvent(ctx, flusher)
		}
	}
}

func writeMetricsEvent(ctx *gin.Context, flusher http.Flusher) {
	payload, err := json.Marshal(metrics.SnapshotNow())
	if err != nil {
		return
	}
	fmt.Fprintf(ctx.Writer, "event: metrics\n")
	fmt.Fprintf(ctx.Writer, "data: %s\n\n", payload)
	flusher.Flush()
}
