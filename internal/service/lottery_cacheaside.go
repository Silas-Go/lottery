package service

import (
	"errors"
	"fmt"
	"log/slog"
	"silas/internal/database"
	"silas/internal/metrics"
	"silas/internal/util"
)

// CacheAsideLotteryService 用旁路缓存（Cache-Aside）模式编排抽奖主链路。
//
// 它和预扣模式的 LotteryService 是"同场景对决"的两条实现：
//   - 预扣模式：Redis 是库存权威源，Lua 原子扣减，MQ 补偿，MySQL 异步落库——快。
//   - Cache-Aside：MySQL.cache_stock 是权威源，Redis 只做读缓存；扣减走 MySQL 行锁
//     原子操作（绝不超卖），抽中后直接写正式订单——强一致、慢，DB 是瓶颈。
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

// Draw 以 Cache-Aside 模式执行一次抽奖。
//
// 流程：
//  1. 熔断器入口判断，过载时 fail-fast 拒绝，保护 MySQL
//  2. 查 MySQL 正式订单防止重复参与
//  3. Cache-Aside 读全部奖品库存（缓存命中直接用，未命中回源 MySQL 回填）
//  4. 按库存权重选候选奖品
//  5. MySQL 行锁原子扣减（WHERE cache_stock>0，绝不超卖）
//  6. 扣减成功后直接写 MySQL 正式订单（失败则回补库存）
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

		ok, deductStat, err := s.store.DeductGiftStockCacheAside(giftID)
		s.reportPressure(deductStat)
		if err != nil {
			metrics.RecordSystemError("Cache-Aside 扣减库存失败", err)
			return nil, NewAppError(CodeAdmissionFailed, "扣减库存失败，请稍后重试", err, "uid", uid, "gid", giftID, "try", try)
		}
		if !ok {
			// 该奖品已售罄（MySQL 行锁判定，不超卖），重试抽取其他奖品。
			slog.Warn("cache-aside gift sold out, retrying", "uid", uid, "gid", giftID, "try", try)
			continue
		}

		gift, err := s.store.GetGiftWithError(giftID)
		if err != nil {
			s.restore(giftID, "gift lookup failed")
			metrics.RecordSystemError("Cache-Aside 查询奖品详情失败", err)
			return nil, NewAppError(CodeGiftLookupFailed, "查询中奖奖品详情失败", err, "uid", uid, "gid", giftID, "try", try)
		}

		// Cache-Aside 是纯 DB 强一致路径：扣减成功后直接写正式订单，不走临时资格和 MQ 补偿。
		_, duplicated, err := s.store.CreateOrder(database.DefaultActivityID, uid, giftID)
		if err != nil {
			s.restore(giftID, "order create failed")
			metrics.RecordSystemError("Cache-Aside 创建订单失败", err)
			return nil, NewAppError(CodeOrderCreateFailed, "抱歉，系统出错，请联系客服", err, "uid", uid, "gid", giftID)
		}
		if duplicated {
			// 唯一索引兜底命中，回补本次已扣的库存。
			s.restore(giftID, "duplicate order")
			return nil, NewAppError(CodeDuplicateParticipation, "请勿重复参与秒杀", nil, "uid", uid, "gid", giftID, "activity_id", database.DefaultActivityID)
		}

		metrics.RecordCacheAsideCompleted(giftID)
		slog.Info("cache-aside request success", "uid", uid, "gid", giftID, "gift", gift.Name, "try", try)
		return &LotteryResult{
			UID:      uid,
			GiftID:   giftID,
			GiftName: gift.Name,
			Price:    gift.Price,
			Delay:    PayDelaySeconds,
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

func (s *CacheAsideLotteryService) restore(giftID int, reason string) {
	if err := s.store.RestoreGiftStockCacheAside(giftID); err != nil {
		slog.Error("cache-aside restore stock failed", "gid", giftID, "reason", reason, "error", err)
		return
	}
	slog.Info("cache-aside stock restored", "gid", giftID, "reason", reason)
}

func poolUsagePercent(inUse, capacity int) int {
	if capacity <= 0 {
		return 0
	}
	return inUse * 100 / capacity
}
