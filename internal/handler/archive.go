package handler

import (
	"net/http"
	"silas/internal/metrics"
	"silas/internal/service"
	"strconv"

	"github.com/gin-gonic/gin"
)

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
		"message":  "《百职录》已合拢，记忆水晶与本章指标均已清空",
		"snapshot": metrics.SnapshotArchiveRead(metrics.ArchiveCacheTTL),
	})
}
