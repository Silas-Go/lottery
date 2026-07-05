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

const (
	// PayDelaySeconds 是用户拿到临时资格后的支付窗口，单位秒。
	// 这个值会同时用于 cookie 过期时间和 RocketMQ 延时取消消息；超过窗口未支付就释放资格并回补库存。
	PayDelaySeconds = 600
)

// LotteryService 编排抽奖主链路。
// 业务规则集中放在 service 层，是为了让 handler 只处理 HTTP 入参/出参，
// Redis、MQ、MySQL 的协作关系也不会散落到路由或页面逻辑里。
type LotteryService struct {
	store   *database.Store
	limiter *tokenBucketLimiter
}

// LotteryOptions 定义抽奖服务启动时的可调参数。
// 当前只暴露 QPS 限流配置，避免压测时把本机依赖打爆后误判为业务逻辑错误。
type LotteryOptions struct {
	// RateLimitQPS 表示本进程允许进入秒杀链路的每秒请求数。
	// QPS 是 Queries Per Second 的缩写；0 表示关闭本地限流。
	RateLimitQPS int
}

// LotteryResult 表示一次抽奖成功后需要返回给前端的临时资格信息。
// 这里返回的是“待支付资格”，不是最终订单；最终结果以支付后写入 MySQL 为准。
type LotteryResult struct {
	// UID 是 user id，用户 ID；前端支付时会把它带回 /pay。
	UID int

	// GiftID 是 gift id，奖品 ID；前端支付和放弃时会把它带回服务端校验资格。
	GiftID int

	// GiftName 是奖品名称，只用于页面展示，不参与并发控制。
	GiftName string

	// Price 是奖品价值，只用于页面展示。
	Price int

	// Delay 是支付窗口秒数，用来设置 cookie 过期时间和页面倒计时。
	Delay int
}

// NewLotteryService 创建抽奖服务并初始化入口限流器。
// 限流放在业务入口处，是为了保护 Redis Lua 准入和 MQ 入队链路，
// 否则压测流量可能把依赖打满，导致演示结果变成基础设施故障。
func NewLotteryService(store *database.Store, opts LotteryOptions) *LotteryService {
	slog.Info("lottery service initialized", "rate_limit_qps", opts.RateLimitQPS)
	return &LotteryService{
		store:   store,
		limiter: newTokenBucketLimiter(opts.RateLimitQPS),
	}
}

// ListGifts 读取奖品列表供转盘展示。
// 转盘只需要展示奖品配置，不代表真实库存；真实可抢库存以 Redis 中的预扣库存为准。
func (s *LotteryService) ListGifts() ([]*database.Gift, *AppError) {
	gifts, err := s.store.GetAllGiftsWithError()
	if err != nil {
		return nil, NewAppError(CodeGiftDBReadFailed, "读取奖品列表失败", err)
	}
	if len(gifts) == 0 {
		return nil, NewAppError(CodeNoGiftsConfigured, "奖品列表为空，请先初始化数据库", nil)
	}

	for _, gift := range gifts {
		gift.Count = 1
	}
	slog.Info("gift list loaded for wheel", "count", len(gifts))
	return gifts, nil
}

// Draw 执行一次抽奖和临时资格发放。
//
// 抽奖流程：
//
// 1. 入口限流，保护本机演示环境
// 2. 查询 MySQL 正式订单，阻止已完成订单的用户再次预扣库存
// 3. 从 Redis 读取当前可用库存作为权重
// 4. 按库存权重选出候选奖品
// 5. 通过 Redis Lua 原子完成防重复、扣库存、写临时资格
// 6. 读取 MySQL 奖品详情用于页面展示
// 7. 发送 RocketMQ 延时消息，作为支付超时后的库存补偿
//
// 参数语义:
//
//	uid 是 user id，用户 ID，用来做重复参与判断和 Redis 临时资格 key。
//
// 注意这里创建的是 admission，即“临时抢购资格”，不是最终订单；用户必须在支付接口中 claim 资格后，
// 才会写入 MySQL 正式订单。Redis Lua 只保证 Redis 内部原子性，不保证 MQ 发送和 MySQL 落库一定成功。
func (s *LotteryService) Draw(uid int) (*LotteryResult, *AppError) {
	if !s.limiter.Allow() {
		metrics.RecordRateLimited()
		slog.Warn("lottery request rate limited", "uid", uid)
		return nil, NewAppError(CodeRateLimited, "请求过多，请稍后重试", nil, "uid", uid)
	}

	slog.Info("lottery request start", "uid", uid)
	dbStart := time.Now()
	ordered, err := s.store.HasOrder(database.DefaultActivityID, uid)
	s.recordMySQLPressure(dbStart)
	if err != nil {
		metrics.RecordSystemError("查询用户活动订单失败", err)
		return nil, NewAppError(CodeGiftDBReadFailed, "查询用户参与记录失败", err, "uid", uid, "activity_id", database.DefaultActivityID)
	}
	if ordered {
		metrics.RecordStockFailed("用户已完成订单")
		slog.Warn("lottery request rejected, user already has order", "uid", uid, "activity_id", database.DefaultActivityID)
		return nil, NewAppError(CodeDuplicateParticipation, "请勿重复参与秒杀", nil, "uid", uid, "activity_id", database.DefaultActivityID)
	}

	for try := 1; try <= 10; try++ {
		gifts, err := database.GetAllGiftInventoryWithError()
		if err != nil {
			metrics.RecordSystemError("读取 Redis 库存失败", err)
			return nil, NewAppError(CodeRedisInventoryReadFail, "读取奖品库存失败", err, "uid", uid, "try", try)
		}

		// 从当前库存快照中筛选有剩余库存的候选奖品 ID 及对应权重。
		ids := make([]int, 0, len(gifts))
		probs := make([]float64, 0, len(gifts))
		for _, gift := range gifts {
			if gift.Count > 0 {
				ids = append(ids, gift.Id)
				probs = append(probs, float64(gift.Count))
			}
		}
		if len(ids) == 0 {
			metrics.RecordStockFailed("Redis 可用库存为空")
			slog.Info("lottery request finished with no inventory", "uid", uid)
			return &LotteryResult{UID: uid, GiftID: 0}, nil
		}

		// 内层候选池：一次 Redis 库存快照可支撑多次准入尝试。
		// 避免每遇到一个 SOLD_OUT 就重新读 Redis，减少 /lucky 热路径往返次数。
		for attempt := 1; len(ids) > 0; attempt++ {
			index := util.Lottery(probs)
			if index < 0 || index >= len(ids) {
				err := fmt.Errorf("lottery index %d out of range, candidates=%d", index, len(ids))
				metrics.RecordSystemError("抽奖算法返回非法结果", err)
				return nil, NewAppError(CodeLotteryAlgoFailed, "抽奖算法返回非法结果", err, "uid", uid, "try", try, "attempt", attempt)
			}

			giftID := ids[index]
			slog.Info("lottery candidate selected", "uid", uid, "gid", giftID, "try", try, "attempt", attempt, "candidate_count", len(ids))
			// 权重抽奖只决定候选奖品，真正的并发边界在 Redis Lua。
			// 如果不把防重复、扣库存、写临时资格绑在同一个脚本里，
			// 高并发下就可能出现重复参与或库存检查通过后被其他请求抢先扣光。
			status, err := database.TryAcquireLotteryAdmission(uid, giftID, time.Duration(PayDelaySeconds)*time.Second)
			switch status {
			case database.AdmissionAcquired:
				metrics.RecordRedisPreDeduct(giftID)
				slog.Info("lottery admission acquired", "uid", uid, "gid", giftID, "try", try, "attempt", attempt, "ttl_seconds", PayDelaySeconds)
			case database.AdmissionDuplicate:
				metrics.RecordStockFailed("用户重复参与")
				slog.Warn("lottery admission duplicate", "uid", uid, "gid", giftID, "try", try, "attempt", attempt, "error", err)
				return nil, NewAppError(CodeDuplicateParticipation, "请勿重复参与秒杀", err, "uid", uid, "gid", giftID, "try", try)
			case database.AdmissionSoldOut:
				// 同一库存快照内有并发请求抢光了这个奖品。
				// 从本地候选池剔除该 giftID，用剩余奖品继续抽，无需立刻重读 Redis。
				slog.Warn("admission sold out, retrying with remaining candidates", "uid", uid, "gid", giftID, "try", try, "attempt", attempt)
				ids = append(ids[:index], ids[index+1:]...)
				probs = append(probs[:index], probs[index+1:]...)
				continue
			default:
				metrics.RecordSystemError("Redis 原子准入失败", err)
				return nil, NewAppError(CodeAdmissionFailed, "秒杀准入失败，请稍后重试", err, "uid", uid, "gid", giftID, "try", try, "attempt", attempt)
			}

			dbStart := time.Now()
			gift, err := s.store.GetGiftWithError(giftID)
			s.recordMySQLPressure(dbStart)
			if err != nil {
				rollbackAdmission(uid, giftID, "gift lookup failed")
				metrics.RecordSystemError("查询中奖奖品详情失败", err)
				return nil, NewAppError(CodeGiftLookupFailed, "查询中奖奖品详情失败", err, "uid", uid, "gid", giftID, "try", try, "attempt", attempt)
			}
			slog.Info("lottery gift detail loaded", "uid", uid, "gid", giftID, "gift", gift.Name, "price", gift.Price, "try", try, "attempt", attempt)

			if err := mq.SendCancelOrder(database.Order{UserId: uid, GiftId: giftID}, PayDelaySeconds); err != nil {
				// 用户不能在没有超时补偿消息的情况下持有库存。
				// 如果 MQ 入队失败，必须立即释放 Redis 临时资格，否则这份库存会被长期占用。
				rollbackAdmission(uid, giftID, "rocketmq send failed")
				metrics.RecordSystemError("发送延时取消订单消息失败", err)
				return nil, NewAppError(CodeMQSendFailed, "发送延时取消订单消息失败", err, "uid", uid, "gid", giftID, "try", try, "attempt", attempt)
			}
			metrics.RecordQueueSuccess(giftID)
			slog.Info("lottery cancel message queued", "uid", uid, "gid", giftID, "delay_seconds", PayDelaySeconds, "try", try, "attempt", attempt)

			slog.Info("lottery request success", "uid", uid, "gid", giftID, "gift", gift.Name, "try", try, "attempt", attempt)
			return &LotteryResult{
				UID:      uid,
				GiftID:   giftID,
				GiftName: gift.Name,
				Price:    gift.Price,
				Delay:    PayDelaySeconds,
			}, nil
		}
		// 内层候选池耗尽（当前快照里的奖品都被并发抢完），外层重新读 Redis 库存。
	}

	metrics.RecordStockFailed("库存扣减冲突重试耗尽")
	slog.Warn("lottery retry exhausted", "uid", uid, "max_try", 10)
	return nil, NewAppError(CodeInventoryRetryExhaust, "库存扣减冲突，请稍后重试", errors.New("reduce inventory failed after 10 attempts"), "uid", uid)
}

func (s *LotteryService) recordMySQLPressure(start time.Time) {
	inUse, capacity := s.store.DBPoolStats()
	metrics.RecordPreDeductMySQL(time.Since(start), inUse, capacity)
}

func rollbackAdmission(uid int, giftID int, reason string) {
	// rollback 在本项目里表示“失败兜底回滚临时资格”。
	// 回滚复用用户放弃和 MQ 超时的同一个 Lua release 释放路径。
	// 这样即使支付、超时补偿、失败回滚同时竞争同一份资格，也只有仍持有资格的一方能回补库存。
	released, err := database.ReleaseLotteryAdmission(uid, giftID)
	if err != nil {
		slog.Error("rollback admission failed", "uid", uid, "gid", giftID, "reason", reason, "error", err)
		return
	}
	if !released {
		slog.Warn("rollback admission skipped", "uid", uid, "gid", giftID, "reason", reason)
		return
	}
	metrics.RecordInventoryRollback(giftID, reason)
	slog.Info("rollback admission success", "uid", uid, "gid", giftID, "reason", reason)
}
