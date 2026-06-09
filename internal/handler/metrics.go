package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"silas/internal/metrics"
	"time"

	"github.com/gin-gonic/gin"
)

func GetMetricsSnapshot(ctx *gin.Context) {
	ctx.JSON(http.StatusOK, metrics.SnapshotNow())
}

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
