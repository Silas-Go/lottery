package mq

import (
	"context"
	"dqq/go/frame/lottery/database"
	"fmt"
	"log/slog"
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

func GetProducer() (rmq_client.Producer, error) {
	producerMu.Lock()
	defer producerMu.Unlock()

	if producer != nil {
		return producer, nil
	}

	slog.Info("rocketmq producer initializing", "endpoint", END_POINT, "topic", TOPIC)
	p, err := rmq_client.NewProducer(
		&rmq_client.Config{
			Endpoint:    END_POINT,
			Credentials: &credentials.SessionCredentials{},
		},
		rmq_client.WithClientFunc(newRocketClient),
		rmq_client.WithTopics(TOPIC),
	)
	if err != nil {
		slog.Error("rocketmq producer create failed", "endpoint", END_POINT, "topic", TOPIC, "error", err)
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
		slog.Error("rocketmq producer start failed", "endpoint", END_POINT, "topic", TOPIC, "error", err)
		return nil, fmt.Errorf("start rocketmq producer: %w", err)
	case <-time.After(producerStartTimeout):
		slog.Error("rocketmq producer start timeout", "endpoint", END_POINT, "topic", TOPIC, "timeout", producerStartTimeout)
		go func() {
			if err := <-startErr; err == nil {
				p.GracefulStop()
			}
		}()
		return nil, fmt.Errorf("start rocketmq producer timed out after %s", producerStartTimeout)
	}

	producer = p
	slog.Info("rocketmq producer initialized", "endpoint", END_POINT, "topic", TOPIC)
	return producer, nil
}

func SendCancelOrder(order database.Order, delay int) error {
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
		Topic: TOPIC,
		Body:  content,
	}
	msg.SetDelayTimestamp(time.Now().Add(time.Duration(delay) * time.Second))

	ctx, cancel := context.WithTimeout(context.Background(), producerSendTimeout)
	defer cancel()

	if _, err := producer.Send(ctx, msg); err != nil {
		slog.Error("send cancel order failed", "uid", order.UserId, "gid", order.GiftId, "topic", TOPIC, "delay", delay, "error", err)
		return fmt.Errorf("send cancel order to rocketmq: %w", err)
	}

	slog.Info("send cancel order success", "uid", order.UserId, "gid", order.GiftId, "topic", TOPIC, "delay", delay)
	return nil
}

func StopProducter() {
	if producer != nil {
		producer.GracefulStop()
		slog.Info("stop producer")
	}
}
