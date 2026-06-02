package mq

import (
	"context"
	"dqq/go/frame/lottery/database"
	"errors"
	"log/slog"
	"os"
	"sync"
	"time"

	rmq_client "github.com/apache/rocketmq-clients/golang/v5" //注意：现在是v5
	"github.com/apache/rocketmq-clients/golang/v5/credentials"
	"github.com/bytedance/sonic"
	"github.com/gofiber/fiber/v3/log"
)

const (
	END_POINT = "localhost:8081"
	// ./mqadmin.cmd updateTopic -n localhost:9876 -c DefaultCluster -t CANCEL_ORDER -a +message.type=DELAY
	// ./mqadmin.cmd deleteTopic -n localhost:9876 -c DefaultCluster -t CANCEL_ORDER
	TOPIC = "CANCEL_ORDER"
	// ./mqadmin.cmd updateSubGroup -n localhost:9876 -c DefaultCluster -g lottery
	CONSUMER_GROUP = "lottery"
)

var (
	simpleConsumer rmq_client.SimpleConsumer
	conce          sync.Once
)

func InitRocketLog() {
	os.Setenv(rmq_client.CLIENT_LOG_ROOT, "D:/go_project/go_frame/log")
	os.Setenv(rmq_client.CLIENT_LOG_FILENAME, "rocket_lottery.log")
	rmq_client.ResetLogger()
}

func GetConsumer() rmq_client.SimpleConsumer {
	conce.Do(func() {
		if simpleConsumer != nil {
			return
		}
		var err error
		// 创建consumer
		simpleConsumer, err = rmq_client.NewSimpleConsumer(
			&rmq_client.Config{
				Endpoint:      END_POINT,
				ConsumerGroup: CONSUMER_GROUP,
				Credentials:   &credentials.SessionCredentials{},
			},
			rmq_client.WithSimpleAwaitDuration(5*time.Second),
			rmq_client.WithSimpleSubscriptionExpressions(map[string]*rmq_client.FilterExpression{
				TOPIC: rmq_client.SUB_ALL, //订阅主题下的所有Tag
			}),
		)
		if err != nil {
			log.Fatal(err)
		}
		// 启动Consumer
		err = simpleConsumer.Start()
		if err != nil {
			log.Fatal(err)
		}
	})
	return simpleConsumer
}

func ReceiveCancelOrder() {
	consumer := GetConsumer()
	ctx := context.Background()
	for {
		megs, err := consumer.Receive(ctx, 1, 10*time.Second)
		if err != nil {
			var e *rmq_client.ErrRpcStatus
			if errors.As(err, &e) {
				if e.Code != 40401 { // no new message
					slog.Error("receive message failed", "code", e.Code, "error", e.Message)
				}
			}
			continue
		}
		for _, mg := range megs {
			var order database.Order
			err := sonic.Unmarshal(mg.GetBody(), &order)
			if err == nil {
				gid := database.GetTempOrder(order.UserId)
				// 临时订单还在，说明用户没有完成支付
				if gid == order.GiftId {
					database.DeleteTempOrder(order.UserId, order.GiftId) //删除临时订单
					database.IncreaseInventory(order.GiftId)             //库存加1
					slog.Info("已超时，删除临时订单", "uid", order.UserId, "gid", order.GiftId)
				}
			}
			consumer.Ack(ctx, mg)
		}
	}
}

func StopConsumer() {
	if simpleConsumer != nil {
		simpleConsumer.GracefulStop()
		slog.Info("stop consumer")
	}
}
