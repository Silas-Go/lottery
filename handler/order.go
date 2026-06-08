package handler

import (
	"log/slog"
	"net/http"
	"silas/database"
	"silas/metrics"
	"strconv"

	"github.com/gin-gonic/gin"
)

type OrderHandler struct {
	store *database.Store
}

func NewOrderHandler(store *database.Store) *OrderHandler {
	return &OrderHandler{store: store}
}

// 用户完成支付
func (h *OrderHandler) Pay(ctx *gin.Context) {
	uid, err := strconv.Atoi(ctx.PostForm("uid"))
	if err != nil {
		ctx.String(http.StatusBadRequest, err.Error())
		return
	}
	gid, err := strconv.Atoi(ctx.PostForm("gid"))
	if err != nil {
		ctx.String(http.StatusBadRequest, err.Error())
		return
	}

	// 能找到临时订单，证明他抢单成功
	tempOrderGid := database.GetTempOrder(uid)
	if tempOrderGid != gid {
		ctx.String(http.StatusForbidden, "您没有抢到该商品，或支付时限已过")
		return
	}

	// 生成正式订单，删除临时订单
	if h.store.CreateOrder(uid, gid) > 0 {
		database.DeleteTempOrder(uid, gid)
		metrics.RecordOrderCompleted(gid)
		slog.Info("支付成功，临时订单已删除", "uid", uid, "gid", gid)
	} else {
		metrics.RecordSystemError("创建正式订单失败", nil)
		ctx.String(http.StatusInternalServerError, "抱歉，系统出错，请联系客服")
	}
}

// 用户放弃抢到的商品
func (h *OrderHandler) GiveUp(ctx *gin.Context) {
	uid, err := strconv.Atoi(ctx.PostForm("uid"))
	if err != nil {
		ctx.String(http.StatusBadRequest, err.Error())
		return
	}
	gid, err := strconv.Atoi(ctx.PostForm("gid"))
	if err != nil {
		ctx.String(http.StatusBadRequest, err.Error())
		return
	}

	// 删除临时订单
	database.DeleteTempOrder(uid, gid)
	// 库存加1
	if err := database.IncreaseInventory(gid); err != nil {
		metrics.RecordSystemError("用户放弃后库存回滚失败", err)
		ctx.String(http.StatusInternalServerError, "库存回滚失败，请联系客服")
		return
	}
	metrics.RecordInventoryRollback(gid, "user give up")
	metrics.RecordGiveUp(gid)
	slog.Info("用户主动放弃支付", "uid", uid, "gid", gid)
}
