package handler

import (
	"fmt"
	"net/http"
	"silas/internal/database"
	"silas/internal/metrics"

	"github.com/gin-gonic/gin"
)

// LabHandler 处理只用于本地演示/压测实验室的管理接口。
// 这些接口会修改真实 MySQL/Redis 状态，不属于正式业务 API。
type LabHandler struct {
	store *database.Store
}

func NewLabHandler(store *database.Store) *LabHandler {
	return &LabHandler{store: store}
}

// ResetLab 重置本地实验状态：订单、Redis 临时资格、两套库存和内存指标全部回到初始基线。
func (h *LabHandler) ResetLab(ctx *gin.Context) {
	if err := h.store.ResetExperimentState(); err != nil {
		writeAPIError(ctx, http.StatusInternalServerError, "LAB_RESET_FAILED", "实验数据重置失败", err)
		return
	}

	activityStock, redisStock, err := inventoryTotals(h.store)
	if err != nil {
		writeAPIError(ctx, http.StatusInternalServerError, "LAB_RESET_METRICS_FAILED", "实验数据已重置，但指标基线刷新失败", err)
		return
	}
	metrics.ResetAll(activityStock, redisStock)

	ctx.JSON(http.StatusOK, gin.H{
		"message":  "实验数据已重置",
		"snapshot": metrics.SnapshotNow(),
	})
}

func inventoryTotals(store *database.Store) (int64, int64, error) {
	baseGifts, err := store.GetAllGiftsWithError()
	if err != nil {
		return 0, 0, err
	}
	redisGifts, err := database.GetAllGiftInventoryWithError()
	if err != nil {
		return 0, 0, err
	}

	var activityStock int64
	for _, gift := range baseGifts {
		if gift.Count > 0 {
			activityStock += int64(gift.Count)
		}
	}

	var redisStock int64
	for _, gift := range redisGifts {
		if gift.Count > 0 {
			redisStock += int64(gift.Count)
		}
	}
	if activityStock == 0 {
		return 0, 0, fmt.Errorf("activity stock baseline is empty")
	}
	return activityStock, redisStock, nil
}
