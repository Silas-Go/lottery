package service

import (
	"errors"
	"fmt"
	"log/slog"
	"silas/internal/database"
	"silas/internal/metrics"
	"silas/internal/mq"
	"silas/internal/util"
	"time"
)

// CacheAsideLotteryService 是历史命名，当前业务定位是“MySQL 权威库存同步准入”。
// Redis 聚合缓存只帮助选择候选奖品，不参与正确性；真正准入由 MySQL 事务完成库存扣减和
// pending_payment 订单创建，随后与 Redis 模式共用 paid/cancelled 生命周期。
//
// 入口不做令牌桶限流，而是接入压力感知熔断器：正常放行，DB 过载时 fail-fast 降级，
// 这样压测才能真实压出红灯，并演示系统在压力下的自我保护与自动恢复。
type CacheAsideLotteryService struct {
	store   *database.Store
	breaker *CircuitBreaker
}

// NewCacheAsideLotteryService 创建 Cache-Aside 抽奖服务并初始化熔断器。
func NewCacheAsideLotteryService(store *database.Store) *CacheAsideLotteryService {
	slog.Info("cache-aside lottery service initialized",
		"db_gate_capacity", database.CacheAsideGateCapacity())
	return &CacheAsideLotteryService{
		store:   store,
		breaker: newCircuitBreaker(),
	}
}

// ResetCircuitBreaker 清空 Cache-Aside 链路的熔断器内存状态。
// 实验室真重置会调用它，避免上一轮 Open/Half-Open 状态污染下一轮压测。
func (s *CacheAsideLotteryService) ResetCircuitBreaker() {
	if s == nil || s.breaker == nil {
		return
	}
	s.breaker.Reset()
}

// Draw 以 Cache-Aside 模式执行一次抽奖。
//
// 流程：
//  1. 熔断器入口判断，过载时 fail-fast 拒绝，保护 MySQL
//  2. 查 MySQL 正式订单防止重复参与
//  3. Cache-Aside 读全部奖品库存（缓存命中直接用，未命中回源 MySQL 回填）
//  4. 按库存权重选候选奖品
//  5. MySQL 事务原子完成条件扣减和 pending_payment 订单创建
//  6. 发送统一的支付超时取消消息
func (s *CacheAsideLotteryService) Draw(uid int) (*LotteryResult, *AppError) {
	metrics.RecordCacheAsideRequest()

	if !s.breaker.Allow() {
		metrics.RecordCacheAsideRejected()
		slog.Warn("cache-aside request rejected by circuit breaker", "uid", uid)
		return nil, NewAppError(CodeCacheAsideOverload, "系统繁忙，已触发过载保护，请稍后重试", nil, "uid", uid)
	}

	ordered, err := s.store.HasOrder(database.DefaultActivityID, uid)
	if err != nil {
		metrics.RecordSystemError("Cache-Aside 查询用户订单失败", err)
		return nil, NewAppError(CodeGiftDBReadFailed, "查询用户参与记录失败", err, "uid", uid, "activity_id", database.DefaultActivityID)
	}
	if ordered {
		slog.Warn("cache-aside request rejected, user already has order", "uid", uid)
		return nil, NewAppError(CodeDuplicateParticipation, "请勿重复参与秒杀", nil, "uid", uid, "activity_id", database.DefaultActivityID)
	}

	for try := 1; try <= 10; try++ {
		gifts, readStat, err := s.store.GetAllGiftStockCacheAside()
		s.reportPressure(readStat)
		if err != nil {
			metrics.RecordSystemError("Cache-Aside 读取库存失败", err)
			return nil, NewAppError(CodeRedisInventoryReadFail, "读取奖品库存失败", err, "uid", uid, "try", try)
		}

		ids := make([]int, 0, len(gifts))
		probs := make([]float64, 0, len(gifts))
		for _, gift := range gifts {
			if gift.Count > 0 {
				ids = append(ids, gift.Id)
				probs = append(probs, float64(gift.Count))
			}
		}
		if len(ids) == 0 {
			metrics.RecordCacheAsideSoldOut()
			slog.Info("cache-aside request finished with no inventory", "uid", uid)
			return &LotteryResult{UID: uid, GiftID: 0}, nil
		}

		index := util.Lottery(probs)
		if index < 0 || index >= len(ids) {
			algoErr := fmt.Errorf("cache-aside lottery index %d out of range, candidates=%d", index, len(ids))
			metrics.RecordSystemError("Cache-Aside 抽奖算法返回非法结果", algoErr)
			return nil, NewAppError(CodeLotteryAlgoFailed, "抽奖算法返回非法结果", algoErr, "uid", uid, "try", try)
		}
		giftID := ids[index]

		expiresAt := time.Now().Add(time.Duration(PayDelaySeconds) * time.Second)
		order, soldOut, duplicated, deductStat, err := s.store.AcquireMySQLStockAndCreatePendingOrder(
			database.DefaultActivityID, uid, giftID, expiresAt,
		)
		s.reportPressure(deductStat)
		if err != nil {
			metrics.RecordSystemError("MySQL 库存准入和订单创建失败", err)
			return nil, NewAppError(CodeAdmissionFailed, "创建待支付订单失败，请稍后重试", err, "uid", uid, "gid", giftID, "try", try)
		}
		if duplicated {
			return nil, NewAppError(CodeDuplicateParticipation, "请勿重复参与秒杀", nil, "uid", uid, "gid", giftID, "activity_id", database.DefaultActivityID)
		}
		if soldOut {
			// 该奖品已售罄（MySQL 行锁判定，不超卖），重试抽取其他奖品。
			slog.Warn("cache-aside gift sold out, retrying", "uid", uid, "gid", giftID, "try", try)
			continue
		}

		gift, err := s.store.GetGiftWithError(giftID)
		if err != nil {
			_, _, _ = s.store.CancelMySQLOrderAndRestoreStock(order.Id, "gift_lookup_failed")
			metrics.RecordSystemError("Cache-Aside 查询奖品详情失败", err)
			return nil, NewAppError(CodeGiftLookupFailed, "查询中奖奖品详情失败", err, "uid", uid, "gid", giftID, "try", try)
		}

		if err := mq.SendCancelOrder(*order, PayDelaySeconds); err != nil {
			_, _, cancelErr := s.store.CancelMySQLOrderAndRestoreStock(order.Id, "timeout_message_send_failed")
			if cancelErr != nil {
				slog.Error("mysql order rollback after mq failure failed", "order_id", order.Id, "error", cancelErr)
			}
			metrics.RecordSystemError("发送订单超时取消消息失败", err)
			return nil, NewAppError(CodeMQSendFailed, "创建超时任务失败，请稍后重试", err, "uid", uid, "gid", giftID, "order_id", order.Id)
		}

		metrics.RecordCacheAsideCompleted(giftID)
		slog.Info("mysql order entered pending_payment", "order_id", order.Id, "uid", uid, "gid", giftID, "gift", gift.Name, "try", try)
		return &LotteryResult{
			UID:           uid,
			GiftID:        giftID,
			GiftName:      gift.Name,
			Price:         gift.Price,
			Delay:         PayDelaySeconds,
			Status:        database.OrderStatusPendingPayment,
			InventoryMode: database.InventoryModeMySQL,
		}, nil
	}

	metrics.RecordCacheAsideSoldOut()
	slog.Warn("cache-aside retry exhausted", "uid", uid, "max_try", 10)
	return nil, NewAppError(CodeInventoryRetryExhaust, "库存扣减冲突，请稍后重试", errors.New("cache-aside reduce inventory failed after 10 attempts"), "uid", uid)
}

// reportPressure 把一次 Cache-Aside 数据访问的耗时和缓存命中情况上报指标，并驱动熔断器。
// 只有真正打了 DB 的操作（HitDB）才计入连接池压力和熔断判断；缓存命中的读不算 DB 压力。
func (s *CacheAsideLotteryService) reportPressure(stat database.CacheAsideStat) {
	if stat.CacheHit {
		metrics.RecordCacheHit()
	} else if stat.HitDB && stat.Operation == database.CacheAsideDBOperationRead {
		metrics.RecordCacheMiss()
	}
	if stat.HitDB {
		switch stat.Operation {
		case database.CacheAsideDBOperationRead:
			metrics.RecordCacheAsideDBRead()
		case database.CacheAsideDBOperationWrite:
			metrics.RecordCacheAsideDBWrite()
		}
		latency := stat.WaitMs + stat.DBMs
		metrics.RecordCacheAsideDBLatency(latency)
		metrics.SetCacheAsidePool(stat.PoolInUse, stat.PoolCapacity)
		s.breaker.Report(latency, poolUsagePercent(stat.PoolInUse, stat.PoolCapacity))
	}
}

func poolUsagePercent(inUse, capacity int) int {
	if capacity <= 0 {
		return 0
	}
	return inUse * 100 / capacity
}
