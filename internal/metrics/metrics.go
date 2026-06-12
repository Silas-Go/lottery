package metrics

import (
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

const (
	maxLatencySamples = 2048
	maxEvents         = 24
)

type Event struct {
	Time   string `json:"time"`
	Title  string `json:"title"`
	Detail string `json:"detail"`
	Tone   string `json:"tone"`
}

type Snapshot struct {
	At              string  `json:"at"`
	ActivityStock   int64   `json:"activityStock"`
	RedisStock      int64   `json:"redisStock"`
	DBStock         string  `json:"dbStock"`
	TotalRequests   int64   `json:"totalRequests"`
	QueueSuccess    int64   `json:"queueSuccess"`
	RateLimited     int64   `json:"rateLimited"`
	StockFailed     int64   `json:"stockFailed"`
	MQPending       int64   `json:"mqPending"`
	CompletedOrders int64   `json:"completedOrders"`
	AvgLatency      int64   `json:"avgLatency"`
	MaxLatency      int64   `json:"maxLatency"`
	P95             int64   `json:"p95"`
	P99             int64   `json:"p99"`
	QPS             int64   `json:"qps"`
	Oversold        bool    `json:"oversold"`
	SimulationTotal int64   `json:"simulationTotal"`
	SimulationDone  int64   `json:"simulationDone"`
	Events          []Event `json:"events"`
}

type meter struct {
	activityStock   int64
	redisStock      int64
	totalRequests   int64
	queueSuccess    int64
	rateLimited     int64
	stockFailed     int64
	mqPending       int64
	completedOrders int64
	maxLatency      int64

	mu             sync.Mutex
	latencySamples []int64
	secondBuckets  map[int64]int64
	events         []Event
}

var defaultMeter = &meter{
	secondBuckets: make(map[int64]int64),
}

// InitInventory 初始化秒杀指标中的库存基线。
// 活动初始库存和 Redis 当前库存必须分开记录；服务重启后 Redis 会按已完成订单恢复为剩余库存，
// 如果把剩余库存当作初始库存，超卖判断和页面展示都会失真。
func InitInventory(activityStock int64, redisStock int64) {
	atomic.StoreInt64(&defaultMeter.activityStock, activityStock)
	atomic.StoreInt64(&defaultMeter.redisStock, redisStock)
	defaultMeter.addEvent("库存初始化", fmt.Sprintf("活动初始库存为 %d，Redis 可用库存恢复为 %d。", activityStock, redisStock), "success")
}

func RecordRequest(duration time.Duration) {
	ms := duration.Milliseconds()
	if ms < 1 {
		ms = 1
	}
	atomic.AddInt64(&defaultMeter.totalRequests, 1)
	updateMax(&defaultMeter.maxLatency, ms)

	now := time.Now().Unix()
	defaultMeter.mu.Lock()
	defaultMeter.secondBuckets[now]++
	for sec := range defaultMeter.secondBuckets {
		if sec < now-8 {
			delete(defaultMeter.secondBuckets, sec)
		}
	}
	defaultMeter.latencySamples = append(defaultMeter.latencySamples, ms)
	if len(defaultMeter.latencySamples) > maxLatencySamples {
		copy(defaultMeter.latencySamples, defaultMeter.latencySamples[len(defaultMeter.latencySamples)-maxLatencySamples:])
		defaultMeter.latencySamples = defaultMeter.latencySamples[:maxLatencySamples]
	}
	defaultMeter.mu.Unlock()
}

func RecordRedisPreDeduct(giftID int) {
	stock := atomic.AddInt64(&defaultMeter.redisStock, -1)
	if stock < 0 {
		defaultMeter.addEvent("Redis 库存越界", fmt.Sprintf("奖品 %d 扣减后库存小于 0，系统会拒绝该请求。", giftID), "danger")
	}
}

func RecordInventoryRollback(giftID int, reason string) {
	atomic.AddInt64(&defaultMeter.redisStock, 1)
	defaultMeter.addEvent("库存回滚", fmt.Sprintf("奖品 %d 库存已补回，原因：%s。", giftID, reason), "warning")
}

func RecordQueueSuccess(giftID int) {
	n := atomic.AddInt64(&defaultMeter.queueSuccess, 1)
	if shouldEmit(n) {
		defaultMeter.addEvent("进入队列", fmt.Sprintf("第 %d 个请求获得资格，奖品 ID：%d。", n, giftID), "success")
	}
}

func RecordRateLimited() {
	n := atomic.AddInt64(&defaultMeter.rateLimited, 1)
	if shouldEmit(n) {
		defaultMeter.addEvent("限流拦截", fmt.Sprintf("第 %d 个请求被限流器拦截。", n), "warning")
	}
}

func RecordStockFailed(reason string) {
	n := atomic.AddInt64(&defaultMeter.stockFailed, 1)
	if shouldEmit(n) {
		defaultMeter.addEvent("库存失败", fmt.Sprintf("第 %d 个请求未获得库存：%s。", n, reason), "warning")
	}
}

func RecordMQEnqueued() {
	n := atomic.AddInt64(&defaultMeter.mqPending, 1)
	if shouldEmit(n) {
		defaultMeter.addEvent("MQ 入队", fmt.Sprintf("当前待消费延迟消息：%d。", n), "success")
	}
}

func RecordMQConsumed(timeoutRollback bool) {
	n := atomic.AddInt64(&defaultMeter.mqPending, -1)
	if n < 0 {
		atomic.StoreInt64(&defaultMeter.mqPending, 0)
		n = 0
	}
	if timeoutRollback || (n > 0 && shouldEmit(n)) {
		detail := fmt.Sprintf("RocketMQ 已消费延迟消息，待消费剩余：%d。", n)
		tone := "success"
		if timeoutRollback {
			detail = fmt.Sprintf("%s 订单超时未支付，库存已回滚。", detail)
			tone = "warning"
		}
		defaultMeter.addEvent("MQ 消费", detail, tone)
	}
}

func RecordOrderCompleted(giftID int) {
	n := atomic.AddInt64(&defaultMeter.completedOrders, 1)
	if shouldEmit(n) {
		defaultMeter.addEvent("订单完成", fmt.Sprintf("第 %d 个正式订单已写入 MySQL，奖品 ID：%d。", n, giftID), "success")
	}
}

func RecordGiveUp(giftID int) {
	defaultMeter.addEvent("用户放弃", fmt.Sprintf("用户主动放弃奖品 %d，Redis 库存已回滚。", giftID), "warning")
}

func RecordSystemError(title string, err error) {
	detail := title
	if err != nil {
		detail = fmt.Sprintf("%s：%s", title, err.Error())
	}
	defaultMeter.addEvent("系统异常", detail, "danger")
}

func SnapshotNow() Snapshot {
	now := time.Now()

	defaultMeter.mu.Lock()
	latencies := append([]int64(nil), defaultMeter.latencySamples...)
	qps := recentQPS(now, defaultMeter.secondBuckets)
	events := append([]Event(nil), defaultMeter.events...)
	defaultMeter.mu.Unlock()

	sort.Slice(latencies, func(i, j int) bool {
		return latencies[i] < latencies[j]
	})

	activityStock := atomic.LoadInt64(&defaultMeter.activityStock)
	redisStock := atomic.LoadInt64(&defaultMeter.redisStock)
	completedOrders := atomic.LoadInt64(&defaultMeter.completedOrders)
	totalRequests := atomic.LoadInt64(&defaultMeter.totalRequests)
	mqPending := atomic.LoadInt64(&defaultMeter.mqPending)
	if mqPending < 0 {
		mqPending = 0
	}

	return Snapshot{
		At:              now.Format(time.RFC3339),
		ActivityStock:   activityStock,
		RedisStock:      redisStock,
		DBStock:         dbStockText(activityStock, completedOrders),
		TotalRequests:   totalRequests,
		QueueSuccess:    atomic.LoadInt64(&defaultMeter.queueSuccess),
		RateLimited:     atomic.LoadInt64(&defaultMeter.rateLimited),
		StockFailed:     atomic.LoadInt64(&defaultMeter.stockFailed),
		MQPending:       mqPending,
		CompletedOrders: completedOrders,
		AvgLatency:      average(latencies),
		MaxLatency:      atomic.LoadInt64(&defaultMeter.maxLatency),
		P95:             percentile(latencies, 0.95),
		P99:             percentile(latencies, 0.99),
		QPS:             qps,
		Oversold:        redisStock < 0 || (activityStock > 0 && completedOrders > activityStock),
		SimulationTotal: totalRequests,
		SimulationDone:  totalRequests,
		Events:          events,
	}
}

func (m *meter) addEvent(title, detail, tone string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.events = append([]Event{{
		Time:   time.Now().Format("15:04:05"),
		Title:  title,
		Detail: detail,
		Tone:   tone,
	}}, m.events...)
	if len(m.events) > maxEvents {
		m.events = m.events[:maxEvents]
	}
}

func updateMax(addr *int64, value int64) {
	for {
		old := atomic.LoadInt64(addr)
		if value <= old {
			return
		}
		if atomic.CompareAndSwapInt64(addr, old, value) {
			return
		}
	}
}

func shouldEmit(n int64) bool {
	return n <= 5 || n%100 == 0
}

func recentQPS(now time.Time, buckets map[int64]int64) int64 {
	var total int64
	var activeSeconds int64
	nowSec := now.Unix()
	for offset := int64(0); offset < 5; offset++ {
		count := buckets[nowSec-offset]
		if count == 0 {
			continue
		}
		total += count
		activeSeconds++
	}
	if activeSeconds > 0 {
		return total / activeSeconds
	}
	for offset := int64(5); offset <= 8; offset++ {
		if count := buckets[nowSec-offset]; count > 0 {
			return count
		}
	}
	return 0
}

func average(values []int64) int64 {
	if len(values) == 0 {
		return 0
	}
	var total int64
	for _, value := range values {
		total += value
	}
	return total / int64(len(values))
}

func percentile(values []int64, p float64) int64 {
	if len(values) == 0 {
		return 0
	}
	index := int(float64(len(values)-1) * p)
	return values[index]
}

func dbStockText(activityStock, completedOrders int64) string {
	if activityStock <= 0 {
		return "0 / 未初始化"
	}
	if completedOrders == 0 {
		return fmt.Sprintf("%d / 等待异步落库", activityStock)
	}
	stock := activityStock - completedOrders
	if stock < 0 {
		stock = 0
	}
	return fmt.Sprintf("%d / 已完成订单 %d", stock, completedOrders)
}
