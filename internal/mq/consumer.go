package mq

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"silas/internal/database"
	"silas/internal/metrics"
	"silas/internal/util"
	"sync"
	"time"

	rmq_client "github.com/apache/rocketmq-clients/golang/v5" //注意：现在是v5
	"github.com/apache/rocketmq-clients/golang/v5/credentials"
	"github.com/bytedance/sonic"
)

const (
	// ./mqadmin.cmd updateTopic -n localhost:9876 -c DefaultCluster -t CANCEL_ORDER -a +message.type=DELAY
	// ./mqadmin.cmd deleteTopic -n localhost:9876 -c DefaultCluster -t CANCEL_ORDER
	// ./mqadmin.cmd updateSubGroup -n localhost:9876 -c DefaultCluster -g lottery
	defaultEndpoint      = "localhost:8081"
	defaultTopic         = "CANCEL_ORDER"
	defaultConsumerGroup = "lottery"
)

var (
	simpleConsumer rmq_client.SimpleConsumer
	consumerMu     sync.Mutex
)

func Enabled() bool {
	return util.EnvBool("LOTTERY_MQ_ENABLED", true)
}

func Endpoint() string {
	return util.EnvString("LOTTERY_MQ_ENDPOINT", defaultEndpoint)
}

func Topic() string {
	return util.EnvString("LOTTERY_MQ_TOPIC", defaultTopic)
}

func ConsumerGroup() string {
	return util.EnvString("LOTTERY_MQ_CONSUMER_GROUP", defaultConsumerGroup)
}

func InitRocketLog() {
	os.Setenv(rmq_client.CLIENT_LOG_ROOT, "./log")
	os.Setenv(rmq_client.CLIENT_LOG_FILENAME, "rocket_lottery.log")
	os.Setenv("rocketmq.client.logLevel", "warn")
	rmq_client.ResetLogger()
}

func GetConsumer() (rmq_client.SimpleConsumer, error) {
	consumerMu.Lock()
	defer consumerMu.Unlock()

	if simpleConsumer != nil {
		return simpleConsumer, nil
	}

	endpoint := Endpoint()
	topic := Topic()
	consumer, err := rmq_client.NewSimpleConsumer(
		&rmq_client.Config{
			Endpoint:      endpoint,
			ConsumerGroup: ConsumerGroup(),
			Credentials:   &credentials.SessionCredentials{},
		},
		rmq_client.WithClientFuncForSimpleConsumer(newRocketClient),
		rmq_client.WithSimpleAwaitDuration(5*time.Second),
		rmq_client.WithSimpleSubscriptionExpressions(map[string]*rmq_client.FilterExpression{
			topic: rmq_client.SUB_ALL, //订阅主题下的所有Tag
		}),
	)
	if err != nil {
		return nil, err
	}
	if err := consumer.Start(); err != nil {
		return nil, err
	}

	simpleConsumer = consumer
	return simpleConsumer, nil
}

func ReceiveCancelOrder() {
	if !Enabled() {
		slog.Info("rocketmq consumer disabled")
		return
	}
	ctx := context.Background()
	for {
		consumer, err := GetConsumer()
		if err != nil {
			slog.Error("rocketmq consumer init failed, retrying", "endpoint", Endpoint(), "topic", Topic(), "error", err)
			time.Sleep(5 * time.Second)
			continue
		}

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
			timeoutRollback := false
			err := sonic.Unmarshal(mg.GetBody(), &order)
			if err == nil {
				released, err := database.ReleaseLotteryAdmission(order.UserId, order.GiftId)
				if err != nil {
					metrics.RecordSystemError("MQ 超时回滚库存失败", err)
				} else if released {
					metrics.RecordInventoryRollback(order.GiftId, "pay timeout")
					timeoutRollback = true
					slog.Info("已超时，删除临时订单", "uid", order.UserId, "gid", order.GiftId)
				}
			} else {
				metrics.RecordSystemError("解析 RocketMQ 消息失败", err)
			}
			if err := consumer.Ack(ctx, mg); err != nil {
				metrics.RecordSystemError("RocketMQ Ack 失败", err)
			}
			metrics.RecordMQConsumed(timeoutRollback)
		}
	}
}

func StopConsumer() {
	if simpleConsumer != nil {
		simpleConsumer.GracefulStop()
		slog.Info("stop consumer")
	}
}
