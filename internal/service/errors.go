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
)

type AppError struct {
	Code    string
	Message string
	Err     error
	Attrs   []any
}

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
