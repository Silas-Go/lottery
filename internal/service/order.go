package service

import (
	"log/slog"
	"silas/internal/database"
	"silas/internal/metrics"
)

type OrderService struct {
	store *database.Store
}

func NewOrderService(store *database.Store) *OrderService {
	return &OrderService{store: store}
}

func (s *OrderService) Pay(uid int, gid int) *AppError {
	tempOrderGid := database.GetTempOrder(uid)
	if tempOrderGid != gid {
		return NewAppError(CodeOrderNotOwned, "您没有抢到该商品，或支付时限已过", nil, "uid", uid, "gid", gid)
	}

	if s.store.CreateOrder(uid, gid) <= 0 {
		metrics.RecordSystemError("创建正式订单失败", nil)
		return NewAppError(CodeOrderCreateFailed, "抱歉，系统出错，请联系客服", nil, "uid", uid, "gid", gid)
	}

	database.DeleteTempOrder(uid, gid)
	metrics.RecordOrderCompleted(gid)
	slog.Info("支付成功，临时订单已删除", "uid", uid, "gid", gid)
	return nil
}

func (s *OrderService) GiveUp(uid int, gid int) *AppError {
	database.DeleteTempOrder(uid, gid)
	if err := database.IncreaseInventory(gid); err != nil {
		metrics.RecordSystemError("用户放弃后库存回滚失败", err)
		return NewAppError(CodeGiveUpRollbackFailed, "库存回滚失败，请联系客服", err, "uid", uid, "gid", gid)
	}

	metrics.RecordInventoryRollback(gid, "user give up")
	metrics.RecordGiveUp(gid)
	slog.Info("用户主动放弃支付", "uid", uid, "gid", gid)
	return nil
}
