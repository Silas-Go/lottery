package handler

import (
	"dqq/go/frame/lottery/database"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

// 用户完成支付
func Pay(ctx *gin.Context) {
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
	if database.CreateOrder(uid, gid) > 0 {
		database.DeleteTempOrder(uid, gid)
		slog.Info("支付成功，临时订单已删除", "uid", uid, "gid", gid)
	} else {
		ctx.String(http.StatusInternalServerError, "抱歉，系统出错，请联系客服")
	}
}

// 用户放弃抢到的商品
func GiveUp(ctx *gin.Context) {
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
	database.IncreaseInventory(gid)
	slog.Info("用户主动放弃支付", "uid", uid, "gid", gid)
}
