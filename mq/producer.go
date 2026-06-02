package mq

import (
	"context"
	"dqq/go/frame/lottery/database"
	"log"
	"log/slog"
	"sync"
	"time"

	rmq_client "github.com/apache/rocketmq-clients/golang/v5" //注意：现在是v5
	"github.com/apache/rocketmq-clients/golang/v5/credentials"
	"github.com/bytedance/sonic"
)

var (
	producer rmq_client.Producer
	ponce    sync.Once
)

func GetProducer() rmq_client.Producer {
	ponce.Do(func() {
		if producer != nil {
			return
		}
		var err error
		// 创建Producer
		producer, err = rmq_client.NewProducer(
			&rmq_client.Config{
				Endpoint:    END_POINT,
				Credentials: &credentials.SessionCredentials{},
			},
		)
		if err != nil {
			log.Fatal(err)
		}
		// 启动Producer
		err = producer.Start()
		if err != nil {
			log.Fatal(err)
		}

	})
	return producer
}

// 延迟发送一条取消订单的消息
func SendCancelOrder(order database.Order, delay int) error {
	content, err := sonic.Marshal(order)
	if err != nil {
		return err
	}
	producer := GetProducer()
	msg := &rmq_client.Message{
		Topic: TOPIC,
		Body:  content,
	}
	msg.SetDelayTimestamp(time.Now().Add(time.Duration(delay) * time.Second))

	_, err = producer.Send(context.Background(), msg)
	if err != nil {
		return err
	}
	return nil
}

func StopProducter() {
	if producer != nil {
		producer.GracefulStop()
		slog.Info("stop producer")
	}
}
