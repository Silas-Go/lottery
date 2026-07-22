package loadtest

import (
	"fmt"
	"time"
)

const (
	ExperimentCacheAsideRead = "cache-aside-read"
	MaxDurationSeconds       = 30
)

// TierID 是公开挡位的稳定标识；它不携带任何可执行参数。
type TierID string

const (
	TierVisitors    TierID = "visitors"
	TierTideEve     TierID = "tide_eve"
	TierCrowd       TierID = "crowd"
	TierBoilingCity TierID = "boiling_city"
)

// TierConfig 是 Runner 唯一信任的压测参数白名单。
// 前端只提交 TierID，RATE、CONNECTIONS 和 DURATION 只能在服务端映射，避免任意压力参数进入子进程。
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

// ResolveTier 把公开挡位 ID 转换为 Runner 内部固定参数。
func ResolveTier(id TierID) (TierConfig, bool) {
	config, ok := tierConfigs[id]
	return config, ok
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
	Experiment string `json:"experiment"`
	ArchiveID  int    `json:"archiveId"`
	Mode       string `json:"mode"`
	Tier       TierID `json:"tier"`
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
	tier, ok := ResolveTier(request.Tier)
	if !ok {
		return TierConfig{}, "tier is not supported"
	}
	if tier.DurationSeconds <= 0 || tier.DurationSeconds > MaxDurationSeconds {
		return TierConfig{}, "tier duration exceeds runner limit"
	}
	return tier, ""
}

// TaskMetrics 合并 wrk2 延迟/吞吐结果与应用已有的缓存、SQL 指标。
type TaskMetrics struct {
	ActualRequests int64   `json:"actualRequests"`
	ActualQPS      float64 `json:"actualQps"`
	P50MS          float64 `json:"p50Ms"`
	P95MS          float64 `json:"p95Ms"`
	P99MS          float64 `json:"p99Ms"`
	ErrorRate      float64 `json:"errorRate"`
	Timeouts       int64   `json:"timeouts"`
	RedisHits      int64   `json:"redisHits"`
	MySQLFallbacks int64   `json:"mysqlFallbacks"`
	SQLQueries     int64   `json:"sqlQueries"`
	CacheHitRate   float64 `json:"cacheHitRate"`
	PoolPeak       int64   `json:"poolPeak"`
	PoolCapacity   int64   `json:"poolCapacity"`
}

// TaskLog 只保存任务级关键事件，不保存逐请求日志。
type TaskLog struct {
	At      time.Time `json:"at"`
	Level   string    `json:"level"`
	Message string    `json:"message"`
}

// Task 是页面查询和 SSE 恢复使用的权威任务快照。
type Task struct {
	ID               string      `json:"taskId"`
	Experiment       string      `json:"experiment"`
	ArchiveID        int         `json:"archiveId"`
	Mode             string      `json:"mode"`
	Tier             TierConfig  `json:"tier"`
	Status           TaskStatus  `json:"status"`
	CreatedAt        time.Time   `json:"createdAt"`
	StartedAt        *time.Time  `json:"startedAt,omitempty"`
	EndedAt          *time.Time  `json:"endedAt,omitempty"`
	ElapsedSeconds   int         `json:"elapsedSeconds"`
	RemainingSeconds int         `json:"remainingSeconds"`
	Metrics          TaskMetrics `json:"metrics"`
	ErrorCode        string      `json:"errorCode,omitempty"`
	ErrorMessage     string      `json:"errorMessage,omitempty"`
	Logs             []TaskLog   `json:"logs"`
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

// CreateResponse 是异步创建任务后的最小响应。
type CreateResponse struct {
	TaskID string     `json:"taskId"`
	Status TaskStatus `json:"status"`
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
