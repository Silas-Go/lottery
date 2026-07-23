package handler

import (
	"log/slog"
	"net/http"
	"silas/internal/service"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
)

// PurchaseLabHandler 暴露共享材料库存上的购买、查询、重置和 Outbox 状态接口。
type PurchaseLabHandler struct {
	purchase *service.PurchaseLabService
}

func NewPurchaseLabHandler(purchase *service.PurchaseLabService) *PurchaseLabHandler {
	return &PurchaseLabHandler{purchase: purchase}
}

func (h *PurchaseLabHandler) State(ctx *gin.Context) {
	id, ok := purchaseLabMaterialID(ctx)
	if !ok {
		return
	}
	state, appErr := h.purchase.State(id)
	if appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	ctx.JSON(http.StatusOK, state)
}

func (h *PurchaseLabHandler) Reset(ctx *gin.Context) {
	id, ok := purchaseLabMaterialID(ctx)
	if !ok {
		return
	}
	state, appErr := h.purchase.Reset(id)
	if appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	ctx.JSON(http.StatusOK, gin.H{"message": "当前材料购买实验已重置", "state": state})
}

type purchaseLabRunRequest struct {
	RequestID     string                   `json:"requestId" binding:"required"`
	Strategy      service.PurchaseStrategy `json:"strategy" binding:"required"`
	PurchaseCount int                      `json:"purchaseCount" binding:"required"`
	QueryCount    int                      `json:"queryCount"`
}

func (h *PurchaseLabHandler) Run(ctx *gin.Context) {
	id, ok := purchaseLabMaterialID(ctx)
	if !ok {
		return
	}
	var request purchaseLabRunRequest
	if err := ctx.ShouldBindJSON(&request); err != nil {
		writeAPIError(ctx, http.StatusBadRequest, "PURCHASE_LAB_INVALID_REQUEST", "购买实验参数无效", err, "material_id", id)
		return
	}
	started := time.Now()
	result, appErr := h.purchase.RunExperiment(ctx.Request.Context(), id, service.PurchaseExperimentRequest{
		RequestID: request.RequestID, Strategy: request.Strategy,
		PurchaseCount: request.PurchaseCount, QueryCount: request.QueryCount,
	})
	if appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	slog.Info("purchase lab run completed",
		"material_id", id, "strategy", request.Strategy,
		"request_id", request.RequestID, "status", result.Status,
		"purchase_count", request.PurchaseCount, "query_count", request.QueryCount,
		"old_reads", result.OldReadCount,
		"duration_ms", time.Since(started).Milliseconds())
	ctx.JSON(http.StatusOK, result)
}

func (h *PurchaseLabHandler) GetRun(ctx *gin.Context) {
	result, appErr := h.purchase.GetRun(ctx.Param("requestId"))
	if appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	ctx.JSON(http.StatusOK, result)
}

type purchaseLabQueryRequest struct {
	Count int `json:"count" binding:"required"`
}

func (h *PurchaseLabHandler) Query(ctx *gin.Context) {
	id, ok := purchaseLabMaterialID(ctx)
	if !ok {
		return
	}
	var request purchaseLabQueryRequest
	if err := ctx.ShouldBindJSON(&request); err != nil {
		writeAPIError(ctx, http.StatusBadRequest, "PURCHASE_LAB_INVALID_QUERY",
			"购买实验查询参数无效", err, "material_id", id)
		return
	}
	samples, appErr := h.purchase.Query(id, request.Count)
	if appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	ctx.JSON(http.StatusOK, gin.H{"samples": samples})
}

func purchaseLabMaterialID(ctx *gin.Context) (int, bool) {
	id, err := strconv.Atoi(ctx.Param("id"))
	if err != nil || id <= 0 {
		writeAPIError(ctx, http.StatusBadRequest, "PURCHASE_LAB_INVALID_MATERIAL", "购买实验材料编号无效", err)
		return 0, false
	}
	return id, true
}
