package mq

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"silas/internal/database"
	"silas/internal/metrics"

	rmq_client "github.com/apache/rocketmq-clients/golang/v5"
	"github.com/bytedance/sonic"
)

// CreateOrderHandler/TimeoutHandler 让 MQ 层只负责传输和 Ack，订单状态机仍由 service 层统一裁决。
type CreateOrderHandler func(database.Order) error
type TimeoutHandler func(database.Order) (bool, error)

// GetOrderConsumer 创建只订阅创建订单与超时检查的 Consumer。
// 两个 Topic 属于同一订单生命周期，可以共享 Group；材料缓存失效使用另一个 Consumer Group。
func GetOrderConsumer() (rmq_client.SimpleConsumer, error) {
	orderConsumerMu.Lock()
	defer orderConsumerMu.Unlock()
	if orderConsumer != nil {
		return orderConsumer, nil
	}

	group := OrderConsumerGroup()
	consumer, err := newSimpleConsumer(group, orderConsumerAwaitDuration, orderConsumerSubscriptions())
	if err != nil {
		return nil, err
	}
	orderConsumer = consumer
	slog.Info("rocketmq order consumer initialized", "endpoint", Endpoint(), "group", group,
		"create_order_topic", OrderTopic(), "cancel_order_topic", CancelTopic())
	return orderConsumer, nil
}

func orderConsumerSubscriptions() map[string]*rmq_client.FilterExpression {
	return map[string]*rmq_client.FilterExpression{
		OrderTopic():  rmq_client.SUB_ALL,
		CancelTopic(): rmq_client.SUB_ALL,
	}
}

// RunOrderConsumer 持续消费订单创建和支付超时检查消息。
// 解析、状态迁移或 Ack 失败时消息保持未确认，让 RocketMQ 至少一次重投；业务 handler 必须幂等。
func RunOrderConsumer(ctx context.Context, createOrder CreateOrderHandler, timeout TimeoutHandler) {
	if !Enabled() {
		slog.Info("rocketmq order consumer disabled")
		return
	}
	for ctx.Err() == nil {
		consumer, err := GetOrderConsumer()
		if err != nil {
			slog.Error("rocketmq order consumer init failed, retrying", "endpoint", Endpoint(),
				"group", OrderConsumerGroup(), "error", err)
			if !waitConsumerRetry(ctx) {
				return
			}
			continue
		}

		messages, err := consumer.Receive(ctx, defaultConsumerBatchSize, consumerInvisibleDuration)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			var rpcErr *rmq_client.ErrRpcStatus
			if errors.As(err, &rpcErr) && rpcErr.Code == 40401 {
				continue
			}
			slog.Error("receive rocketmq order message failed; retrying with backoff",
				"group", OrderConsumerGroup(), "error", err)
			if !waitConsumerReceiveRetry(ctx) {
				return
			}
			continue
		}
		for _, message := range messages {
			if ctx.Err() != nil {
				return
			}
			timeoutRollback, handleErr := handleOrderMessage(
				message.GetTopic(), message.GetMessageId(), message.GetBody(), createOrder, timeout,
			)
			if handleErr != nil {
				metrics.RecordSystemError("RocketMQ 订单消息处理失败", handleErr)
				continue
			}
			if err := ackConsumerMessage(consumer, message); err != nil {
				slog.Error("rocketmq order message ack failed", "message_id", message.GetMessageId(),
					"topic", message.GetTopic(), "group", OrderConsumerGroup(), "error", err)
				metrics.RecordSystemError("RocketMQ 订单消息 Ack 失败", err)
				continue
			}
			if message.GetTopic() == CancelTopic() {
				metrics.RecordMQConsumed(timeoutRollback)
			}
			slog.Info("rocketmq order message handled", "message_id", message.GetMessageId(),
				"topic", message.GetTopic(), "group", OrderConsumerGroup(), "timeout_rollback", timeoutRollback)
		}
	}
}

func handleOrderMessage(
	topic string,
	messageID string,
	body []byte,
	createOrder CreateOrderHandler,
	timeout TimeoutHandler,
) (bool, error) {
	var command database.Order
	if err := sonic.Unmarshal(body, &command); err != nil {
		return false, fmt.Errorf("decode %s message %s: %w", topic, messageID, err)
	}
	switch topic {
	case OrderTopic():
		if createOrder == nil {
			return false, errors.New("create order handler is nil")
		}
		if err := createOrder(command); err != nil {
			slog.Error("rocketmq create order failed; leave unacked", "message_id", messageID,
				"topic", topic, "uid", command.UserId, "gid", command.GiftId, "error", err)
			return false, err
		}
		return false, nil
	case CancelTopic():
		if timeout == nil {
			return false, errors.New("timeout handler is nil")
		}
		rolledBack, err := timeout(command)
		if err != nil {
			slog.Error("rocketmq cancel order failed; leave unacked", "message_id", messageID,
				"topic", topic, "uid", command.UserId, "gid", command.GiftId, "error", err)
			return false, err
		}
		return rolledBack, nil
	default:
		return false, fmt.Errorf("order consumer received unsupported topic %q", topic)
	}
}
