package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"silas/internal/metrics"
	"silas/internal/service"
	"strconv"

	"github.com/gin-gonic/gin"
)

const maxArchiveExperimentBody = 4 << 10

// ArchiveHandler 暴露第一章的职业目录、直读、缓存读和重置接口。
type ArchiveHandler struct {
	archive *service.ArchiveService
}

func NewArchiveHandler(archive *service.ArchiveService) *ArchiveHandler {
	return &ArchiveHandler{archive: archive}
}

func (h *ArchiveHandler) List(ctx *gin.Context) {
	archives, appErr := h.archive.List()
	if appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	ctx.JSON(http.StatusOK, archives)
}

func (h *ArchiveHandler) ReadDirect(ctx *gin.Context) {
	h.read(ctx, false)
}

func (h *ArchiveHandler) ReadCached(ctx *gin.Context) {
	h.read(ctx, true)
}

func (h *ArchiveHandler) read(ctx *gin.Context, cached bool) {
	id, err := strconv.Atoi(ctx.Param("id"))
	if err != nil || id <= 0 {
		writeAPIError(ctx, http.StatusBadRequest, "INVALID_ARCHIVE_ID", "材料档案编号无效", err)
		return
	}
	var archiveSource service.ArchiveSource
	var appErr *service.AppError
	var archive any
	var sqlQueries int
	if cached {
		archive, archiveSource, sqlQueries, appErr = h.archive.ReadCached(id)
		ctx.Header("X-Read-Path", "cache-aside")
	} else {
		archive, archiveSource, sqlQueries, appErr = h.archive.ReadDirect(id)
		ctx.Header("X-Read-Path", "mysql-direct")
	}
	ctx.Header("X-Archive-Source", string(archiveSource))
	ctx.Header("X-SQL-Queries", strconv.Itoa(sqlQueries))
	if appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	// 两条路径只在响应头标记数据来源，响应体保持完全一致，避免压测变量被 payload 大小污染。
	ctx.JSON(http.StatusOK, archive)
}

func (h *ArchiveHandler) ResetChapter(ctx *gin.Context) {
	if appErr := h.archive.ResetChapter(); appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	ctx.JSON(http.StatusOK, gin.H{
		"message":  "材料档案已合拢，记忆水晶与本章指标均已清空",
		"snapshot": metrics.SnapshotArchiveRead(metrics.ArchiveCacheTTL),
	})
}

// PrepareExperiment 只供受控 Runner 建立一轮短租约缓存场景。
func (h *ArchiveHandler) PrepareExperiment(ctx *gin.Context) {
	var input service.ArchiveExperimentPrepareRequest
	if !decodeArchiveExperimentBody(ctx, &input) {
		return
	}
	state, appErr := h.archive.PrepareExperiment(input)
	if appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	ctx.JSON(http.StatusOK, state)
}

// EvictExperiment 对已预热的热点 Key 执行一次真实失效。
func (h *ArchiveHandler) EvictExperiment(ctx *gin.Context) {
	var input service.ArchiveExperimentControlRequest
	if !decodeArchiveExperimentBody(ctx, &input) {
		return
	}
	state, appErr := h.archive.EvictExperiment(input.Token)
	if appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	ctx.JSON(http.StatusOK, state)
}

// FinishExperiment 清理负缓存与任务作用域，并确保热点 Key 已恢复。
func (h *ArchiveHandler) FinishExperiment(ctx *gin.Context) {
	var input service.ArchiveExperimentControlRequest
	if !decodeArchiveExperimentBody(ctx, &input) {
		return
	}
	state, appErr := h.archive.FinishExperiment(input.Token)
	if appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	ctx.JSON(http.StatusOK, state)
}

// ReadExperiment 是 wrk2 的任务级读取入口；没有当前令牌时不会进入 Redis 或 MySQL。
func (h *ArchiveHandler) ReadExperiment(ctx *gin.Context) {
	archive, source, sqlQueries, appErr := h.archive.ReadExperiment(ctx.GetHeader("X-Experiment-Token"))
	ctx.Header("X-Read-Path", "cache-experiment")
	ctx.Header("X-Archive-Source", string(source))
	ctx.Header("X-SQL-Queries", strconv.Itoa(sqlQueries))
	if appErr != nil {
		// 不存在 ID 是穿透场景的预期业务响应。逐请求写错误日志会反过来污染压测，
		// 因此只保留 HTTP 404、响应头和聚合指标，真正异常仍走统一错误日志。
		if appErr.Code == service.CodeArchiveNotFound {
			ctx.Header("X-Error-Code", appErr.Code)
			ctx.JSON(http.StatusNotFound, apiErrorResponse{
				Status: http.StatusNotFound, Code: appErr.Code, Message: appErr.Message,
			})
			return
		}
		writeServiceError(ctx, appErr)
		return
	}
	ctx.JSON(http.StatusOK, archive)
}

func decodeArchiveExperimentBody(ctx *gin.Context, output any) bool {
	ctx.Request.Body = http.MaxBytesReader(ctx.Writer, ctx.Request.Body, maxArchiveExperimentBody)
	decoder := json.NewDecoder(ctx.Request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		writeAPIError(ctx, http.StatusBadRequest, service.CodeArchiveExperimentInvalid, "缓存实验请求不是有效 JSON", err)
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeAPIError(ctx, http.StatusBadRequest, service.CodeArchiveExperimentInvalid, "请求体只能包含一个 JSON 对象", nil)
		return false
	}
	return true
}
