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
	defaultEndpoint      = "localhost:8081"
	defaultCancelTopic   = "CANCEL_ORDER"
	defaultOrderTopic    = "CREATE_ORDER"
	defaultConsumerGroup = "lottery"
)

var (
	simpleConsumer rmq_client.SimpleConsumer
	consumerMu     sync.Mutex
)

// CreateOrderHandler/TimeoutHandler 让 MQ 层只负责传输和 Ack，状态机仍由 service 层统一裁决。
type CreateOrderHandler func(database.Order) error
type TimeoutHandler func(database.Order) (bool, error)

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
		OrderTopic():  rmq_client.SUB_ALL,
		CancelTopic(): rmq_client.SUB_ALL,
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
	slog.Info("rocketmq consumer initialized", "endpoint", endpoint, "order_topic", OrderTopic(), "cancel_topic", CancelTopic(), "group", group)
	return simpleConsumer, nil
}

// ReceiveOrders 消费统一订单生命周期的两类消息。
// 业务处理或消息解析失败时不 Ack，让 MQ 重投；只有幂等业务处理成功后才确认消息。
func ReceiveOrders(createOrder CreateOrderHandler, timeout TimeoutHandler) {
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
			var command database.Order
			if err := sonic.Unmarshal(message.GetBody(), &command); err != nil {
				slog.Error("rocketmq order message parse failed; leave unacked", "message_id", message.GetMessageId(), "topic", message.GetTopic(), "error", err)
				metrics.RecordSystemError("解析 RocketMQ 订单消息失败", err)
				continue
			}

			timeoutRollback := false
			switch message.GetTopic() {
			case OrderTopic():
				err = createOrder(command)
			case CancelTopic():
				timeoutRollback, err = timeout(command)
			default:
				err = fmt.Errorf("unsupported order topic %q", message.GetTopic())
			}
			if err != nil {
				slog.Error("rocketmq order handler failed; leave unacked", "message_id", message.GetMessageId(), "topic", message.GetTopic(), "uid", command.UserId, "gid", command.GiftId, "error", err)
				metrics.RecordSystemError("RocketMQ 订单状态处理失败", err)
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
			slog.Info("rocketmq order message handled", "message_id", message.GetMessageId(), "topic", message.GetTopic(), "uid", command.UserId, "gid", command.GiftId, "timeout_rollback", timeoutRollback)
		}
	}
}

func StopConsumer() {
	if simpleConsumer != nil {
		simpleConsumer.GracefulStop()
		slog.Info("stop consumer")
	}
}
