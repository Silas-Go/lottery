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

// PurchaseInvalidationHandler 只接收受限的 event_id/material_id，缓存删除与 Outbox 状态由 service 幂等处理。
type PurchaseInvalidationHandler func(database.PurchaseCacheInvalidation) error

// GetPurchaseCacheConsumer 创建材料缓存失效专用 Consumer。
// 独立 Group 避免订单 Topic 的空队列长轮询阻塞缓存消息，并让日志与积压指标保持单一业务语义。
func GetPurchaseCacheConsumer() (rmq_client.SimpleConsumer, error) {
	purchaseCacheConsumerMu.Lock()
	defer purchaseCacheConsumerMu.Unlock()
	if purchaseCacheConsumer != nil {
		return purchaseCacheConsumer, nil
	}

	group := PurchaseCacheConsumerGroup()
	consumer, err := newSimpleConsumer(group, purchaseConsumerAwaitDuration, purchaseCacheConsumerSubscriptions())
	if err != nil {
		return nil, err
	}
	purchaseCacheConsumer = consumer
	slog.Info("rocketmq purchase cache consumer initialized", "endpoint", Endpoint(), "group", group,
		"purchase_cache_invalidation_topic", PurchaseInvalidationTopic())
	return purchaseCacheConsumer, nil
}

func purchaseCacheConsumerSubscriptions() map[string]*rmq_client.FilterExpression {
	return map[string]*rmq_client.FilterExpression{
		PurchaseInvalidationTopic(): rmq_client.SUB_ALL,
	}
}

// RunPurchaseCacheConsumer 持续消费材料缓存失效消息。
// 每条成功购买各有一条可靠事件；即使它们指向同一个 key，也要逐条完成 DEL、Outbox completed 和 Ack。
func RunPurchaseCacheConsumer(ctx context.Context, invalidate PurchaseInvalidationHandler) {
	if !Enabled() {
		slog.Info("rocketmq purchase cache consumer disabled")
		return
	}
	for ctx.Err() == nil {
		consumer, err := GetPurchaseCacheConsumer()
		if err != nil {
			slog.Error("rocketmq purchase cache consumer init failed, retrying", "endpoint", Endpoint(),
				"group", PurchaseCacheConsumerGroup(), "error", err)
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
			slog.Error("receive rocketmq purchase cache message failed; retrying with backoff",
				"group", PurchaseCacheConsumerGroup(), "error", err)
			if !waitConsumerReceiveRetry(ctx) {
				return
			}
			continue
		}
		for _, message := range messages {
			if ctx.Err() != nil {
				return
			}
			command, handleErr := handlePurchaseCacheMessage(
				message.GetTopic(), message.GetMessageId(), message.GetBody(), invalidate,
			)
			if handleErr != nil {
				metrics.RecordSystemError("RocketMQ 缓存失效消息处理失败", handleErr)
				continue
			}
			if err := ackConsumerMessage(consumer, message); err != nil {
				slog.Error("rocketmq purchase cache message ack failed", "message_id", message.GetMessageId(),
					"topic", message.GetTopic(), "group", PurchaseCacheConsumerGroup(),
					"event_id", command.EventID, "material_id", command.MaterialID, "error", err)
				metrics.RecordSystemError("RocketMQ 缓存失效消息 Ack 失败", err)
				continue
			}
			slog.Info("rocketmq purchase cache message handled", "message_id", message.GetMessageId(),
				"topic", message.GetTopic(), "group", PurchaseCacheConsumerGroup(),
				"event_id", command.EventID, "material_id", command.MaterialID)
		}
	}
}

func handlePurchaseCacheMessage(
	topic string,
	messageID string,
	body []byte,
	invalidate PurchaseInvalidationHandler,
) (database.PurchaseCacheInvalidation, error) {
	var command database.PurchaseCacheInvalidation
	if topic != PurchaseInvalidationTopic() {
		return command, fmt.Errorf("purchase cache consumer received unsupported topic %q", topic)
	}
	if err := sonic.Unmarshal(body, &command); err != nil {
		return command, fmt.Errorf("decode purchase cache invalidation message %s: %w", messageID, err)
	}
	if invalidate == nil {
		return command, errors.New("purchase cache invalidation handler is nil")
	}
	if err := invalidate(command); err != nil {
		slog.Error("rocketmq purchase cache invalidation failed; leave unacked",
			"message_id", messageID, "topic", topic,
			"event_id", command.EventID, "material_id", command.MaterialID, "error", err)
		return command, err
	}
	return command, nil
}
