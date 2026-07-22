package loadtest

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxStoredTasks  = 24
	maxStoredEvents = 180
	maxTaskLogs     = 32
)

type RunnerOptions struct {
	AppBaseURL string
	StatePath  string
	Wrk2Path   string
	ScriptPath string
}

type taskRecord struct {
	Task        Task
	Events      []Event
	NextEventID int64
	Cancel      context.CancelFunc
	Command     *exec.Cmd
	Done        chan struct{}
	Subscribers map[chan Event]struct{}
}

type persistedRecord struct {
	Task        Task    `json:"task"`
	Events      []Event `json:"events"`
	NextEventID int64   `json:"nextEventId"`
}

type persistedState struct {
	Records []persistedRecord `json:"records"`
}

// Runner 持有唯一 wrk2 子进程、任务状态和 SSE 订阅者。
// 单任务锁位于 Runner 而不是浏览器或主应用，因此多个页面并发点击也只能启动一个真实压测。
type Runner struct {
	mu         sync.Mutex
	records    map[string]*taskRecord
	order      []string
	activeID   string
	appBaseURL string
	statePath  string
	wrk2Path   string
	scriptPath string
	httpClient *http.Client
}

// NewRunner 创建常驻压测执行器并恢复磁盘状态。
// 如果上次进程退出时任务仍是 running 等活动状态，启动时会将其标记为 failed，避免永久占住运行锁。
func NewRunner(options RunnerOptions) (*Runner, error) {
	runner := &Runner{
		records:    make(map[string]*taskRecord),
		appBaseURL: strings.TrimRight(defaultString(options.AppBaseURL, "http://app:5678"), "/"),
		statePath:  defaultString(options.StatePath, "/var/lib/loadtest-runner/tasks.json"),
		wrk2Path:   defaultString(options.Wrk2Path, "/usr/local/bin/wrk2"),
		scriptPath: defaultString(options.ScriptPath, "/opt/wrk2/scripts/read.lua"),
		httpClient: &http.Client{Timeout: 5 * time.Second},
	}
	if err := runner.loadState(); err != nil {
		return nil, err
	}
	return runner, nil
}

// Start 校验白名单输入并异步启动任务，HTTP 请求结束不会取消压测。
func (r *Runner) Start(request CreateRequest) (Task, *APIError) {
	tier, validationMessage := ValidateCreateRequest(request)
	if validationMessage != "" {
		return Task{}, apiError(http.StatusBadRequest, CodeInvalidRequest, "压测请求不符合白名单", validationMessage)
	}

	r.mu.Lock()
	if active := r.records[r.activeID]; active != nil && active.Task.Status.Active() {
		r.mu.Unlock()
		return Task{}, apiError(http.StatusConflict, CodeAlreadyRunning, "已有压测正在运行", active.Task.ID)
	}

	now := time.Now().UTC()
	id := newTaskID(now)
	// 任务不绑定创建它的 HTTP 请求，但仍有 Runner 级硬超时。
	// 固定挡位最多运行 30 秒，额外 10 秒只留给重置和结果收集，避免异常 wrk2 永久占用单任务锁。
	runContext, cancel := context.WithTimeout(context.Background(), time.Duration(tier.DurationSeconds+10)*time.Second)
	record := &taskRecord{
		Task: Task{
			ID:               id,
			Experiment:       request.Experiment,
			ArchiveID:        request.ArchiveID,
			Mode:             request.Mode,
			Tier:             tier,
			Status:           StatusStarting,
			CreatedAt:        now,
			RemainingSeconds: tier.DurationSeconds,
		},
		Cancel:      cancel,
		Done:        make(chan struct{}),
		Subscribers: make(map[chan Event]struct{}),
	}
	r.records[id] = record
	r.order = append(r.order, id)
	r.activeID = id
	r.appendLogLocked(record, "info", "准备实验")
	r.publishLocked(record, EventTaskStarted, "压测任务已创建，正在准备实验", nil)
	r.pruneLocked()
	r.persistLocked()
	task := cloneTask(record.Task)
	r.mu.Unlock()

	slog.Info("loadtest task created", "task_id", id, "archive_id", request.ArchiveID, "mode", request.Mode, "tier", request.Tier)
	go r.runTask(runContext, id)
	return task, nil
}

// Get 返回任务权威快照，供页面首次加载和 SSE 断线恢复。
func (r *Runner) Get(id string) (Task, *APIError) {
	r.mu.Lock()
	defer r.mu.Unlock()
	record := r.records[id]
	if record == nil {
		return Task{}, apiError(http.StatusNotFound, CodeNotFound, "压测任务不存在", id)
	}
	r.updateClockLocked(record, time.Now().UTC())
	return cloneTask(record.Task), nil
}

// Stop 取消任务并等待 wrk2 进程退出；返回成功时子进程已经被回收。
func (r *Runner) Stop(id string) (Task, *APIError) {
	r.mu.Lock()
	record := r.records[id]
	if record == nil {
		r.mu.Unlock()
		return Task{}, apiError(http.StatusNotFound, CodeNotFound, "压测任务不存在", id)
	}
	if record.Task.Status.Terminal() {
		task := cloneTask(record.Task)
		r.mu.Unlock()
		return task, nil
	}
	cancel := record.Cancel
	done := record.Done
	r.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	select {
	case <-done:
		return r.Get(id)
	case <-time.After(5 * time.Second):
		return Task{}, apiError(http.StatusGatewayTimeout, CodeStopTimeout, "停止压测超时", id)
	}
}

// Subscribe 返回 Last-Event-ID 之后的历史事件和实时事件通道。
// 页面连接中断时不会影响任务，重连后可先回放再继续接收。
func (r *Runner) Subscribe(id string, lastEventID int64) ([]Event, <-chan Event, func(), *APIError) {
	r.mu.Lock()
	record := r.records[id]
	if record == nil {
		r.mu.Unlock()
		return nil, nil, nil, apiError(http.StatusNotFound, CodeNotFound, "压测任务不存在", id)
	}
	replay := make([]Event, 0, len(record.Events))
	for _, event := range record.Events {
		if event.ID > lastEventID {
			replay = append(replay, event)
		}
	}
	channel := make(chan Event, 32)
	record.Subscribers[channel] = struct{}{}
	r.mu.Unlock()

	unsubscribe := func() {
		r.mu.Lock()
		if current := r.records[id]; current != nil {
			delete(current.Subscribers, channel)
		}
		r.mu.Unlock()
	}
	return replay, channel, unsubscribe, nil
}

func (r *Runner) runTask(taskContext context.Context, id string) {
	defer func() {
		if recovered := recover(); recovered != nil {
			r.finish(id, StatusFailed, CodeRunnerFailure, fmt.Sprintf("Runner 异常：%v", recovered), EventFailed)
		}
	}()

	if !r.transition(id, StatusResetting, "正在重置缓存与章节指标") {
		return
	}
	if err := r.resetChapter(taskContext); err != nil {
		if taskContext.Err() != nil {
			r.finishContextEnd(id, taskContext, "重置阶段")
			return
		}
		r.finish(id, StatusFailed, CodeRunnerFailure, "重置数据失败："+err.Error(), EventFailed)
		return
	}
	r.emitStep(id, EventResetCompleted, "数据重置完成", "success")

	task, taskErr := r.Get(id)
	if taskErr != nil {
		return
	}
	targetURL := fmt.Sprintf("%s/api/archives/%d/%s", r.appBaseURL, task.ArchiveID, task.Mode)
	// Cache-Aside 命中时延可低于 2ms。wrk2 上游在多线程共享极低延迟直方图时会偶发
	// counts_index 断言崩溃；单线程仍能用 96 条连接稳定产生 3000 req/s，且避免该采样器缺陷。
	// 这里的线程数同样是 Runner 固定参数，前端不能覆盖。
	threads := 1
	args := []string{
		"-t" + strconv.Itoa(threads),
		"-c" + strconv.Itoa(task.Tier.Connections),
		"-d" + strconv.Itoa(task.Tier.DurationSeconds) + "s",
		"-R" + strconv.Itoa(task.Tier.Rate),
		"--latency",
		"--timeout", "2s",
		"-s", r.scriptPath,
		targetURL,
	}
	command := exec.Command(r.wrk2Path, args...)
	configureProcess(command)
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Start(); err != nil {
		if taskContext.Err() != nil {
			r.finishContextEnd(id, taskContext, "启动阶段")
			return
		}
		r.finish(id, StatusFailed, CodeRunnerFailure, "wrk2 启动失败："+err.Error(), EventFailed)
		return
	}

	r.mu.Lock()
	if record := r.records[id]; record != nil {
		now := time.Now().UTC()
		record.Command = command
		record.Task.Status = StatusRunning
		record.Task.StartedAt = &now
		r.updateClockLocked(record, now)
		r.appendLogLocked(record, "info", "wrk2 已启动")
		r.publishLocked(record, EventLoadtestStarted, "wrk2 已启动", nil)
		r.persistLocked()
	}
	r.mu.Unlock()

	waitChannel := make(chan error, 1)
	go func() { waitChannel <- command.Wait() }()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	targetRateLogged := false

	for {
		select {
		case <-taskContext.Done():
			terminateProcess(command)
			<-waitChannel
			if errors.Is(taskContext.Err(), context.DeadlineExceeded) {
				r.finish(id, StatusFailed, CodeRunnerFailure, "压测超过 Runner 硬超时，wrk2 子进程已回收", EventFailed)
			} else {
				r.finish(id, StatusStopped, "", "压测已停止，wrk2 子进程已回收", EventStopped)
			}
			return
		case waitErr := <-waitChannel:
			if waitErr != nil {
				message := "wrk2 异常退出：" + waitErr.Error()
				if tail := outputTail(output.String(), 600); tail != "" {
					message += "；" + tail
				}
				r.finish(id, StatusFailed, CodeRunnerFailure, message, EventFailed)
				return
			}
			r.collectAndComplete(taskContext, id, output.String())
			return
		case now := <-ticker.C:
			metrics, err := r.fetchAppMetrics(taskContext, task.Mode)
			if err == nil {
				r.updateProgress(id, now.UTC(), metrics)
				if !targetRateLogged && metrics.ActualQPS >= float64(task.Tier.Rate)*0.9 {
					targetRateLogged = true
					r.emitStep(id, EventLog, "已达到目标速率", "success")
				}
			}
		}
	}
}

func (r *Runner) collectAndComplete(taskContext context.Context, id, output string) {
	if !r.transition(id, StatusCollecting, "wrk2 已结束，正在收集结果") {
		return
	}
	if taskContext.Err() != nil {
		r.finishContextEnd(id, taskContext, "结果收集阶段")
		return
	}
	task, taskErr := r.Get(id)
	if taskErr != nil {
		return
	}
	parsed := parseWrkOutput(output)
	metrics, metricsErr := r.fetchAppMetrics(taskContext, task.Mode)
	if metricsErr != nil {
		r.finish(id, StatusFailed, CodeRunnerFailure, "指标收集失败："+metricsErr.Error(), EventFailed)
		return
	}
	if parsed.Requests <= 0 {
		r.finish(id, StatusFailed, CodeRunnerFailure, "wrk2 未产生有效请求", EventFailed)
		return
	}
	metrics.ActualRequests = parsed.Requests
	metrics.ActualQPS = parsed.QPS
	metrics.DurationSeconds = parsed.Duration
	metrics.P50MS = parsed.P50MS
	metrics.P90MS = parsed.P90MS
	metrics.P95MS = parsed.P95MS
	metrics.P99MS = parsed.P99MS
	metrics.Timeouts = parsed.Timeouts
	metrics.ErrorRate = float64(parsed.ErrorCount) * 100 / float64(parsed.Requests)

	r.mu.Lock()
	if record := r.records[id]; record != nil && record.Task.Status == StatusCollecting {
		record.Task.Metrics = metrics
		r.appendLogLocked(record, "info", "wrk2 结束")
		if parsed.Timeouts > 0 || parsed.ErrorCount > 0 {
			r.appendLogLocked(record, "warning", fmt.Sprintf("检测到 %d 个错误，其中超时 %d 个", parsed.ErrorCount, parsed.Timeouts))
		}
		r.appendLogLocked(record, "success", "指标解析完成")
		r.persistLocked()
	}
	r.mu.Unlock()
	r.finish(id, StatusCompleted, "", "压测完成，结果已冻结", EventCompleted)
}

func (r *Runner) finishContextEnd(id string, ctx context.Context, stage string) {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		r.finish(id, StatusFailed, CodeRunnerFailure, "压测在"+stage+"超过 Runner 硬超时", EventFailed)
		return
	}
	r.finish(id, StatusStopped, "", "压测已在"+stage+"停止", EventStopped)
}

func (r *Runner) resetChapter(ctx context.Context) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, r.appBaseURL+"/api/chapters/cache-aside/reset", nil)
	if err != nil {
		return err
	}
	response, err := r.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("reset returned HTTP %d", response.StatusCode)
	}
	return nil
}

type archiveMetricPath struct {
	TotalRequests int64 `json:"totalRequests"`
	QPS           int64 `json:"qps"`
	SQLQueries    int64 `json:"sqlQueries"`
	CacheHits     int64 `json:"cacheHits"`
	CacheMisses   int64 `json:"cacheMisses"`
	CacheHitRate  int64 `json:"cacheHitRate"`
	Errors        int64 `json:"errors"`
	P95           int64 `json:"p95"`
	P99           int64 `json:"p99"`
	PoolPeak      int64 `json:"poolPeak"`
	PoolCapacity  int64 `json:"poolCapacity"`
}

func (r *Runner) fetchAppMetrics(ctx context.Context, mode string) (TaskMetrics, error) {
	requestContext, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodGet, r.appBaseURL+"/api/metrics/snapshot", nil)
	if err != nil {
		return TaskMetrics{}, err
	}
	response, err := r.httpClient.Do(request)
	if err != nil {
		return TaskMetrics{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return TaskMetrics{}, fmt.Errorf("metrics returned HTTP %d", response.StatusCode)
	}
	var snapshot struct {
		ArchiveRead struct {
			Direct archiveMetricPath `json:"direct"`
			Cached archiveMetricPath `json:"cached"`
		} `json:"archiveRead"`
	}
	if err := json.NewDecoder(response.Body).Decode(&snapshot); err != nil {
		return TaskMetrics{}, err
	}
	path := snapshot.ArchiveRead.Direct
	if mode == "cached" {
		path = snapshot.ArchiveRead.Cached
	}
	mysqlFallbacks := path.TotalRequests
	if mode == "cached" {
		mysqlFallbacks = path.CacheMisses
	}
	errorRate := float64(0)
	if path.TotalRequests > 0 {
		errorRate = float64(path.Errors) * 100 / float64(path.TotalRequests)
	}
	return TaskMetrics{
		ActualRequests: path.TotalRequests,
		ActualQPS:      float64(path.QPS),
		P95MS:          float64(path.P95),
		P99MS:          float64(path.P99),
		ErrorRate:      errorRate,
		RedisHits:      path.CacheHits,
		MySQLFallbacks: mysqlFallbacks,
		SQLQueries:     path.SQLQueries,
		CacheHitRate:   float64(path.CacheHitRate),
		PoolPeak:       path.PoolPeak,
		PoolCapacity:   path.PoolCapacity,
	}, nil
}

func (r *Runner) transition(id string, next TaskStatus, message string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	record := r.records[id]
	if record == nil || !validTransition(record.Task.Status, next) {
		return false
	}
	record.Task.Status = next
	r.updateClockLocked(record, time.Now().UTC())
	if message != "" {
		r.appendLogLocked(record, "info", message)
		r.publishLocked(record, EventLog, message, nil)
	}
	r.persistLocked()
	return true
}

func validTransition(current, next TaskStatus) bool {
	if next == StatusFailed || next == StatusStopped {
		return current.Active()
	}
	switch current {
	case StatusStarting:
		return next == StatusResetting
	case StatusResetting:
		return next == StatusRunning
	case StatusRunning:
		return next == StatusCollecting
	case StatusCollecting:
		return next == StatusCompleted
	default:
		return false
	}
}

func (r *Runner) updateProgress(id string, now time.Time, metrics TaskMetrics) {
	r.mu.Lock()
	defer r.mu.Unlock()
	record := r.records[id]
	if record == nil || record.Task.Status != StatusRunning {
		return
	}
	record.Task.Metrics = metrics
	r.updateClockLocked(record, now)
	r.publishLocked(record, EventProgress, "压测运行中", nil)
	r.publishLocked(record, EventMetric, "实时指标更新", &metrics)
	r.persistLocked()
}

func (r *Runner) emitStep(id string, eventType EventType, message, level string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	record := r.records[id]
	if record == nil || record.Task.Status.Terminal() {
		return
	}
	r.appendLogLocked(record, level, message)
	r.publishLocked(record, eventType, message, nil)
	r.persistLocked()
}

func (r *Runner) finish(id string, status TaskStatus, code, message string, eventType EventType) {
	r.mu.Lock()
	defer r.mu.Unlock()
	record := r.records[id]
	if record == nil || record.Task.Status.Terminal() || !validTransition(record.Task.Status, status) {
		return
	}
	now := time.Now().UTC()
	record.Task.Status = status
	record.Task.EndedAt = &now
	record.Task.ErrorCode = code
	if status == StatusFailed {
		record.Task.ErrorMessage = message
		r.appendLogLocked(record, "error", message)
	} else {
		r.appendLogLocked(record, "success", message)
	}
	r.updateClockLocked(record, now)
	r.publishLocked(record, eventType, message, &record.Task.Metrics)
	record.Command = nil
	record.Cancel = nil
	if r.activeID == id {
		r.activeID = ""
	}
	r.persistLocked()
	close(record.Done)
	slog.Info("loadtest task finished", "task_id", id, "status", status, "error_code", code)
}

func (r *Runner) updateClockLocked(record *taskRecord, now time.Time) {
	startedAt := record.Task.CreatedAt
	if record.Task.StartedAt != nil {
		startedAt = *record.Task.StartedAt
	}
	end := now
	if record.Task.EndedAt != nil {
		end = *record.Task.EndedAt
	}
	elapsed := int(end.Sub(startedAt).Seconds())
	if elapsed < 0 {
		elapsed = 0
	}
	record.Task.ElapsedSeconds = elapsed
	remaining := record.Task.Tier.DurationSeconds - elapsed
	if remaining < 0 {
		remaining = 0
	}
	record.Task.RemainingSeconds = remaining
}

func (r *Runner) appendLogLocked(record *taskRecord, level, message string) {
	record.Task.Logs = append(record.Task.Logs, TaskLog{At: time.Now().UTC(), Level: level, Message: message})
	if len(record.Task.Logs) > maxTaskLogs {
		record.Task.Logs = append([]TaskLog(nil), record.Task.Logs[len(record.Task.Logs)-maxTaskLogs:]...)
	}
}

func (r *Runner) publishLocked(record *taskRecord, eventType EventType, message string, metrics *TaskMetrics) {
	record.NextEventID++
	event := Event{
		ID:               record.NextEventID,
		Type:             eventType,
		TaskID:           record.Task.ID,
		At:               time.Now().UTC(),
		Status:           record.Task.Status,
		Message:          message,
		ElapsedSeconds:   record.Task.ElapsedSeconds,
		RemainingSeconds: record.Task.RemainingSeconds,
		Metrics:          metrics,
	}
	record.Events = append(record.Events, event)
	if len(record.Events) > maxStoredEvents {
		record.Events = append([]Event(nil), record.Events[len(record.Events)-maxStoredEvents:]...)
	}
	for subscriber := range record.Subscribers {
		select {
		case subscriber <- event:
		default:
		}
	}
}

func (r *Runner) loadState() error {
	data, err := os.ReadFile(r.statePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read loadtest state: %w", err)
	}
	var state persistedState
	if err := json.Unmarshal(data, &state); err != nil {
		return fmt.Errorf("decode loadtest state: %w", err)
	}
	now := time.Now().UTC()
	for _, persisted := range state.Records {
		record := &taskRecord{
			Task:        persisted.Task,
			Events:      persisted.Events,
			NextEventID: persisted.NextEventID,
			Done:        make(chan struct{}),
			Subscribers: make(map[chan Event]struct{}),
		}
		if record.Task.Status.Active() {
			record.Task.Status = StatusFailed
			record.Task.EndedAt = &now
			record.Task.ErrorCode = CodeRunnerFailure
			record.Task.ErrorMessage = "Runner 重启时发现未结束任务，已标记失败"
			r.appendLogLocked(record, "error", record.Task.ErrorMessage)
			r.updateClockLocked(record, now)
			r.publishLocked(record, EventFailed, record.Task.ErrorMessage, &record.Task.Metrics)
		}
		close(record.Done)
		r.records[record.Task.ID] = record
		r.order = append(r.order, record.Task.ID)
	}
	r.mu.Lock()
	r.pruneLocked()
	r.persistLocked()
	r.mu.Unlock()
	return nil
}

func (r *Runner) persistLocked() {
	state := persistedState{Records: make([]persistedRecord, 0, len(r.order))}
	for _, id := range r.order {
		record := r.records[id]
		if record == nil {
			continue
		}
		state.Records = append(state.Records, persistedRecord{
			Task:        cloneTask(record.Task),
			Events:      append([]Event(nil), record.Events...),
			NextEventID: record.NextEventID,
		})
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		slog.Error("encode loadtest state failed", "error", err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(r.statePath), 0o755); err != nil {
		slog.Error("create loadtest state directory failed", "error", err)
		return
	}
	// 先写同目录临时文件再原子替换，避免容器在写入中途退出后留下半截 JSON，
	// 否则下次启动无法识别并清理遗留 running 任务。
	temporaryPath := r.statePath + ".tmp"
	if err := os.WriteFile(temporaryPath, data, 0o600); err != nil {
		slog.Error("persist loadtest state failed", "error", err)
		return
	}
	if err := os.Rename(temporaryPath, r.statePath); err != nil {
		// Runner 容器使用 Linux，可原子覆盖；Windows 分支仅服务于本机单元测试，
		// Windows Rename 不能覆盖已存在目标，因此先删除旧快照再重命名。
		if runtime.GOOS != "windows" {
			slog.Error("replace loadtest state failed", "error", err)
			return
		}
		if removeErr := os.Remove(r.statePath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			slog.Error("remove previous loadtest state failed", "error", removeErr)
			return
		}
		if renameErr := os.Rename(temporaryPath, r.statePath); renameErr != nil {
			slog.Error("replace loadtest state failed", "error", renameErr)
		}
	}
}

func (r *Runner) pruneLocked() {
	for len(r.order) > maxStoredTasks {
		id := r.order[0]
		record := r.records[id]
		if record != nil && record.Task.Status.Active() {
			return
		}
		delete(r.records, id)
		r.order = r.order[1:]
	}
}

func cloneTask(task Task) Task {
	clone := task
	clone.Logs = append([]TaskLog(nil), task.Logs...)
	return clone
}

func apiError(status int, code, message, detail string) *APIError {
	return &APIError{Status: status, Code: code, Message: message, Detail: detail}
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func newTaskID(now time.Time) string {
	random := make([]byte, 4)
	if _, err := rand.Read(random); err != nil {
		return fmt.Sprintf("lt-%d", now.UnixNano())
	}
	return fmt.Sprintf("lt-%d-%s", now.UnixMilli(), hex.EncodeToString(random))
}

func outputTail(output string, limit int) string {
	output = strings.Join(strings.Fields(output), " ")
	if len(output) <= limit {
		return output
	}
	return output[len(output)-limit:]
}
