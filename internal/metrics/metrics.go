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

// Event 表示前端实验室面板上的一条业务事件。
// 它不是审计日志，只用于把限流、入队、回滚、异常等关键状态用中文展示出来。
type Event struct {
	Time string `json:"time"`

	// Title 是事件标题，例如“MQ 入队”“库存回滚”。
	Title string `json:"title"`

	// Detail 是事件详情，用中文解释发生了什么业务状态变化。
	Detail string `json:"detail"`

	// Tone 是前端展示色调，例如 success、warning、danger。
	Tone string `json:"tone"`
}

// Snapshot 表示秒杀实验室面板的一次指标快照。
// 字段名使用英文是为了给前端 JSON 使用；中文语义以这里的注释为准。
type Snapshot struct {
	At string `json:"at"`

	// ActivityStock 是活动初始库存总数，来自 MySQL inventory.count。
	ActivityStock int64 `json:"activityStock"`

	// RedisStock 是 Redis 当前可用库存总数，已经扣掉预扣库存和已完成订单。
	RedisStock int64 `json:"redisStock"`

	// DBStock 是给页面展示的 MySQL 订单侧库存说明，不直接参与业务判断。
	DBStock string `json:"dbStock"`

	// TotalRequests 是 /lucky 抽奖请求总数。
	TotalRequests int64 `json:"totalRequests"`

	// QueueSuccess 是成功拿到临时资格并进入 MQ 超时补偿链路的请求数。
	QueueSuccess int64 `json:"queueSuccess"`

	// RateLimited 是被本机令牌桶限流拦截的请求数。
	RateLimited int64 `json:"rateLimited"`

	// StockFailed 是未拿到库存或重复参与等业务失败数。
	StockFailed int64 `json:"stockFailed"`

	// MQPending 是已经入队但尚未消费的 RocketMQ 延时取消消息数量估计值。
	MQPending int64 `json:"mqPending"`

	// CompletedOrders 是已经写入 MySQL 的正式订单数。
	CompletedOrders int64 `json:"completedOrders"`

	// AvgLatency 是平均请求耗时，单位毫秒。
	AvgLatency int64 `json:"avgLatency"`

	// MaxLatency 是采样窗口内最大请求耗时，单位毫秒。
	MaxLatency int64 `json:"maxLatency"`

	// P95 表示 95% 请求不超过该耗时，单位毫秒。
	P95 int64 `json:"p95"`

	// P99 表示 99% 请求不超过该耗时，单位毫秒。
	P99 int64 `json:"p99"`

	// QPS 是 Queries Per Second，每秒请求数，用最近几秒请求桶估算。
	QPS int64 `json:"qps"`

	// Oversold 表示是否检测到超卖风险。
	// 当前判断基于内存指标：Redis 库存小于 0，或正式订单数超过活动初始库存。
	Oversold bool `json:"oversold"`

	// SimulationTotal/SimulationDone 是前端实验室展示字段，当前都使用真实请求数。
	SimulationTotal int64 `json:"simulationTotal"`
	SimulationDone  int64 `json:"simulationDone"`

	// Events 是最近的业务事件，用于页面解释系统状态变化。
	Events []Event `json:"events"`

	// CacheAside 是旁路缓存模式的压力指标快照，与上面的预扣模式指标并存。
	// 两套指标同页并排，用于在相同压力下对比"预扣（快）"和"Cache-Aside（慢但稳）"的表现。
	CacheAside CacheAsideSnapshot `json:"cacheAside"`
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

// RecordRequest 记录一次 /lucky 请求耗时。
// duration 是从 handler 进入抽奖接口到响应结束的总耗时，用于计算平均延迟、P95、P99 和 QPS。
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

// RecordRedisPreDeduct 记录 Redis 预扣库存成功。
// giftID 是 gift id，奖品 ID；这里只代表拿到临时资格，不代表最终订单成功。
func RecordRedisPreDeduct(giftID int) {
	stock := atomic.AddInt64(&defaultMeter.redisStock, -1)
	if stock < 0 {
		defaultMeter.addEvent("Redis 库存越界", fmt.Sprintf("奖品 %d 扣减后库存小于 0，系统会拒绝该请求。", giftID), "danger")
	}
}

// RecordInventoryRollback 记录一次库存回补。
// reason 是中文或英文的回滚原因，例如 pay timeout、user give up、order create failed。
func RecordInventoryRollback(giftID int, reason string) {
	atomic.AddInt64(&defaultMeter.redisStock, 1)
	defaultMeter.addEvent("库存回滚", fmt.Sprintf("奖品 %d 库存已补回，原因：%s。", giftID, reason), "warning")
}

// RecordQueueSuccess 记录用户成功获得临时资格并进入后续补偿链路。
// queue 在这里不是普通队列，而是“已经发送 RocketMQ 延时取消消息”的业务状态。
func RecordQueueSuccess(giftID int) {
	n := atomic.AddInt64(&defaultMeter.queueSuccess, 1)
	if shouldEmit(n) {
		defaultMeter.addEvent("进入队列", fmt.Sprintf("第 %d 个请求获得资格，奖品 ID：%d。", n, giftID), "success")
	}
}

// RecordRateLimited 记录被入口限流器拦截的请求。
// 这类请求没有进入 Redis Lua，不会影响库存。
func RecordRateLimited() {
	n := atomic.AddInt64(&defaultMeter.rateLimited, 1)
	if shouldEmit(n) {
		defaultMeter.addEvent("限流拦截", fmt.Sprintf("第 %d 个请求被限流器拦截。", n), "warning")
	}
}

// RecordStockFailed 记录没有拿到库存或资格的业务失败。
// reason 应写清中文原因，例如“用户重复参与”“Redis 可用库存为空”。
func RecordStockFailed(reason string) {
	n := atomic.AddInt64(&defaultMeter.stockFailed, 1)
	if shouldEmit(n) {
		defaultMeter.addEvent("库存失败", fmt.Sprintf("第 %d 个请求未获得库存：%s。", n, reason), "warning")
	}
}

// RecordMQEnqueued 记录 RocketMQ 延时取消消息入队。
// MQ 是 Message Queue 的缩写；这里的消息只代表“未来需要检查是否超时”，不代表订单成功。
func RecordMQEnqueued() {
	n := atomic.AddInt64(&defaultMeter.mqPending, 1)
	if shouldEmit(n) {
		defaultMeter.addEvent("MQ 入队", fmt.Sprintf("当前待消费延迟消息：%d。", n), "success")
	}
}

// RecordMQConsumed 记录 RocketMQ 延时取消消息已消费。
// timeoutRollback 表示本次消费是否真的释放了超时未支付的库存；如果用户已支付，消费也可能不回滚。
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

// RecordOrderCompleted 记录 MySQL 正式订单创建成功。
// completed 在这里表示“最终订单已落库”，这是比 Redis 临时资格更强的业务结果。
func RecordOrderCompleted(giftID int) {
	n := atomic.AddInt64(&defaultMeter.completedOrders, 1)
	if shouldEmit(n) {
		defaultMeter.addEvent("订单完成", fmt.Sprintf("第 %d 个正式订单已写入 MySQL，奖品 ID：%d。", n, giftID), "success")
	}
}

// RecordGiveUp 记录用户主动放弃支付。
// 放弃会走 Redis release 释放临时资格并回补库存。
func RecordGiveUp(giftID int) {
	defaultMeter.addEvent("用户放弃", fmt.Sprintf("用户主动放弃奖品 %d，Redis 库存已回滚。", giftID), "warning")
}

// RecordSystemError 记录系统异常事件。
// title 应使用中文描述业务位置；err 保留原始错误，方便从页面和日志一起定位问题。
func RecordSystemError(title string, err error) {
	detail := title
	if err != nil {
		detail = fmt.Sprintf("%s：%s", title, err.Error())
	}
	defaultMeter.addEvent("系统异常", detail, "danger")
}

// SnapshotNow 生成当前秒杀指标快照。
// 前端 SSE 和快照接口都读取这里；它只汇总内存指标，不反向驱动任何业务逻辑。
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
		CacheAside:      SnapshotCacheAside(),
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
