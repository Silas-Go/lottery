package mq

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"silas/internal/util"
	"strings"
	"sync"
	"time"

	rmq_client "github.com/apache/rocketmq-clients/golang/v5"
	"github.com/apache/rocketmq-clients/golang/v5/credentials"
)

const (
	defaultEndpoint                   = "localhost:8081"
	defaultCancelTopic                = "CANCEL_ORDER"
	defaultOrderTopic                 = "CREATE_ORDER"
	defaultPurchaseInvalidationTopic  = "PURCHASE_CACHE_INVALIDATE"
	defaultOrderConsumerGroup         = "lottery"
	defaultPurchaseCacheConsumerGroup = "lottery-purchase-cache"

	defaultConsumerBatchSize = 16
	// 两个 Consumer 都使用 5 秒长轮询：消息到达时 Broker 会立即返回，并不会固定等待 5 秒；
	// 该值只是空队列最多挂起多久。RocketMQ Proxy 会拒绝过短的轮询窗口，不能用 1 秒换取伪低延迟。
	orderConsumerAwaitDuration    = 5 * time.Second
	purchaseConsumerAwaitDuration = 5 * time.Second
	// invisibleDuration 是消息被拉取后的不可见期，不是长轮询等待时间。
	// 保留 10 秒可让处理失败较快重投；两个 handler 的状态迁移与 DEL 都必须幂等。
	consumerInvisibleDuration = 10 * time.Second
	consumerAckTimeout        = 3 * time.Second
	consumerInitRetryInterval = 5 * time.Second
	consumerReceiveRetryDelay = time.Second
)

var (
	orderConsumerMu         sync.Mutex
	orderConsumer           rmq_client.SimpleConsumer
	purchaseCacheConsumerMu sync.Mutex
	purchaseCacheConsumer   rmq_client.SimpleConsumer
)

func Enabled() bool {
	return util.EnvBool("LOTTERY_MQ_ENABLED", true)
}

func Endpoint() string {
	return util.EnvString("LOTTERY_MQ_ENDPOINT", defaultEndpoint)
}

// CancelTopic 是支付窗口结束后执行状态检查的延迟消息 Topic。
// 它只属于订单 Consumer；支付已完成时消费是正常空操作，未支付时才取消并回补库存。
func CancelTopic() string {
	return util.EnvString("LOTTERY_MQ_CANCEL_TOPIC", util.EnvString("LOTTERY_MQ_TOPIC", defaultCancelTopic))
}

// OrderTopic 是 Redis 准入后异步创建 MySQL pending_payment 订单的普通消息 Topic。
// 它和 CancelTopic 共同组成订单生命周期，不与材料缓存失效消息混用 Consumer Group。
func OrderTopic() string {
	return util.EnvString("LOTTERY_MQ_ORDER_TOPIC", defaultOrderTopic)
}

// PurchaseInvalidationTopic 是购买实验 Outbox 发布的材料 DTO 缓存失效 Topic。
// 消息只携带 event_id/material_id；专用缓存 Consumer 校验事件后幂等 DEL，不能执行任意 Redis 命令。
func PurchaseInvalidationTopic() string {
	return util.EnvString("LOTTERY_MQ_PURCHASE_INVALIDATION_TOPIC", defaultPurchaseInvalidationTopic)
}

// Topic 保留旧配置/调用兼容，等价于 CancelTopic。
func Topic() string { return CancelTopic() }

// OrderConsumerGroup 只订阅 CREATE_ORDER 和 CANCEL_ORDER。
// 兼容旧 LOTTERY_MQ_CONSUMER_GROUP 配置，避免升级时改变既有订单消费位点。
func OrderConsumerGroup() string {
	legacy := util.EnvString("LOTTERY_MQ_CONSUMER_GROUP", defaultOrderConsumerGroup)
	return util.EnvString("LOTTERY_MQ_ORDER_CONSUMER_GROUP", legacy)
}

// PurchaseCacheConsumerGroup 只订阅 PURCHASE_CACHE_INVALIDATE。
// 必须与订单 Group 不同；同一 Group 使用不同订阅集合会让 Broker 的负载分配语义变得不确定。
func PurchaseCacheConsumerGroup() string {
	return util.EnvString("LOTTERY_MQ_PURCHASE_CACHE_CONSUMER_GROUP", defaultPurchaseCacheConsumerGroup)
}

// ConsumerGroup 保留旧调用兼容，返回订单 Consumer Group。
func ConsumerGroup() string { return OrderConsumerGroup() }

// ValidateConsumerConfig 在连接 Broker 前拒绝会破坏路由语义的配置。
// 不同订阅集合不能复用 Consumer Group，三个业务 Topic 也不能重名，否则消息会被错误 handler 处理并反复重投。
func ValidateConsumerConfig() error {
	orderGroup := strings.TrimSpace(OrderConsumerGroup())
	purchaseGroup := strings.TrimSpace(PurchaseCacheConsumerGroup())
	if orderGroup == "" || purchaseGroup == "" {
		return fmt.Errorf("rocketmq consumer groups must not be blank")
	}
	if orderGroup == purchaseGroup {
		return fmt.Errorf("rocketmq order and purchase cache consumer groups must differ: %q", orderGroup)
	}

	topics := []struct {
		name  string
		value string
	}{
		{name: "CREATE_ORDER", value: strings.TrimSpace(OrderTopic())},
		{name: "CANCEL_ORDER", value: strings.TrimSpace(CancelTopic())},
		{name: "PURCHASE_CACHE_INVALIDATE", value: strings.TrimSpace(PurchaseInvalidationTopic())},
	}
	seen := make(map[string]string, len(topics))
	for _, topic := range topics {
		if topic.value == "" {
			return fmt.Errorf("rocketmq topic %s must not be blank", topic.name)
		}
		if previous, ok := seen[topic.value]; ok {
			return fmt.Errorf("rocketmq topics %s and %s must differ: %q", previous, topic.name, topic.value)
		}
		seen[topic.value] = topic.name
	}
	return nil
}

func InitRocketLog() {
	os.Setenv(rmq_client.CLIENT_LOG_ROOT, "./log")
	os.Setenv(rmq_client.CLIENT_LOG_FILENAME, "rocket_lottery.log")
	os.Setenv("rocketmq.client.logLevel", "warn")
	rmq_client.ResetLogger()
	slog.Info("rocketmq client log configured", "log_root", "./log", "log_file", "rocket_lottery.log")
}

// newSimpleConsumer 创建一个职责单一的 SimpleConsumer。
// awaitDuration 是空队列长轮询时间；Receive 的 invisibleDuration 则是消息被取走后的不可见期，二者不能混淆。
func newSimpleConsumer(
	group string,
	awaitDuration time.Duration,
	subscriptions map[string]*rmq_client.FilterExpression,
) (rmq_client.SimpleConsumer, error) {
	consumer, err := rmq_client.NewSimpleConsumer(
		&rmq_client.Config{
			Endpoint:      Endpoint(),
			ConsumerGroup: group,
			Credentials:   &credentials.SessionCredentials{},
		},
		rmq_client.WithClientFuncForSimpleConsumer(newRocketClient),
		rmq_client.WithSimpleAwaitDuration(awaitDuration),
		rmq_client.WithSimpleSubscriptionExpressions(subscriptions),
	)
	if err != nil {
		return nil, fmt.Errorf("create rocketmq consumer group %s: %w", group, err)
	}
	if err := consumer.Start(); err != nil {
		return nil, fmt.Errorf("start rocketmq consumer group %s: %w", group, err)
	}
	return consumer, nil
}

func waitConsumerRetry(ctx context.Context) bool {
	return waitConsumerDelay(ctx, consumerInitRetryInterval)
}

// waitConsumerReceiveRetry 防止 Broker/网络持续报错时 Consumer 立即重试形成忙循环并刷爆日志。
// MESSAGE_NOT_FOUND 不走这里，因为一次正常长轮询已经天然承担了等待成本。
func waitConsumerReceiveRetry(ctx context.Context) bool {
	return waitConsumerDelay(ctx, consumerReceiveRetryDelay)
}

func waitConsumerDelay(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// ackConsumerMessage 使用独立短超时确认已经成功处理的消息。
// 应用退出会取消拉取 context，但不能因此丢掉刚完成业务动作的 Ack；Ack 真失败时仍依靠业务幂等承受重投。
func ackConsumerMessage(consumer rmq_client.SimpleConsumer, message *rmq_client.MessageView) error {
	ctx, cancel := context.WithTimeout(context.Background(), consumerAckTimeout)
	defer cancel()
	return consumer.Ack(ctx, message)
}

// StopConsumers 同时停止订单与缓存失效两个消息入口。
// 调用方必须先取消运行 context，再关闭 MySQL/Redis，避免正在处理的状态迁移失去依赖。
func StopConsumers() {
	orderConsumerMu.Lock()
	order := orderConsumer
	orderConsumer = nil
	orderConsumerMu.Unlock()

	purchaseCacheConsumerMu.Lock()
	purchase := purchaseCacheConsumer
	purchaseCacheConsumer = nil
	purchaseCacheConsumerMu.Unlock()

	if order != nil {
		order.GracefulStop()
		slog.Info("rocketmq order consumer stopped", "group", OrderConsumerGroup())
	}
	if purchase != nil {
		purchase.GracefulStop()
		slog.Info("rocketmq purchase cache consumer stopped", "group", PurchaseCacheConsumerGroup())
	}
}

// StopConsumer 保留旧调用兼容；新代码应使用 StopConsumers 表达两个独立入口。
func StopConsumer() { StopConsumers() }
