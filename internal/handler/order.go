package handler

import (
	"net/http"
	"silas/internal/service"
	"strconv"

	"github.com/gin-gonic/gin"
)

type OrderHandler struct {
	order *service.OrderService
}

func NewOrderHandler(order *service.OrderService) *OrderHandler {
	return &OrderHandler{order: order}
}

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

	if appErr := h.order.Pay(uid, gid); appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
}

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

	if appErr := h.order.GiveUp(uid, gid); appErr != nil {
		writeServiceError(ctx, appErr)
		return
	}
}
