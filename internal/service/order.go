package service

import (
	"errors"
	"fmt"
	"log/slog"
	"silas/internal/database"
	"silas/internal/metrics"
	"time"
)

// OrderService 统一编排两个库存模式的订单状态机。
// MySQL 模式用数据库条件更新裁决支付/取消；Redis 模式用 admission Lua 裁决，MySQL 记录最终账本。
type OrderService struct {
	store *database.Store
}

// OrderStateView 是状态查询接口使用的稳定业务视图。
type OrderStateView struct {
	BusinessOrderID string                 `json:"order_id,omitempty"`
	RunID           string                 `json:"run_id,omitempty"`
	OrderID         int                    `json:"orderId,omitempty"`
	UID             int                    `json:"uid"`
	GiftID          int                    `json:"giftId"`
	Status          database.OrderStatus   `json:"status"`
	InventoryMode   database.InventoryMode `json:"inventoryMode"`
	ExpiresAt       time.Time              `json:"expiresAt,omitempty"`
}

func NewOrderService(store *database.Store) *OrderService {
	slog.Info("order service initialized")
	return &OrderService{store: store}
}

// CreateRedisPendingOrder 是普通 MQ 创建订单消息的消费回调。
// 它只允许 stock_acquired -> pending_payment，重复消息返回幂等成功，迟到消息不能覆盖 paid/cancelled。
func (s *OrderService) CreateRedisPendingOrder(command database.Order) error {
	defer database.BeginSeckillOperation()()
	identity := command.Identity()

	admission, err := database.GetLotteryAdmission(command.UserId)
	if err != nil {
		return err
	}
	if !admission.Matches(command.GiftId, identity) {
		// 重置实验或终态过期后到达的旧消息没有可消费的库存资格，直接忽略，不能凭消息复活订单。
		metrics.RecordIgnoredOrderMessage()
		slog.Info("stale create order ignored", "uid", command.UserId, "gid", command.GiftId, "order_id", identity.OrderID, "run_id", identity.RunID)
		return nil
	}

	if identity.OrderID != "" {
		runID, runErr := database.CurrentSeckillRun()
		if runErr != nil {
			return runErr
		}
		if runID != identity.RunID {
			metrics.RecordIgnoredOrderMessage()
			slog.Info("stale order run ignored", "order_id", identity.OrderID, "run_id", identity.RunID)
			return nil
		}
	}
	expiresAt := command.ExpiresAt
	if expiresAt.IsZero() {
		expiresAt = time.Now().Add(time.Duration(PayDelaySeconds) * time.Second)
	}
	if admission.State == database.OrderStatusCancelled {
		_, _, err := s.store.RecordReleasedRedisCancellation(database.DefaultActivityID, command.UserId, command.GiftId, expiresAt, "cancelled_before_order_created", identity)
		return err
	}

	order, _, err := s.store.CreatePendingOrder(database.DefaultActivityID, command.UserId, command.GiftId, database.InventoryModeRedis, expiresAt, identity)
	if err != nil {
		return err
	}
	if order.GiftId != command.GiftId || order.InventoryMode != database.InventoryModeRedis {
		return fmt.Errorf("async order conflicts with existing order id=%d", order.Id)
	}
	if order.Status == database.OrderStatusPaid || order.Status == database.OrderStatusCancelled {
		return nil
	}
	if admission.State == database.OrderStatusPaid {
		updated, _, transitionErr := s.store.TransitionPendingOrderToPaid(order.Id)
		if transitionErr != nil {
			return transitionErr
		}
		if updated.Status != database.OrderStatusPaid {
			return fmt.Errorf("paid admission conflicts with order status %s", updated.Status)
		}
		return nil
	}

	advanced, err := database.MarkLotteryAdmissionPendingPayment(command.UserId, command.GiftId, identity)
	if err != nil {
		return err
	}
	if advanced {
		metrics.RecordCreateOrderConsumed()
		slog.Info("async order entered pending_payment", "ledger_id", order.Id, "order_id", identity.OrderID, "run_id", identity.RunID, "uid", command.UserId, "gid", command.GiftId)
		return nil
	}

	// 创建订单和推进 Redis 状态之间允许取消并发；重新读取终态并把账本收敛，绝不能把取消复活。
	admission, err = database.GetLotteryAdmission(command.UserId)
	if err != nil {
		return err
	}
	if admission.Matches(command.GiftId, identity) && admission.State == database.OrderStatusPendingPayment {
		return nil
	}
	if admission.Matches(command.GiftId, identity) && admission.State == database.OrderStatusCancelled {
		_, _, err = s.store.RecordReleasedRedisCancellation(database.DefaultActivityID, command.UserId, command.GiftId, expiresAt, "cancelled_during_order_creation", identity)
		return err
	}
	return fmt.Errorf("admission cannot enter pending_payment uid=%d gid=%d", command.UserId, command.GiftId)
}

// Pay 只允许 pending_payment -> paid。
// paid 重试幂等成功；stock_acquired 返回处理中；cancelled 永远不能被支付复活。
func (s *OrderService) Pay(uid int, gid int, identities ...database.OrderIdentity) *AppError {
	defer database.BeginSeckillOperation()()
	identity := requestIdentity(identities)

	order, err := s.store.FindOrderIdentity(database.DefaultActivityID, uid, identity)
	if errors.Is(err, database.ErrOrderNotFound) {
		return s.payBeforeLedgerCreated(uid, gid, identity)
	}
	if err != nil {
		return NewAppError(CodeOrderCreateFailed, "读取订单状态失败，请稍后重试", err, "uid", uid, "gid", gid)
	}
	if order.GiftId != gid {
		return NewAppError(CodeOrderNotOwned, "订单与商品不匹配", nil, "uid", uid, "gid", gid, "order_id", order.Id)
	}

	switch order.Status {
	case database.OrderStatusPaid:
		return nil
	case database.OrderStatusCancelled:
		return NewAppError(CodeOrderCancelled, "订单已经取消，不能继续支付", nil, "uid", uid, "gid", gid, "order_id", order.Id)
	case database.OrderStatusStockAcquired:
		return NewAppError(CodeOrderProcessing, "库存已锁定，订单仍在创建中，请稍后重试", nil, "uid", uid, "gid", gid)
	case database.OrderStatusPendingPayment:
	default:
		return NewAppError(CodeOrderStateConflict, "订单状态异常，请联系客服", nil, "uid", uid, "gid", gid, "status", order.Status)
	}

	if !order.ExpiresAt.IsZero() && !time.Now().Before(order.ExpiresAt) {
		_, cancelErr := s.cancel(uid, gid, "payment_timeout", order.ExpiresAt, identity)
		if cancelErr != nil && cancelErr.Code == CodeOrderAlreadyPaid {
			return nil
		}
		if cancelErr != nil {
			return cancelErr
		}
		return NewAppError(CodeOrderCancelled, "订单已超过支付时限", nil, "uid", uid, "gid", gid)
	}

	if order.InventoryMode == database.InventoryModeRedis {
		claimed, claimErr := database.ClaimLotteryAdmission(uid, gid, identity)
		if claimErr != nil {
			metrics.RecordSystemError("支付资格状态迁移失败", claimErr)
			return NewAppError(CodeAdmissionFailed, "支付资格确认失败，请稍后重试", claimErr, "uid", uid, "gid", gid)
		}
		if !claimed {
			admission, getErr := database.GetLotteryAdmission(uid)
			if getErr != nil {
				return NewAppError(CodeAdmissionFailed, "读取支付资格失败，请稍后重试", getErr, "uid", uid, "gid", gid)
			}
			return appErrorForAdmission(admission, gid, uid)
		}
	}

	updated, transitioned, err := s.store.TransitionPendingOrderToPaid(order.Id)
	if err != nil {
		// Redis 模式已经进入 paid 时不能回退或回补库存；客户端重试会继续把 MySQL 账本推进到 paid。
		metrics.RecordSystemError("订单支付状态落库失败", err)
		return NewAppError(CodeOrderCreateFailed, "支付状态保存失败，请重试", err, "uid", uid, "gid", gid, "order_id", order.Id)
	}
	if updated.Status == database.OrderStatusCancelled {
		return NewAppError(CodeOrderStateConflict, "订单已被取消，支付结果需要人工核对", nil, "uid", uid, "gid", gid, "order_id", order.Id)
	}
	if updated.Status != database.OrderStatusPaid {
		return NewAppError(CodeOrderStateConflict, "订单未能进入已支付状态", nil, "uid", uid, "gid", gid, "status", updated.Status)
	}
	if transitioned {
		metrics.RecordOrderCompleted(gid)
		slog.Info("order transitioned to paid", "order_id", order.Id, "uid", uid, "gid", gid, "inventory_mode", order.InventoryMode)
	}
	return nil
}

func (s *OrderService) payBeforeLedgerCreated(uid, gid int, identity database.OrderIdentity) *AppError {
	admission, err := database.GetLotteryAdmission(uid)
	if err != nil {
		return NewAppError(CodeAdmissionFailed, "读取订单处理状态失败", err, "uid", uid, "gid", gid)
	}
	if !admission.Matches(gid, identity) {
		return NewAppError(CodeOrderNotOwned, "您没有该商品的有效订单", nil, "uid", uid, "gid", gid)
	}
	return appErrorForAdmission(admission, gid, uid)
}

func appErrorForAdmission(admission *database.LotteryAdmission, gid, uid int) *AppError {
	if admission == nil || admission.GiftID != gid {
		return NewAppError(CodeOrderNotOwned, "您没有该商品的有效订单", nil, "uid", uid, "gid", gid)
	}
	switch admission.State {
	case database.OrderStatusStockAcquired:
		return NewAppError(CodeOrderProcessing, "库存已锁定，订单仍在异步创建中，请稍后重试", nil, "uid", uid, "gid", gid)
	case database.OrderStatusPendingPayment:
		return NewAppError(CodeOrderProcessing, "订单账本正在同步，请稍后重试", nil, "uid", uid, "gid", gid)
	case database.OrderStatusCancelled:
		return NewAppError(CodeOrderCancelled, "订单已经取消，不能继续支付", nil, "uid", uid, "gid", gid)
	case database.OrderStatusPaid:
		return NewAppError(CodeOrderProcessing, "支付结果正在写入最终账本，请稍后查询", nil, "uid", uid, "gid", gid)
	default:
		return NewAppError(CodeOrderStateConflict, "未知订单状态", nil, "uid", uid, "gid", gid, "status", admission.State)
	}
}

// GiveUp 主动执行 pending_payment/stock_acquired -> cancelled。
func (s *OrderService) GiveUp(uid int, gid int, identities ...database.OrderIdentity) *AppError {
	defer database.BeginSeckillOperation()()
	identity := requestIdentity(identities)

	released, appErr := s.cancel(uid, gid, "user_giveup", time.Now(), identity)
	if appErr != nil {
		return appErr
	}
	if released {
		metrics.RecordGiveUp(gid)
	}
	slog.Info("order cancelled by user", "uid", uid, "gid", gid, "inventory_released", released)
	return nil
}

// TimeoutCancel 是延迟消息回调。paid/cancelled 视为已处理；系统错误返回给 MQ 触发重试。
func (s *OrderService) TimeoutCancel(command database.Order) (bool, error) {
	defer database.BeginSeckillOperation()()
	identity := command.Identity()
	// 历史 MySQL 订单没有 Redis 资格；只允许消息指向同一笔旧账本。
	// 旧表 datetime 会舍入到秒，截止时间核对需容忍不足一秒的存储精度差。
	legacyMySQL := false
	if identity.OrderID == "" && identity.RunID == "" {
		order, err := s.store.FindOrderIdentity(database.DefaultActivityID, command.UserId, identity)
		if err != nil && !errors.Is(err, database.ErrOrderNotFound) {
			return false, err
		}
		legacyMySQL = err == nil && order.InventoryMode == database.InventoryModeMySQL &&
			order.GiftId == command.GiftId && !command.ExpiresAt.IsZero() &&
			order.ExpiresAt.Sub(command.ExpiresAt).Abs() < time.Second && (command.Id == 0 || command.Id == order.Id)
	}
	admission, err := database.GetLotteryAdmission(command.UserId)
	if err != nil && !legacyMySQL {
		return false, err
	}
	// 无账本的 stock_acquired 也能取消，但必须先匹配同一次资格，不能用用户 ID 找新订单。
	if !legacyMySQL && !admission.Matches(command.GiftId, identity) {
		metrics.RecordIgnoredOrderMessage()
		slog.Info("stale cancel order ignored", "uid", command.UserId, "order_id", identity.OrderID, "run_id", identity.RunID)
		return false, nil
	}
	if identity.OrderID != "" {
		runID, runErr := database.CurrentSeckillRun()
		if runErr != nil {
			return false, runErr
		}
		if runID != identity.RunID {
			metrics.RecordIgnoredOrderMessage()
			return false, nil
		}
	}

	expiresAt := command.ExpiresAt
	if expiresAt.IsZero() {
		expiresAt = time.Now()
	}
	if time.Now().Before(expiresAt) {
		return false, fmt.Errorf("order is not expired until %s", expiresAt.Format(time.RFC3339Nano))
	}
	released, appErr := s.cancel(command.UserId, command.GiftId, "payment_timeout", expiresAt, identity)
	if appErr == nil {
		return released, nil
	}
	if appErr.Code == CodeOrderAlreadyPaid || appErr.Code == CodeOrderCancelled || appErr.Code == CodeOrderNotOwned {
		return false, nil
	}
	return false, appErr
}

func (s *OrderService) cancel(uid, gid int, reason string, expiresAt time.Time, identity database.OrderIdentity) (bool, *AppError) {
	order, err := s.store.FindOrderIdentity(database.DefaultActivityID, uid, identity)
	if err == nil && order.GiftId != gid {
		return false, NewAppError(CodeOrderNotOwned, "订单与商品不匹配", nil, "uid", uid, "gid", gid, "order_id", order.Id)
	}
	if err != nil && !errors.Is(err, database.ErrOrderNotFound) {
		return false, NewAppError(CodeGiveUpRollbackFailed, "读取订单状态失败", err, "uid", uid, "gid", gid)
	}

	if order != nil && order.InventoryMode == database.InventoryModeMySQL {
		updated, transitioned, cancelErr := s.store.CancelMySQLOrderAndRestoreStock(order.Id, reason)
		if cancelErr != nil {
			return false, NewAppError(CodeGiveUpRollbackFailed, "取消订单并回补库存失败", cancelErr, "uid", uid, "gid", gid, "order_id", order.Id)
		}
		switch updated.Status {
		case database.OrderStatusPaid:
			return false, NewAppError(CodeOrderAlreadyPaid, "订单已经支付，不能取消", nil, "uid", uid, "gid", gid, "order_id", order.Id)
		case database.OrderStatusCancelled:
			return transitioned, nil
		default:
			return false, NewAppError(CodeOrderStateConflict, "订单未能进入取消状态", nil, "uid", uid, "gid", gid, "status", updated.Status)
		}
	}

	// Redis 模式必须先由 Lua 裁决支付/取消并只回补一次，再把结果写入 MySQL 账本。
	released, releaseErr := database.ReleaseLotteryAdmission(uid, gid, identity)
	if releaseErr != nil {
		metrics.RecordSystemError("Redis 订单取消失败", releaseErr)
		return false, NewAppError(CodeGiveUpRollbackFailed, "取消订单并回补库存失败", releaseErr, "uid", uid, "gid", gid)
	}
	admission, getErr := database.GetLotteryAdmission(uid)
	if getErr != nil {
		return false, NewAppError(CodeGiveUpRollbackFailed, "读取取消结果失败", getErr, "uid", uid, "gid", gid)
	}
	if !admission.Matches(gid, identity) {
		if order != nil && order.Status == database.OrderStatusCancelled && order.StockReleased {
			return false, nil
		}
		if order != nil && order.Status == database.OrderStatusPaid {
			return false, NewAppError(CodeOrderAlreadyPaid, "订单已经支付，不能取消", nil, "uid", uid, "gid", gid)
		}
		if order != nil {
			return false, NewAppError(CodeOrderStateConflict, "Redis 订单状态丢失，需要对账", nil, "uid", uid, "gid", gid, "order_id", order.Id, "status", order.Status)
		}
		return false, NewAppError(CodeOrderNotOwned, "您没有该商品的有效订单", nil, "uid", uid, "gid", gid)
	}
	if admission.State == database.OrderStatusPaid {
		return false, NewAppError(CodeOrderAlreadyPaid, "订单已经支付，不能取消", nil, "uid", uid, "gid", gid)
	}
	if admission.State != database.OrderStatusCancelled {
		return false, NewAppError(CodeOrderStateConflict, "订单取消状态冲突", nil, "uid", uid, "gid", gid, "status", admission.State)
	}
	if _, _, recordErr := s.store.RecordReleasedRedisCancellation(database.DefaultActivityID, uid, gid, expiresAt, reason, identity); recordErr != nil {
		return false, NewAppError(CodeGiveUpRollbackFailed, "取消结果写入订单账本失败", recordErr, "uid", uid, "gid", gid)
	}
	if released {
		metrics.RecordInventoryRollback(gid, reason)
	}
	return released, nil
}

// Status 返回两个模式统一的订单状态。
// Redis 模式在异步落账窗口优先返回 admission 状态，MySQL 账本建立后仍保持相同枚举。
func (s *OrderService) Status(uid, gid int, identities ...database.OrderIdentity) (*OrderStateView, *AppError) {
	defer database.BeginSeckillOperation()()
	identity := requestIdentity(identities)

	order, err := s.store.FindOrderIdentity(database.DefaultActivityID, uid, identity)
	if err != nil && !errors.Is(err, database.ErrOrderNotFound) {
		return nil, NewAppError(CodeOrderCreateFailed, "读取订单状态失败", err, "uid", uid, "gid", gid)
	}
	if order != nil && order.GiftId != gid {
		return nil, NewAppError(CodeOrderNotOwned, "订单与商品不匹配", nil, "uid", uid, "gid", gid)
	}
	if order != nil && (order.Status == database.OrderStatusPaid || order.Status == database.OrderStatusCancelled) {
		return &OrderStateView{
			BusinessOrderID: order.OrderID, RunID: order.RunID, OrderID: order.Id, UID: uid, GiftID: gid, Status: order.Status,
			InventoryMode: order.InventoryMode, ExpiresAt: order.ExpiresAt,
		}, nil
	}

	admission, admissionErr := database.GetLotteryAdmission(uid)
	if admissionErr != nil && (order == nil || order.InventoryMode == database.InventoryModeRedis) {
		return nil, NewAppError(CodeAdmissionFailed, "读取订单处理状态失败", admissionErr, "uid", uid, "gid", gid)
	}
	if admission.Matches(gid, identity) && (order == nil || order.InventoryMode == database.InventoryModeRedis) {
		view := &OrderStateView{BusinessOrderID: admission.OrderID, RunID: admission.RunID, UID: uid, GiftID: gid, Status: admission.State, InventoryMode: database.InventoryModeRedis}
		if order != nil {
			view.OrderID = order.Id
			view.ExpiresAt = order.ExpiresAt
		}
		return view, nil
	}
	if order == nil {
		return nil, NewAppError(CodeOrderNotOwned, "订单不存在", nil, "uid", uid, "gid", gid)
	}
	return &OrderStateView{
		BusinessOrderID: order.OrderID, RunID: order.RunID, OrderID: order.Id, UID: uid, GiftID: gid, Status: order.Status,
		InventoryMode: order.InventoryMode, ExpiresAt: order.ExpiresAt,
	}, nil
}

// requestIdentity 的空值只供旧账本兼容，Redis Lua 会拒绝用空值操作新资格。
func requestIdentity(identities []database.OrderIdentity) database.OrderIdentity {
	if len(identities) == 0 {
		return database.OrderIdentity{}
	}
	return identities[0]
}
