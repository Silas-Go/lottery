package loadtest

import (
	"fmt"
	"time"
)

const (
	ExperimentCacheAsideRead = "cache-aside-read"
	MaxDurationSeconds       = 30
	DefaultDurationSeconds   = 30
)

// TierID 是公开挡位的稳定标识；它不携带任何可执行参数。
type TierID string

const (
	TierVisitors    TierID = "visitors"
	TierTideEve     TierID = "tide_eve"
	TierCrowd       TierID = "crowd"
	TierBoilingCity TierID = "boiling_city"
)

const (
	TierQPS100  TierID = "qps_100"
	TierQPS300  TierID = "qps_300"
	TierQPS800  TierID = "qps_800"
	TierQPS1500 TierID = "qps_1500"
)

// ConnectionMode 区分由 Runner 估算通路数，还是用户从有限白名单中选择通路数。
// 它描述的是 wrk2 持久连接，不是虚拟用户数。
type ConnectionMode string

const (
	ConnectionModeAuto   ConnectionMode = "auto"
	ConnectionModeManual ConnectionMode = "manual"
)

// TierConfig 是 Runner 唯一信任的压测参数白名单。
// Rate 是每秒计划产生的 HTTP 请求数，Connections 是传给 wrk2 -c、计划保持的
// HTTP 持久连接数，不代表成功建立的 Socket 数；二者都不是在线人数。
// Duration 仍由 Runner 固定，避免任意压力参数进入子进程。
type TierConfig struct {
	ID              TierID `json:"id"`
	Label           string `json:"label"`
	Rate            int    `json:"rate"`
	Connections     int    `json:"connections"`
	DurationSeconds int    `json:"durationSeconds"`
}

var tierConfigs = map[TierID]TierConfig{
	TierVisitors:    {ID: TierVisitors, Label: "零星访客", Rate: 100, Connections: 16, DurationSeconds: 20},
	TierTideEve:     {ID: TierTideEve, Label: "潮汐前夜", Rate: 500, Connections: 32, DurationSeconds: 20},
	TierCrowd:       {ID: TierCrowd, Label: "人潮涌入", Rate: 1500, Connections: 64, DurationSeconds: 20},
	TierBoilingCity: {ID: TierBoilingCity, Label: "王城沸腾", Rate: 3000, Connections: 96, DurationSeconds: 20},
}

var rateConfigs = map[int]TierConfig{
	100:  {ID: TierQPS100, Label: "100 卷轴/秒", Rate: 100, DurationSeconds: DefaultDurationSeconds},
	300:  {ID: TierQPS300, Label: "300 卷轴/秒", Rate: 300, DurationSeconds: DefaultDurationSeconds},
	800:  {ID: TierQPS800, Label: "800 卷轴/秒", Rate: 800, DurationSeconds: DefaultDurationSeconds},
	1500: {ID: TierQPS1500, Label: "1500 卷轴/秒", Rate: 1500, DurationSeconds: DefaultDurationSeconds},
}

var manualConnectionOptions = map[int]struct{}{
	70:  {},
	140: {},
	300: {},
	500: {},
}

// ResolveTier 把公开挡位 ID 转换为 Runner 内部固定参数。
// 旧 Tier 只为已发布页面和磁盘任务兼容保留；新页面应提交 Rate 与 ConnectionMode。
func ResolveTier(id TierID) (TierConfig, bool) {
	config, ok := tierConfigs[id]
	return config, ok
}

// ResolveRate 把“查询潮汐”速率转换为 Runner 的固定白名单参数。
func ResolveRate(rate int) (TierConfig, bool) {
	config, ok := rateConfigs[rate]
	return config, ok
}

// ValidManualConnections 判断手动通路数是否属于页面公开的有限选项。
func ValidManualConnections(connections int) bool {
	_, ok := manualConnectionOptions[connections]
	return ok
}

// TaskStatus 表示 Runner 权威任务状态，不由前端本地动画推断。
type TaskStatus string

const (
	StatusIdle       TaskStatus = "idle"
	StatusStarting   TaskStatus = "starting"
	StatusResetting  TaskStatus = "resetting"
	StatusRunning    TaskStatus = "running"
	StatusCollecting TaskStatus = "collecting"
	StatusCompleted  TaskStatus = "completed"
	StatusFailed     TaskStatus = "failed"
	StatusStopped    TaskStatus = "stopped"
)

// Active 表示任务仍持有全局单任务运行锁。
func (status TaskStatus) Active() bool {
	switch status {
	case StatusStarting, StatusResetting, StatusRunning, StatusCollecting:
		return true
	default:
		return false
	}
}

// Terminal 表示任务已经不会再发生状态推进。
func (status TaskStatus) Terminal() bool {
	return status == StatusCompleted || status == StatusFailed || status == StatusStopped
}

// EventType 是任务 SSE 的有限事件集合。
type EventType string

const (
	EventTaskStarted     EventType = "task_started"
	EventResetCompleted  EventType = "reset_completed"
	EventLoadtestStarted EventType = "loadtest_started"
	EventProgress        EventType = "progress"
	EventMetric          EventType = "metric"
	EventLog             EventType = "log"
	EventCompleted       EventType = "completed"
	EventFailed          EventType = "failed"
	EventStopped         EventType = "stopped"
)

// CreateRequest 是主应用和 Runner 共同使用的受控任务输入。
// 这里刻意没有 target URL、Lua 路径、持续时间或可执行文件字段。
type CreateRequest struct {
	Experiment     string         `json:"experiment"`
	ArchiveID      int            `json:"archiveId"`
	Mode           string         `json:"mode"`
	Tier           TierID         `json:"tier,omitempty"`
	Rate           int            `json:"rate,omitempty"`
	ConnectionMode ConnectionMode `json:"connectionMode,omitempty"`
	Connections    int            `json:"connections,omitempty"`
}

// ValidateCreateRequest 在主应用和 Runner 两侧重复执行白名单校验。
// 双重校验不能替代网络隔离，但可以避免绕过浏览器后把任意参数交给 wrk2。
func ValidateCreateRequest(request CreateRequest) (TierConfig, string) {
	if request.Experiment != ExperimentCacheAsideRead {
		return TierConfig{}, "experiment must be cache-aside-read"
	}
	if request.ArchiveID < 1 || request.ArchiveID > 4 {
		return TierConfig{}, "archiveId must be between 1 and 4"
	}
	if request.Mode != "direct" && request.Mode != "cached" {
		return TierConfig{}, "mode must be direct or cached"
	}

	// 没有 Rate 的请求属于旧页面协议，完整沿用原 Tier 参数，保证滚动升级期间旧页面
	// 和磁盘中的任务仍可读取。新协议只能使用 100/300/800/1500 QPS。
	if request.Rate == 0 {
		if request.ConnectionMode != "" || request.Connections != 0 {
			return TierConfig{}, "rate is required when configuring connections"
		}
		tier, ok := ResolveTier(request.Tier)
		if !ok {
			return TierConfig{}, "tier is not supported"
		}
		if tier.DurationSeconds <= 0 || tier.DurationSeconds > MaxDurationSeconds {
			return TierConfig{}, "tier duration exceeds runner limit"
		}
		return tier, ""
	}
	if request.Tier != "" {
		return TierConfig{}, "tier and rate cannot be used together"
	}

	tier, ok := ResolveRate(request.Rate)
	if !ok {
		return TierConfig{}, "rate must be one of 100, 300, 800 or 1500"
	}
	connectionMode := request.ConnectionMode
	if connectionMode == "" {
		connectionMode = ConnectionModeAuto
	}
	switch connectionMode {
	case ConnectionModeAuto:
		if request.Connections != 0 {
			return TierConfig{}, "connections must be omitted in auto mode"
		}
	case ConnectionModeManual:
		if !ValidManualConnections(request.Connections) {
			return TierConfig{}, "manual connections must be one of 70, 140, 300 or 500"
		}
		tier.Connections = request.Connections
	default:
		return TierConfig{}, "connectionMode must be auto or manual"
	}
	if tier.DurationSeconds <= 0 || tier.DurationSeconds > MaxDurationSeconds {
		return TierConfig{}, "tier duration exceeds runner limit"
	}
	return tier, ""
}

// TaskMetrics 合并 wrk2 延迟/吞吐结果与应用已有的缓存、SQL 指标。
type TaskMetrics struct {
	ActualRequests       int64   `json:"actualRequests"`
	ActualQPS            float64 `json:"actualQps"`
	DurationSeconds      float64 `json:"durationSeconds"`
	P50MS                float64 `json:"p50Ms"`
	P90MS                float64 `json:"p90Ms"`
	P95MS                float64 `json:"p95Ms"`
	P99MS                float64 `json:"p99Ms"`
	RequestP50MS         float64 `json:"requestP50Ms"`
	RequestP90MS         float64 `json:"requestP90Ms"`
	RequestP95MS         float64 `json:"requestP95Ms"`
	RequestP99MS         float64 `json:"requestP99Ms"`
	TargetCompletionRate float64 `json:"targetCompletionRate"`
	ErrorRate            float64 `json:"errorRate"`
	Timeouts             int64   `json:"timeouts"`
	SocketErrors         int64   `json:"socketErrors"`
	RedisHits            int64   `json:"redisHits"`
	MySQLFallbacks       int64   `json:"mysqlFallbacks"`
	SQLQueries           int64   `json:"sqlQueries"`
	CacheHitRate         float64 `json:"cacheHitRate"`
	PoolPeak             int64   `json:"poolPeak"`
	PoolCapacity         int64   `json:"poolCapacity"`
}

// TaskLog 只保存任务级关键事件，不保存逐请求日志。
type TaskLog struct {
	At      time.Time `json:"at"`
	Level   string    `json:"level"`
	Message string    `json:"message"`
}

// Task 是页面查询和 SSE 恢复使用的权威任务快照。
type Task struct {
	ID                   string         `json:"taskId"`
	Experiment           string         `json:"experiment"`
	ArchiveID            int            `json:"archiveId"`
	Mode                 string         `json:"mode"`
	Tier                 TierConfig     `json:"tier"`
	ConnectionMode       ConnectionMode `json:"connectionMode,omitempty"`
	RequestedConnections int            `json:"requestedConnections,omitempty"`
	ConnectionReason     string         `json:"connectionReason,omitempty"`
	Status               TaskStatus     `json:"status"`
	CreatedAt            time.Time      `json:"createdAt"`
	StartedAt            *time.Time     `json:"startedAt,omitempty"`
	EndedAt              *time.Time     `json:"endedAt,omitempty"`
	ElapsedSeconds       int            `json:"elapsedSeconds"`
	RemainingSeconds     int            `json:"remainingSeconds"`
	Metrics              TaskMetrics    `json:"metrics"`
	ErrorCode            string         `json:"errorCode,omitempty"`
	ErrorMessage         string         `json:"errorMessage,omitempty"`
	Logs                 []TaskLog      `json:"logs"`
}

// Event 是 Runner 推给主应用、再由主应用转发给浏览器的 SSE 数据。
type Event struct {
	ID               int64        `json:"id"`
	Type             EventType    `json:"type"`
	TaskID           string       `json:"taskId"`
	At               time.Time    `json:"at"`
	Status           TaskStatus   `json:"status"`
	Message          string       `json:"message,omitempty"`
	ElapsedSeconds   int          `json:"elapsedSeconds"`
	RemainingSeconds int          `json:"remainingSeconds"`
	Metrics          *TaskMetrics `json:"metrics,omitempty"`
}

// ConnectionPlanResponse 是启动前的只读通路预估。
// Connections 表示将传给 wrk2 -c 的配置值，不保证每个 TCP socket 都成功建立。
type ConnectionPlanResponse struct {
	Rate           int            `json:"rate"`
	ConnectionMode ConnectionMode `json:"connectionMode"`
	Connections    int            `json:"connections"`
	Reason         string         `json:"reason"`
}

// CreateResponse 是异步创建任务后的响应。
// Runner 在返回前已经锁定 wrk2 -c，因此前端无需等待下一次 GET 才能显示关键连接配置。
type CreateResponse struct {
	TaskID           string         `json:"taskId"`
	Status           TaskStatus     `json:"status"`
	ConnectionMode   ConnectionMode `json:"connectionMode,omitempty"`
	Connections      int            `json:"connections"`
	ConnectionReason string         `json:"connectionReason,omitempty"`
}

// APIError 是 Runner 和主应用客户端之间的稳定错误协议。
type APIError struct {
	Status  int    `json:"status"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Detail  string `json:"detail,omitempty"`
}

func (e *APIError) Error() string {
	if e == nil {
		return ""
	}
	if e.Detail != "" {
		return fmt.Sprintf("%s: %s", e.Code, e.Detail)
	}
	return e.Code
}

const (
	CodeInvalidRequest    = "LOADTEST_INVALID_REQUEST"
	CodeAlreadyRunning    = "LOADTEST_ALREADY_RUNNING"
	CodeNotFound          = "LOADTEST_NOT_FOUND"
	CodeRunnerFailure     = "LOADTEST_RUNNER_FAILURE"
	CodeRunnerUnavailable = "LOADTEST_RUNNER_UNAVAILABLE"
	CodeStopTimeout       = "LOADTEST_STOP_TIMEOUT"
)
