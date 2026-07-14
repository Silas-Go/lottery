package mq

import (
	"context"
	"fmt"
	"log/slog"
	"silas/internal/database"
	"silas/internal/metrics"
	"sync"
	"time"

	rmq_client "github.com/apache/rocketmq-clients/golang/v5"
	"github.com/apache/rocketmq-clients/golang/v5/credentials"
	"github.com/bytedance/sonic"
)

const (
	producerStartTimeout = 5 * time.Second
	producerSendTimeout  = 5 * time.Second
)

var (
	producer   rmq_client.Producer
	producerMu sync.Mutex
)

// GetProducer 获取全局 RocketMQ producer。
// producer 复用可以避免每次抽奖成功都重新建连接；这里用锁保护初始化，
// 防止并发抽奖时多个 goroutine 同时创建 SDK client。
func GetProducer() (rmq_client.Producer, error) {
	producerMu.Lock()
	defer producerMu.Unlock()

	if producer != nil {
		return producer, nil
	}

	endpoint := Endpoint()
	cancelTopic := CancelTopic()
	orderTopic := OrderTopic()
	slog.Info("rocketmq producer initializing", "endpoint", endpoint, "cancel_topic", cancelTopic, "order_topic", orderTopic)
	p, err := rmq_client.NewProducer(
		&rmq_client.Config{
			Endpoint:    endpoint,
			Credentials: &credentials.SessionCredentials{},
		},
		rmq_client.WithClientFunc(newRocketClient),
		rmq_client.WithTopics(cancelTopic, orderTopic),
	)
	if err != nil {
		slog.Error("rocketmq producer create failed", "endpoint", endpoint, "cancel_topic", cancelTopic, "order_topic", orderTopic, "error", err)
		return nil, fmt.Errorf("create rocketmq producer: %w", err)
	}

	startErr := make(chan error, 1)
	go func() {
		startErr <- p.Start()
	}()

	select {
	case err := <-startErr:
		if err == nil {
			break
		}
		slog.Error("rocketmq producer start failed", "endpoint", endpoint, "cancel_topic", cancelTopic, "order_topic", orderTopic, "error", err)
		return nil, fmt.Errorf("start rocketmq producer: %w", err)
	case <-time.After(producerStartTimeout):
		slog.Error("rocketmq producer start timeout", "endpoint", endpoint, "cancel_topic", cancelTopic, "order_topic", orderTopic, "timeout", producerStartTimeout)
		go func() {
			if err := <-startErr; err == nil {
				p.GracefulStop()
			}
		}()
		return nil, fmt.Errorf("start rocketmq producer timed out after %s", producerStartTimeout)
	}

	producer = p
	slog.Info("rocketmq producer initialized", "endpoint", endpoint, "cancel_topic", cancelTopic, "order_topic", orderTopic)
	return producer, nil
}

// SendCancelOrder 发送支付超时取消消息。
//
// 参数语义:
//
//	order 消息体包含用户、奖品、库存模式和支付截止时间。
//	delay 延时秒数，表示用户支付窗口；超过该时间后消费者会检查是否需要释放库存。
//
// 延迟消息只触发状态检查，不直接代表取消成功；OrderService 会按 inventory_mode
// 在 Redis 或 MySQL 上竞争 pending_payment -> cancelled，并保证库存只回补一次。
func SendCancelOrder(order database.Order, delay int) error {
	if !Enabled() {
		return fmt.Errorf("rocketmq disabled: timeout cancellation cannot be scheduled")
	}

	content, err := sonic.Marshal(order)
	if err != nil {
		slog.Error("marshal cancel order failed", "uid", order.UserId, "gid", order.GiftId, "error", err)
		return fmt.Errorf("marshal cancel order: %w", err)
	}

	producer, err := GetProducer()
	if err != nil {
		return err
	}

	msg := &rmq_client.Message{
		Topic: CancelTopic(),
		Body:  content,
	}
	// 延时消息是支付超时补偿的触发器。
	// 到期后是否真的释放库存，还要由 Redis Lua 再确认临时资格是否仍然存在。
	msg.SetDelayTimestamp(time.Now().Add(time.Duration(delay) * time.Second))

	ctx, cancel := context.WithTimeout(context.Background(), producerSendTimeout)
	defer cancel()

	if _, err := producer.Send(ctx, msg); err != nil {
		slog.Error("send cancel order failed", "uid", order.UserId, "gid", order.GiftId, "topic", CancelTopic(), "delay", delay, "error", err)
		return fmt.Errorf("send cancel order to rocketmq: %w", err)
	}

	metrics.RecordMQEnqueued()
	slog.Info("send cancel order success", "uid", order.UserId, "gid", order.GiftId, "topic", CancelTopic(), "delay", delay)
	return nil
}

// SendCreateOrder 发送普通订单创建消息。
// 这是 Redis 模式真正承担异步削峰的消息：入口只完成 Redis stock_acquired，消费者按自身速率建立 MySQL pending_payment 账本。
func SendCreateOrder(order database.Order) error {
	if !Enabled() {
		return fmt.Errorf("rocketmq disabled: async order cannot be created")
	}
	content, err := sonic.Marshal(order)
	if err != nil {
		return fmt.Errorf("marshal create order: %w", err)
	}
	producer, err := GetProducer()
	if err != nil {
		return err
	}
	msg := &rmq_client.Message{Topic: OrderTopic(), Body: content}
	ctx, cancel := context.WithTimeout(context.Background(), producerSendTimeout)
	defer cancel()
	if _, err := producer.Send(ctx, msg); err != nil {
		return fmt.Errorf("send create order to rocketmq: %w", err)
	}
	slog.Info("send async create order success", "uid", order.UserId, "gid", order.GiftId, "topic", OrderTopic())
	return nil
}

// StopProducter 停止全局 RocketMQ producer。
// 函数名保留历史拼写，避免扩大调用方改动；后续可以单独做兼容重命名。
func StopProducter() {
	if producer != nil {
		producer.GracefulStop()
		slog.Info("stop producer")
	}
}
