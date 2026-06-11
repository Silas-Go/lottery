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

const PayDelaySeconds = 600

type LotteryService struct {
	store   *database.Store
	limiter *tokenBucketLimiter
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
		limiter: newTokenBucketLimiter(opts.RateLimitQPS),
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
		status, err := database.TryAcquireLotteryAdmission(uid, giftID, time.Duration(PayDelaySeconds)*time.Second)
		switch status {
		case database.AdmissionAcquired:
			metrics.RecordRedisPreDeduct(giftID)
		case database.AdmissionDuplicate:
			metrics.RecordStockFailed("用户重复参与")
			return nil, NewAppError(CodeDuplicateParticipation, "请勿重复参与秒杀", err, "uid", uid, "gid", giftID, "try", try)
		case database.AdmissionSoldOut:
			slog.Warn("admission sold out, retrying lottery", "uid", uid, "gid", giftID, "try", try)
			continue
		default:
			metrics.RecordSystemError("Redis 原子准入失败", err)
			return nil, NewAppError(CodeAdmissionFailed, "秒杀准入失败，请稍后重试", err, "uid", uid, "gid", giftID, "try", try)
		}

		gift, err := s.store.GetGiftWithError(giftID)
		if err != nil {
			rollbackAdmission(uid, giftID, "gift lookup failed")
			metrics.RecordSystemError("查询中奖奖品详情失败", err)
			return nil, NewAppError(CodeGiftLookupFailed, "查询中奖奖品详情失败", err, "uid", uid, "gid", giftID, "try", try)
		}

		if err := mq.SendCancelOrder(database.Order{UserId: uid, GiftId: giftID}, PayDelaySeconds); err != nil {
			rollbackAdmission(uid, giftID, "rocketmq send failed")
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

func rollbackAdmission(uid int, giftID int, reason string) {
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
