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

// Enabled 判断当前进程是否启用 RocketMQ。
// 本地排查前端或 Redis 链路时可以关闭 MQ，避免外部依赖故障掩盖主流程问题。
func Enabled() bool {
	return util.EnvBool("LOTTERY_MQ_ENABLED", true)
}

// Endpoint 返回 RocketMQ proxy 的访问地址。
// 统一从环境变量读取，是为了让本机、Docker 和面试演示环境可以复用同一套代码。
func Endpoint() string {
	return util.EnvString("LOTTERY_MQ_ENDPOINT", defaultEndpoint)
}

// Topic 返回支付超时补偿消息使用的 topic。
// 该 topic 必须支持延时消息，否则用户未支付时库存无法按时释放。
func Topic() string {
	return util.EnvString("LOTTERY_MQ_TOPIC", defaultTopic)
}

// ConsumerGroup 返回超时补偿消费者组。
// 使用固定消费者组可以避免同一条补偿消息被多个逻辑消费者重复释放库存。
func ConsumerGroup() string {
	return util.EnvString("LOTTERY_MQ_CONSUMER_GROUP", defaultConsumerGroup)
}

// InitRocketLog 初始化 RocketMQ 客户端自己的日志输出。
// Go 应用日志和 RocketMQ SDK 日志分开保存，方便判断问题来自业务链路还是 MQ 客户端。
func InitRocketLog() {
	os.Setenv(rmq_client.CLIENT_LOG_ROOT, "./log")
	os.Setenv(rmq_client.CLIENT_LOG_FILENAME, "rocket_lottery.log")
	os.Setenv("rocketmq.client.logLevel", "warn")
	rmq_client.ResetLogger()
	slog.Info("rocketmq client log configured", "log_root", "./log", "log_file", "rocket_lottery.log")
}

// GetConsumer 获取全局 RocketMQ SimpleConsumer。
// consumer 创建和启动成本较高，并且同一进程只需要一个补偿消费者，所以用锁保护单例初始化。
func GetConsumer() (rmq_client.SimpleConsumer, error) {
	consumerMu.Lock()
	defer consumerMu.Unlock()

	if simpleConsumer != nil {
		return simpleConsumer, nil
	}

	endpoint := Endpoint()
	topic := Topic()
	group := ConsumerGroup()
	slog.Info("rocketmq consumer initializing", "endpoint", endpoint, "topic", topic, "group", group)
	consumer, err := rmq_client.NewSimpleConsumer(
		&rmq_client.Config{
			Endpoint:      endpoint,
			ConsumerGroup: group,
			Credentials:   &credentials.SessionCredentials{},
		},
		rmq_client.WithClientFuncForSimpleConsumer(newRocketClient),
		rmq_client.WithSimpleAwaitDuration(5*time.Second),
		rmq_client.WithSimpleSubscriptionExpressions(map[string]*rmq_client.FilterExpression{
			topic: rmq_client.SUB_ALL, //订阅主题下的所有Tag
		}),
	)
	if err != nil {
		slog.Error("rocketmq consumer create failed", "endpoint", endpoint, "topic", topic, "group", group, "error", err)
		return nil, err
	}
	if err := consumer.Start(); err != nil {
		slog.Error("rocketmq consumer start failed", "endpoint", endpoint, "topic", topic, "group", group, "error", err)
		return nil, err
	}

	simpleConsumer = consumer
	slog.Info("rocketmq consumer initialized", "endpoint", endpoint, "topic", topic, "group", group)
	return simpleConsumer, nil
}

// ReceiveCancelOrder 持续消费支付超时补偿消息。
//
// 补偿流程：
//
// 1. 拉取 RocketMQ 延时消息
// 2. 解析出用户和奖品
// 3. 通过 Redis Lua 释放仍未支付的临时资格
// 4. 记录回补指标
// 5. Ack 消息，避免同一补偿被重复投递
//
// 即使消息晚到也不能直接回补库存，必须先确认临时资格仍然存在；
// 否则用户已经支付成功后，延时消息会把库存错误加回去。
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
				if e.Code != 40401 { // 40401 表示本次长轮询没有新消息，不属于异常链路。
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
				slog.Info("rocketmq cancel order message received", "uid", order.UserId, "gid", order.GiftId, "message_id", mg.GetMessageId())
				// 超时补偿只释放仍属于该用户和奖品的临时资格。
				// 如果支付已经认领资格，ReleaseLotteryAdmission 会返回 false，不会回补库存。
				released, err := database.ReleaseLotteryAdmission(order.UserId, order.GiftId)
				if err != nil {
					slog.Error("rocketmq timeout release failed", "uid", order.UserId, "gid", order.GiftId, "message_id", mg.GetMessageId(), "error", err)
					metrics.RecordSystemError("MQ 超时回滚库存失败", err)
				} else if released {
					metrics.RecordInventoryRollback(order.GiftId, "pay timeout")
					timeoutRollback = true
					slog.Info("rocketmq timeout released admission", "uid", order.UserId, "gid", order.GiftId, "message_id", mg.GetMessageId())
				} else {
					slog.Info("rocketmq timeout release skipped, admission already handled", "uid", order.UserId, "gid", order.GiftId, "message_id", mg.GetMessageId())
				}
			} else {
				slog.Error("rocketmq cancel order message parse failed", "message_id", mg.GetMessageId(), "error", err)
				metrics.RecordSystemError("解析 RocketMQ 消息失败", err)
			}
			if err := consumer.Ack(ctx, mg); err != nil {
				slog.Error("rocketmq message ack failed", "message_id", mg.GetMessageId(), "error", err)
				metrics.RecordSystemError("RocketMQ Ack 失败", err)
			} else {
				slog.Info("rocketmq message ack success", "message_id", mg.GetMessageId(), "timeout_rollback", timeoutRollback)
			}
			metrics.RecordMQConsumed(timeoutRollback)
		}
	}
}

// StopConsumer 停止全局 RocketMQ consumer。
// 关闭时主动停止 MQ 客户端，避免进程退出时留下未刷新的 SDK 状态和难以定位的连接日志。
func StopConsumer() {
	if simpleConsumer != nil {
		simpleConsumer.GracefulStop()
		slog.Info("stop consumer")
	}
}
