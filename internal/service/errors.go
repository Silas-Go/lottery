package service

import "fmt"

const (
	CodeGiftDBReadFailed       = "GIFT_DB_READ_FAILED"
	CodeNoGiftsConfigured      = "NO_GIFTS_CONFIGURED"
	CodeRateLimited            = "SECKILL_RATE_LIMITED"
	CodeDuplicateParticipation = "DUPLICATE_PARTICIPATION"
	CodeAdmissionFailed        = "ADMISSION_FAILED"
	CodeRedisInventoryReadFail = "REDIS_INVENTORY_READ_FAILED"
	CodeLotteryAlgoFailed      = "LOTTERY_ALGO_FAILED"
	CodeGiftLookupFailed       = "GIFT_LOOKUP_FAILED"
	CodeTempOrderCreateFailed  = "TEMP_ORDER_CREATE_FAILED"
	CodeMQSendFailed           = "MQ_SEND_FAILED"
	CodeInventoryRetryExhaust  = "INVENTORY_RETRY_EXHAUSTED"
	CodeOrderNotOwned          = "ORDER_NOT_OWNED"
	CodeOrderCreateFailed      = "ORDER_CREATE_FAILED"
	CodeGiveUpRollbackFailed   = "GIVEUP_ROLLBACK_FAILED"
	CodeCacheAsideOverload     = "CACHE_ASIDE_OVERLOAD"
)

// AppError 表示 service 层返回给 handler 的业务错误。
// 它把“给用户看的中文 message”和“给日志排查的原始 err/attrs”分开，
// 避免 handler 自己猜测业务失败原因。
type AppError struct {
	// Code 是稳定的业务错误码，handler 会把它映射成 HTTP 状态码和 X-Error-Code。
	Code string

	// Message 是可以直接返回给前端或用户看的中文提示。
	Message string

	// Err 是底层原始错误，例如 Redis/MQ/MySQL 错误；为空表示纯业务拒绝。
	Err error

	// Attrs 是结构化日志字段，通常包含 uid、gid、try、activity_id 等定位信息。
	Attrs []any
}

// NewAppError 创建 service 层业务错误。
// attrs 使用 slog 的 key-value 形式，例如 "uid", uid, "gid", giftID，
// handler 会把这些字段写入错误日志，帮助串起一次请求的上下文。
func NewAppError(code string, message string, err error, attrs ...any) *AppError {
	return &AppError{
		Code:    code,
		Message: message,
		Err:     err,
		Attrs:   attrs,
	}
}

func (e *AppError) Error() string {
	if e == nil {
		return ""
	}
	if e.Err != nil {
		return fmt.Sprintf("%s: %v", e.Code, e.Err)
	}
	return e.Code
}
