package service

import (
	"log/slog"
	"silas/internal/database"
	"silas/internal/metrics"
)

// OrderService 编排支付和放弃支付流程。
// 它只处理业务状态转换，不直接关心 HTTP 响应格式，避免业务规则被绑定到某个入口协议。
type OrderService struct {
	store *database.Store
}

// NewOrderService 创建订单服务。
// 订单服务依赖 MySQL 写正式订单，同时依赖 Redis 临时资格来判断用户是否真的抢到。
func NewOrderService(store *database.Store) *OrderService {
	slog.Info("order service initialized")
	return &OrderService{store: store}
}

// Pay 将用户的临时抢购资格转换为 MySQL 正式订单。
//
// 支付流程：
//
// 1. 通过 Redis Lua 认领临时资格
// 2. 认领成功后写入 MySQL 正式订单
// 3. MySQL 写入失败时显式回补 Redis 库存
//
// 参数语义:
//
//	uid 是 user id，用户 ID。
//	gid 是 gift id，奖品 ID。
//
// claim 在本项目里表示“支付前认领临时资格”：确认 porder_{uid} 仍属于当前 gid。
// 支付认领必须先于 MySQL 写入，否则 MQ 超时消息可能同时 release 释放资格，
// 造成用户已经支付但库存又被回补的问题。
func (s *OrderService) Pay(uid int, gid int) *AppError {
	slog.Info("pay service start", "uid", uid, "gid", gid)
	// 支付认领会删除临时资格但不回补库存。
	// 这让支付和 MQ 超时释放具备竞态安全性：同一份资格只能被其中一条路径消费。
	claimed, err := database.ClaimLotteryAdmission(uid, gid)
	if err != nil {
		metrics.RecordSystemError("支付资格确认失败", err)
		return NewAppError(CodeAdmissionFailed, "支付资格确认失败，请稍后重试", err, "uid", uid, "gid", gid)
	}
	if !claimed {
		slog.Warn("pay service rejected, admission not found", "uid", uid, "gid", gid)
		return NewAppError(CodeOrderNotOwned, "您没有抢到该商品，或支付时限已过", nil, "uid", uid, "gid", gid)
	}
	slog.Info("pay admission claimed", "uid", uid, "gid", gid)

	orderID, duplicated, err := s.store.CreateOrder(database.DefaultActivityID, uid, gid)
	if err != nil {
		metrics.RecordSystemError("创建正式订单失败", err)
		rollbackClaimedInventory(uid, gid, "order create failed")
		return NewAppError(CodeOrderCreateFailed, "抱歉，系统出错，请联系客服", err, "uid", uid, "gid", gid)
	}
	if duplicated {
		// 唯一索引命中说明该用户在当前活动已经有正式订单。
		// 这里必须回补本次已经 claim 的 Redis 库存，否则重复支付请求会消耗额外库存。
		rollbackClaimedInventory(uid, gid, "duplicate order")
		return NewAppError(CodeDuplicateParticipation, "请勿重复参与秒杀", nil, "uid", uid, "gid", gid, "activity_id", database.DefaultActivityID)
	}

	metrics.RecordOrderCompleted(gid)
	slog.Info("支付成功，临时订单已删除", "uid", uid, "gid", gid, "order_id", orderID, "activity_id", database.DefaultActivityID)
	return nil
}

// GiveUp 释放用户主动放弃的临时抢购资格。
// release 在本项目里表示“删除临时资格并回补 Redis 库存”。
// 主动放弃和 MQ 超时释放共用 Redis Lua，避免用户重复点击或超时消息随后到达时重复回补库存。
func (s *OrderService) GiveUp(uid int, gid int) *AppError {
	slog.Info("give up service start", "uid", uid, "gid", gid)
	// 放弃支付和超时释放共享同一个 Lua 脚本。
	// 这样重复放弃、已支付后放弃、超时消息晚到都不会把库存加回多次。
	released, err := database.ReleaseLotteryAdmission(uid, gid)
	if err != nil {
		metrics.RecordSystemError("用户放弃后库存回滚失败", err)
		return NewAppError(CodeGiveUpRollbackFailed, "库存回滚失败，请联系客服", err, "uid", uid, "gid", gid)
	}
	if !released {
		slog.Warn("give up service rejected, admission not found", "uid", uid, "gid", gid)
		return NewAppError(CodeOrderNotOwned, "您没有抢到该商品，或支付时限已过", nil, "uid", uid, "gid", gid)
	}

	metrics.RecordInventoryRollback(gid, "user give up")
	metrics.RecordGiveUp(gid)
	slog.Info("用户主动放弃支付", "uid", uid, "gid", gid)
	return nil
}

func rollbackClaimedInventory(uid int, gid int, reason string) {
	// 支付 claim 已经删除临时资格，不能再调用 ReleaseLotteryAdmission。
	// 这里直接回补奖品库存，专门处理“claim 成功但正式订单没有落库”的失败兜底。
	if err := database.IncreaseInventory(gid); err != nil {
		metrics.RecordSystemError("正式订单失败后库存回滚失败", err)
		slog.Error("pay order fallback inventory rollback failed", "uid", uid, "gid", gid, "reason", reason, "error", err)
		return
	}
	metrics.RecordInventoryRollback(gid, reason)
	slog.Warn("pay order fallback inventory rolled back", "uid", uid, "gid", gid, "reason", reason)
}
