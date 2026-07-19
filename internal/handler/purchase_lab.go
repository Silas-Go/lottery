package handler

import (
	"log/slog"
	"net/http"
	"silas/internal/service"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
)

// PurchaseLabHandler 暴露独立材料夹具的状态、重置和写顺序实验。
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
	Strategy        service.PurchaseStrategy `json:"strategy" binding:"required"`
	ConcurrentQuery bool                     `json:"concurrentQuery"`
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
	result, appErr := h.purchase.Run(id, request.Strategy, request.ConcurrentQuery)
	if appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
	slog.Info("purchase lab run completed",
		"material_id", id, "strategy", request.Strategy,
		"concurrent_query", request.ConcurrentQuery, "dirty_cache", result.DirtyCache,
		"duration_ms", time.Since(started).Milliseconds())
	ctx.JSON(http.StatusOK, result)
}

func purchaseLabMaterialID(ctx *gin.Context) (int, bool) {
	id, err := strconv.Atoi(ctx.Param("id"))
	if err != nil || id <= 0 {
		writeAPIError(ctx, http.StatusBadRequest, "PURCHASE_LAB_INVALID_MATERIAL", "购买实验材料编号无效", err)
		return 0, false
	}
	return id, true
}
