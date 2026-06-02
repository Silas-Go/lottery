package mq

import (
	"context"
	"fmt"
	"log/slog"
	"silas/database"
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

	endpoint := Endpoint()
	topic := Topic()
	slog.Info("rocketmq producer initializing", "endpoint", endpoint, "topic", topic)
	p, err := rmq_client.NewProducer(
		&rmq_client.Config{
			Endpoint:    endpoint,
			Credentials: &credentials.SessionCredentials{},
		},
		rmq_client.WithClientFunc(newRocketClient),
		rmq_client.WithTopics(topic),
	)
	if err != nil {
		slog.Error("rocketmq producer create failed", "endpoint", endpoint, "topic", topic, "error", err)
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
		slog.Error("rocketmq producer start failed", "endpoint", endpoint, "topic", topic, "error", err)
		return nil, fmt.Errorf("start rocketmq producer: %w", err)
	case <-time.After(producerStartTimeout):
		slog.Error("rocketmq producer start timeout", "endpoint", endpoint, "topic", topic, "timeout", producerStartTimeout)
		go func() {
			if err := <-startErr; err == nil {
				p.GracefulStop()
			}
		}()
		return nil, fmt.Errorf("start rocketmq producer timed out after %s", producerStartTimeout)
	}

	producer = p
	slog.Info("rocketmq producer initialized", "endpoint", endpoint, "topic", topic)
	return producer, nil
}

func SendCancelOrder(order database.Order, delay int) error {
	if !Enabled() {
		slog.Info("rocketmq producer disabled, skip cancel order message", "uid", order.UserId, "gid", order.GiftId)
		return nil
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
		Topic: Topic(),
		Body:  content,
	}
	msg.SetDelayTimestamp(time.Now().Add(time.Duration(delay) * time.Second))

	ctx, cancel := context.WithTimeout(context.Background(), producerSendTimeout)
	defer cancel()

	if _, err := producer.Send(ctx, msg); err != nil {
		slog.Error("send cancel order failed", "uid", order.UserId, "gid", order.GiftId, "topic", Topic(), "delay", delay, "error", err)
		return fmt.Errorf("send cancel order to rocketmq: %w", err)
	}

	slog.Info("send cancel order success", "uid", order.UserId, "gid", order.GiftId, "topic", Topic(), "delay", delay)
	return nil
}

func StopProducter() {
	if producer != nil {
		producer.GracefulStop()
		slog.Info("stop producer")
	}
}
