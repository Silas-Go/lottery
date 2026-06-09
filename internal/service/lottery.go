package service

import (
	"errors"
	"fmt"
	"log/slog"
	"silas/internal/database"
	"silas/internal/metrics"
	"silas/internal/mq"
	"silas/internal/util"
)

const PayDelaySeconds = 600

type LotteryService struct {
	store   *database.Store
	limiter *fixedWindowLimiter
}

type LotteryOptions struct {
	RateLimitQPS int
}

type LotteryResult struct {
	UID      int
	GiftID   int
	GiftName string
	Price    int
	Delay    int
}

func NewLotteryService(store *database.Store, opts LotteryOptions) *LotteryService {
	return &LotteryService{
		store:   store,
		limiter: newFixedWindowLimiter(opts.RateLimitQPS),
	}
}

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
	return gifts, nil
}

func (s *LotteryService) Draw(uid int) (*LotteryResult, *AppError) {
	if !s.limiter.Allow() {
		metrics.RecordRateLimited()
		return nil, NewAppError(CodeRateLimited, "请求过多，请稍后重试", nil, "uid", uid)
	}

	slog.Info("lottery request start", "uid", uid)

	for try := 1; try <= 10; try++ {
		gifts, err := database.GetAllGiftInventoryWithError()
		if err != nil {
			metrics.RecordSystemError("读取 Redis 库存失败", err)
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
			metrics.RecordStockFailed("Redis 可用库存为空")
			slog.Info("lottery request finished with no inventory", "uid", uid)
			return &LotteryResult{UID: uid, GiftID: 0}, nil
		}

		index := util.Lottery(probs)
		if index < 0 || index >= len(ids) {
			err := fmt.Errorf("lottery index %d out of range, candidates=%d", index, len(ids))
			metrics.RecordSystemError("抽奖算法返回非法结果", err)
			return nil, NewAppError(CodeLotteryAlgoFailed, "抽奖算法返回非法结果", err, "uid", uid, "try", try)
		}

		giftID := ids[index]
		if err := database.ReduceInventory(giftID); err != nil {
			slog.Warn("reduce inventory failed, retrying lottery", "uid", uid, "gid", giftID, "try", try, "error", err)
			continue
		}
		metrics.RecordRedisPreDeduct(giftID)

		gift, err := s.store.GetGiftWithError(giftID)
		if err != nil {
			rollbackInventory(giftID, "gift lookup failed")
			metrics.RecordSystemError("查询中奖奖品详情失败", err)
			return nil, NewAppError(CodeGiftLookupFailed, "查询中奖奖品详情失败", err, "uid", uid, "gid", giftID, "try", try)
		}

		if err := database.CreateTempOrder(uid, giftID); err != nil {
			rollbackInventory(giftID, "temp order create failed")
			metrics.RecordSystemError("创建临时订单失败", err)
			return nil, NewAppError(CodeTempOrderCreateFailed, "创建临时订单失败", err, "uid", uid, "gid", giftID, "try", try)
		}

		if err := mq.SendCancelOrder(database.Order{UserId: uid, GiftId: giftID}, PayDelaySeconds); err != nil {
			if n := database.DeleteTempOrder(uid, giftID); n < 0 {
				slog.Error("rollback temp order failed", "uid", uid, "gid", giftID)
			}
			rollbackInventory(giftID, "rocketmq send failed")
			metrics.RecordSystemError("发送延时取消订单消息失败", err)
			return nil, NewAppError(CodeMQSendFailed, "发送延时取消订单消息失败", err, "uid", uid, "gid", giftID, "try", try)
		}
		metrics.RecordQueueSuccess(giftID)

		slog.Info("lottery request success", "uid", uid, "gid", giftID, "gift", gift.Name, "try", try)
		return &LotteryResult{
			UID:      uid,
			GiftID:   giftID,
			GiftName: gift.Name,
			Price:    gift.Price,
			Delay:    PayDelaySeconds,
		}, nil
	}

	metrics.RecordStockFailed("库存扣减冲突重试耗尽")
	return nil, NewAppError(CodeInventoryRetryExhaust, "库存扣减冲突，请稍后重试", errors.New("reduce inventory failed after 10 attempts"), "uid", uid)
}

func rollbackInventory(giftID int, reason string) {
	if err := database.IncreaseInventory(giftID); err != nil {
		slog.Error("rollback inventory failed", "gid", giftID, "reason", reason, "error", err)
		return
	}
	metrics.RecordInventoryRollback(giftID, reason)
	slog.Info("rollback inventory success", "gid", giftID, "reason", reason)
}
