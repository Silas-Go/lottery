package mq

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"silas/internal/database"
	"silas/internal/metrics"
	"silas/internal/util"
	"sync"
	"time"

	rmq_client "github.com/apache/rocketmq-clients/golang/v5"
	"github.com/apache/rocketmq-clients/golang/v5/credentials"
	"github.com/bytedance/sonic"
)

const (
	defaultEndpoint                  = "localhost:8081"
	defaultCancelTopic               = "CANCEL_ORDER"
	defaultOrderTopic                = "CREATE_ORDER"
	defaultPurchaseInvalidationTopic = "PURCHASE_CACHE_INVALIDATE"
	defaultConsumerGroup             = "lottery"
)

var (
	simpleConsumer rmq_client.SimpleConsumer
	consumerMu     sync.Mutex
)

// CreateOrderHandler/TimeoutHandler 让 MQ 层只负责传输和 Ack，状态机仍由 service 层统一裁决。
type CreateOrderHandler func(database.Order) error
type TimeoutHandler func(database.Order) (bool, error)
type PurchaseInvalidationHandler func(database.PurchaseCacheInvalidation) error

func Enabled() bool {
	return util.EnvBool("LOTTERY_MQ_ENABLED", true)
}

func Endpoint() string {
	return util.EnvString("LOTTERY_MQ_ENDPOINT", defaultEndpoint)
}

// CancelTopic 是支付超时检查使用的延迟 Topic。
func CancelTopic() string {
	return util.EnvString("LOTTERY_MQ_CANCEL_TOPIC", util.EnvString("LOTTERY_MQ_TOPIC", defaultCancelTopic))
}

// OrderTopic 是 Redis 准入后异步创建 MySQL pending_payment 订单的普通 Topic。
func OrderTopic() string {
	return util.EnvString("LOTTERY_MQ_ORDER_TOPIC", defaultOrderTopic)
}

// PurchaseInvalidationTopic 是购买实验 Outbox 发布的材料 DTO 缓存失效 Topic。
func PurchaseInvalidationTopic() string {
	return util.EnvString("LOTTERY_MQ_PURCHASE_INVALIDATION_TOPIC", defaultPurchaseInvalidationTopic)
}

// Topic 保留旧配置/调用兼容，等价于 CancelTopic。
func Topic() string { return CancelTopic() }

func ConsumerGroup() string {
	return util.EnvString("LOTTERY_MQ_CONSUMER_GROUP", defaultConsumerGroup)
}

func InitRocketLog() {
	os.Setenv(rmq_client.CLIENT_LOG_ROOT, "./log")
	os.Setenv(rmq_client.CLIENT_LOG_FILENAME, "rocket_lottery.log")
	os.Setenv("rocketmq.client.logLevel", "warn")
	rmq_client.ResetLogger()
	slog.Info("rocketmq client log configured", "log_root", "./log", "log_file", "rocket_lottery.log")
}

// GetConsumer 创建同时订阅普通落单和延迟取消 Topic 的 SimpleConsumer。
func GetConsumer() (rmq_client.SimpleConsumer, error) {
	consumerMu.Lock()
	defer consumerMu.Unlock()
	if simpleConsumer != nil {
		return simpleConsumer, nil
	}

	endpoint := Endpoint()
	group := ConsumerGroup()
	subscriptions := map[string]*rmq_client.FilterExpression{
		OrderTopic():                rmq_client.SUB_ALL,
		CancelTopic():               rmq_client.SUB_ALL,
		PurchaseInvalidationTopic(): rmq_client.SUB_ALL,
	}
	consumer, err := rmq_client.NewSimpleConsumer(
		&rmq_client.Config{
			Endpoint:      endpoint,
			ConsumerGroup: group,
			Credentials:   &credentials.SessionCredentials{},
		},
		rmq_client.WithClientFuncForSimpleConsumer(newRocketClient),
		rmq_client.WithSimpleAwaitDuration(5*time.Second),
		rmq_client.WithSimpleSubscriptionExpressions(subscriptions),
	)
	if err != nil {
		return nil, fmt.Errorf("create rocketmq consumer: %w", err)
	}
	if err := consumer.Start(); err != nil {
		return nil, fmt.Errorf("start rocketmq consumer: %w", err)
	}
	simpleConsumer = consumer
	slog.Info("rocketmq consumer initialized", "endpoint", endpoint, "order_topic", OrderTopic(),
		"cancel_topic", CancelTopic(), "purchase_invalidation_topic", PurchaseInvalidationTopic(), "group", group)
	return simpleConsumer, nil
}

// ReceiveOrders 消费订单创建、超时取消和材料缓存失效三类消息。
// 业务处理或消息解析失败时不 Ack，让 MQ 重投；只有幂等业务处理成功后才确认消息。
func ReceiveOrders(createOrder CreateOrderHandler, timeout TimeoutHandler, invalidate PurchaseInvalidationHandler) {
	if !Enabled() {
		slog.Info("rocketmq consumer disabled")
		return
	}
	ctx := context.Background()
	for {
		consumer, err := GetConsumer()
		if err != nil {
			slog.Error("rocketmq consumer init failed, retrying", "endpoint", Endpoint(), "error", err)
			time.Sleep(5 * time.Second)
			continue
		}

		messages, err := consumer.Receive(ctx, 1, 10*time.Second)
		if err != nil {
			var rpcErr *rmq_client.ErrRpcStatus
			if !errors.As(err, &rpcErr) || rpcErr.Code != 40401 {
				slog.Error("receive rocketmq message failed", "error", err)
			}
			continue
		}
		for _, message := range messages {
			timeoutRollback := false
			var handleErr error
			switch message.GetTopic() {
			case OrderTopic():
				var command database.Order
				if handleErr = sonic.Unmarshal(message.GetBody(), &command); handleErr == nil {
					handleErr = createOrder(command)
				}
				if handleErr != nil {
					slog.Error("rocketmq create order failed; leave unacked",
						"message_id", message.GetMessageId(), "topic", message.GetTopic(), "error", handleErr)
				}
			case CancelTopic():
				var command database.Order
				if handleErr = sonic.Unmarshal(message.GetBody(), &command); handleErr == nil {
					timeoutRollback, handleErr = timeout(command)
				}
				if handleErr != nil {
					slog.Error("rocketmq cancel order failed; leave unacked",
						"message_id", message.GetMessageId(), "topic", message.GetTopic(), "error", handleErr)
				}
			case PurchaseInvalidationTopic():
				var command database.PurchaseCacheInvalidation
				if handleErr = sonic.Unmarshal(message.GetBody(), &command); handleErr == nil {
					if invalidate == nil {
						handleErr = errors.New("purchase invalidation handler is nil")
					} else {
						handleErr = invalidate(command)
					}
				}
				if handleErr != nil {
					slog.Error("rocketmq purchase cache invalidation failed; leave unacked",
						"message_id", message.GetMessageId(), "topic", message.GetTopic(),
						"event_id", command.EventID, "material_id", command.MaterialID, "error", handleErr)
				}
			default:
				handleErr = fmt.Errorf("unsupported rocketmq topic %q", message.GetTopic())
			}
			if handleErr != nil {
				metrics.RecordSystemError("RocketMQ 消息处理失败", handleErr)
				continue
			}

			if err := consumer.Ack(ctx, message); err != nil {
				slog.Error("rocketmq message ack failed", "message_id", message.GetMessageId(), "topic", message.GetTopic(), "error", err)
				metrics.RecordSystemError("RocketMQ Ack 失败", err)
				continue
			}
			if message.GetTopic() == CancelTopic() {
				metrics.RecordMQConsumed(timeoutRollback)
			}
			slog.Info("rocketmq message handled", "message_id", message.GetMessageId(),
				"topic", message.GetTopic(), "timeout_rollback", timeoutRollback)
		}
	}
}

func StopConsumer() {
	if simpleConsumer != nil {
		simpleConsumer.GracefulStop()
		slog.Info("stop consumer")
	}
}
