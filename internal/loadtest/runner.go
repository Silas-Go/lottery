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
	"math"
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
	maxStoredTasks         = 24
	maxStoredEvents        = 180
	maxTaskLogs            = 32
	autoConnectionHeadroom = 1.25
	unknownReadPathP95MS   = 200
)

var autoConnectionOptions = [...]int{70, 140, 300, 500}

func plannedRequestsFor(experiment string) int {
	if experiment == ExperimentSeckillStockBurst {
		return SeckillStockRequests
	}
	return 0
}

func concurrencyFor(experiment string) int {
	if experiment == ExperimentSeckillStockBurst {
		return SeckillStockConcurrency
	}
	return 0
}

func isArchiveScenarioExperiment(experiment string) bool {
	return experiment == ExperimentCacheBreakdown || experiment == ExperimentCachePenetration
}

func controlledArchiveScenarioConnections(rate int) int {
	switch rate {
	case 100:
		return 70
	case 300:
		return 140
	case 800:
		return 300
	default:
		return 500
	}
}

type RunnerOptions struct {
	AppBaseURL string
	StatePath  string
	Wrk2Path   string
	ScriptPath string
}

type taskRecord struct {
	Task         Task
	Events       []Event
	NextEventID  int64
	Cancel       context.CancelFunc
	Command      *exec.Cmd
	Done         chan struct{}
	Subscribers  map[chan Event]struct{}
	ControlToken string
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

// PlanConnections 使用与 Start 完全相同的历史数据和自动估算器返回只读预估。
// 预估不会创建任务或启动 wrk2；真正执行时仍以 Start 返回的最终 -c 为准。
func (r *Runner) PlanConnections(request CreateRequest) (ConnectionPlanResponse, *APIError) {
	tier, validationMessage := ValidateCreateRequest(request)
	if validationMessage != "" {
		return ConnectionPlanResponse{}, apiError(
			http.StatusBadRequest,
			CodeInvalidRequest,
			"压测请求不符合白名单",
			validationMessage,
		)
	}

	connectionMode := request.ConnectionMode
	reason := "旧协议固定配置"
	if request.Experiment == ExperimentSeckillRateLimit {
		connectionMode = ConnectionModeAuto
		reason = "限流探针固定通路，避免连接配置成为额外变量"
	} else if request.Experiment == ExperimentSeckillStockBurst {
		connectionMode = ConnectionModeAuto
		reason = "定量并发批次固定 600 个唯一请求同时起跑"
	} else if request.Rate > 0 {
		if connectionMode == "" {
			connectionMode = ConnectionModeAuto
		}
		if connectionMode == ConnectionModeManual {
			tier.Connections = request.Connections
			reason = "用户手动指定"
		} else if isArchiveScenarioExperiment(request.Experiment) {
			tier.Connections = controlledArchiveScenarioConnections(tier.Rate)
			reason = "受控缓存场景固定通路，保证前后对比一致"
		} else {
			r.mu.Lock()
			tier.Connections, reason = r.resolveAutoConnectionsLocked(request, tier.Rate)
			r.mu.Unlock()
		}
	}
	return ConnectionPlanResponse{
		Rate:           tier.Rate,
		ConnectionMode: connectionMode,
		Connections:    tier.Connections,
		Reason:         reason,
	}, nil
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

	connectionMode := request.ConnectionMode
	requestedConnections := 0
	connectionLog := ""
	connectionReason := ""
	if request.Experiment == ExperimentSeckillRateLimit {
		connectionMode = ConnectionModeAuto
		connectionReason = "限流探针固定 70 条通路"
		connectionLog = fmt.Sprintf("配置 wrk2 -c %d（固定限流探针）", tier.Connections)
	} else if request.Experiment == ExperimentSeckillStockBurst {
		connectionMode = ConnectionModeAuto
		connectionReason = "定量并发批次固定 600 个唯一请求同时起跑"
		connectionLog = "配置 600 个唯一用户并发争抢 300 份星髓"
	} else if request.Rate > 0 {
		if connectionMode == "" {
			connectionMode = ConnectionModeAuto
		}
		if connectionMode == ConnectionModeManual {
			requestedConnections = request.Connections
			tier.Connections = request.Connections
			connectionReason = "用户手动指定"
			connectionLog = fmt.Sprintf("配置 wrk2 -c %d（手动指定）", tier.Connections)
		} else if isArchiveScenarioExperiment(request.Experiment) {
			tier.Connections = controlledArchiveScenarioConnections(tier.Rate)
			connectionReason = "受控缓存场景固定通路，保证前后对比一致"
			connectionLog = fmt.Sprintf("配置 wrk2 -c %d（场景固定）", tier.Connections)
		} else {
			tier.Connections, connectionReason = r.resolveAutoConnectionsLocked(request, tier.Rate)
			connectionLog = fmt.Sprintf("配置 wrk2 -c %d（自动）：%s", tier.Connections, connectionReason)
		}
	}

	now := time.Now().UTC()
	id := newTaskID(now)
	// 任务不绑定创建它的 HTTP 请求，但仍有 Runner 级硬超时。
	// 固定挡位最多运行 30 秒，额外 10 秒只留给重置和结果收集，避免异常 wrk2 永久占用单任务锁。
	runContext, cancel := context.WithTimeout(context.Background(), time.Duration(tier.DurationSeconds+10)*time.Second)
	controlToken := ""
	if isArchiveScenarioExperiment(request.Experiment) {
		controlToken = newTaskToken()
	}
	probeArchiveID := 0
	if request.Experiment == ExperimentCachePenetration {
		probeArchiveID = CachePenetrationMissingID
	}
	record := &taskRecord{
		Task: Task{
			ID:                   id,
			Experiment:           request.Experiment,
			ArchiveID:            request.ArchiveID,
			Mode:                 request.Mode,
			Protection:           request.Protection,
			ProbeArchiveID:       probeArchiveID,
			Tier:                 tier,
			ConnectionMode:       connectionMode,
			RequestedConnections: requestedConnections,
			ConnectionReason:     connectionReason,
			PlannedRequests:      plannedRequestsFor(request.Experiment),
			Concurrency:          concurrencyFor(request.Experiment),
			Status:               StatusStarting,
			CreatedAt:            now,
			RemainingSeconds:     tier.DurationSeconds,
		},
		Cancel:       cancel,
		Done:         make(chan struct{}),
		Subscribers:  make(map[chan Event]struct{}),
		ControlToken: controlToken,
	}
	r.records[id] = record
	r.order = append(r.order, id)
	r.activeID = id
	r.appendLogLocked(record, "info", "准备实验")
	if connectionLog != "" {
		r.appendLogLocked(record, "info", connectionLog)
	}
	r.publishLocked(record, EventTaskStarted, "压测任务已创建，正在准备实验", nil)
	r.pruneLocked()
	r.persistLocked()
	task := cloneTask(record.Task)
	r.mu.Unlock()

	slog.Info(
		"loadtest task created",
		"task_id", id,
		"archive_id", request.ArchiveID,
		"mode", request.Mode,
		"target_qps", tier.Rate,
		"connections", tier.Connections,
		"connection_mode", connectionMode,
	)
	go r.runTask(runContext, id)
	return task, nil
}

// resolveAutoConnectionsLocked 根据同一份材料的历史实际请求延迟估算 Little's Law
// 所需在途请求数，再增加 25% 周转余量并落到受控通路档位。相同材料和目标速率
// 已经产生过自动任务时沿用其连接数，使 Direct 与 Cache-Aside 的对比不会因为
// 第二次运行获得了更多历史数据而偷偷改变并发条件。
func (r *Runner) resolveAutoConnectionsLocked(request CreateRequest, rate int) (int, string) {
	latencyMS, knownPaths := r.historicalRequestP95Locked(request.ArchiveID, rate)
	// 只跑过一条路径时，另一条路径必须沿用它的通路数，才能形成第一组公平对比；
	// 两条路径都有历史后则重新按较慢路径估算，让后续实验能够吸收新的真实数据，
	// 避免自动配置永久粘在第一次选择上。
	if knownPaths == 1 {
		for index := len(r.order) - 1; index >= 0; index-- {
			record := r.records[r.order[index]]
			if record == nil || record.Task.Status != StatusCompleted {
				continue
			}
			task := record.Task
			if task.ArchiveID == request.ArchiveID &&
				task.Tier.Rate == rate &&
				task.ConnectionMode == ConnectionModeAuto &&
				task.Tier.Connections > 0 &&
				ValidManualConnections(task.Tier.Connections) {
				return task.Tier.Connections, "沿用首条路径的公平对比配置"
			}
		}
	}
	if latencyMS <= 0 {
		latencyMS = unknownReadPathP95MS
	}
	// 只见过一条读取路径时，未知路径仍按 Direct 的保守基线兜底；否则先跑到的
	// Cache-Aside 低延迟会让随后 Direct 获得不够用的连接数。
	if knownPaths < 2 && latencyMS < unknownReadPathP95MS {
		latencyMS = unknownReadPathP95MS
	}
	required := int(math.Ceil(float64(rate) * latencyMS / 1000 * autoConnectionHeadroom))
	for _, connections := range autoConnectionOptions {
		if connections >= required {
			return connections, fmt.Sprintf("按历史 P95 %.1f ms 与目标 %d QPS 估算", latencyMS, rate)
		}
	}
	return autoConnectionOptions[len(autoConnectionOptions)-1],
		fmt.Sprintf("历史 P95 %.1f ms 需要更多在途请求，已使用安全上限", latencyMS)
}

// historicalRequestP95Locked 读取两条路径各自最新的真实请求 P95，并返回较慢值。
// 新任务使用 wrk2 uncorrected histogram；旧任务没有该字段时，仅在未达目标速率时
// 用 connections/actualQPS 估算在途占用时间，避免把 corrected 发送欠账误当 SQL 延迟。
func (r *Runner) historicalRequestP95Locked(archiveID, rate int) (float64, int) {
	latestByMode := make(map[string]float64, 2)
	collect := func(exactRate bool) {
		for index := len(r.order) - 1; index >= 0 && len(latestByMode) < 2; index-- {
			record := r.records[r.order[index]]
			if record == nil || record.Task.Status != StatusCompleted {
				continue
			}
			task := record.Task
			if task.ArchiveID != archiveID || (exactRate && task.Tier.Rate != rate) {
				continue
			}
			if _, exists := latestByMode[task.Mode]; exists {
				continue
			}
			if latencyMS := historicalTaskRequestP95(task); latencyMS > 0 {
				latestByMode[task.Mode] = latencyMS
			}
		}
	}
	collect(true)
	if len(latestByMode) == 0 {
		collect(false)
	}
	slowest := float64(0)
	for _, latencyMS := range latestByMode {
		if latencyMS > slowest {
			slowest = latencyMS
		}
	}
	return slowest, len(latestByMode)
}

func historicalTaskRequestP95(task Task) float64 {
	latencyMS := task.Metrics.RequestP95MS
	completionRate := task.Metrics.ActualQPS / float64(task.Tier.Rate)
	if task.Metrics.ActualQPS > 0 && task.Tier.Rate > 0 &&
		(completionRate < .9 || task.Metrics.SocketErrors > 0) &&
		task.Tier.Connections > 0 {
		// 完成率不足或出现 Socket Errors 时，已完成请求的 P95 可能只代表幸存样本。
		// connections/actualQPS 给出通路的平均周转占用下界，取较大值避免低估。
		occupancyMS := float64(task.Tier.Connections) / task.Metrics.ActualQPS * 1000
		if occupancyMS > latencyMS {
			latencyMS = occupancyMS
		}
	}
	if latencyMS > 0 {
		return latencyMS
	}
	if task.Metrics.ActualQPS <= 0 || task.Tier.Rate <= 0 {
		return 0
	}
	if completionRate >= .9 && task.Metrics.P95MS > 0 {
		return task.Metrics.P95MS
	}
	if task.Tier.Connections > 0 {
		return float64(task.Tier.Connections) / task.Metrics.ActualQPS * 1000
	}
	return 0
}

func targetCompletionRate(actualQPS float64, targetQPS int) float64 {
	if actualQPS <= 0 || targetQPS <= 0 {
		return 0
	}
	rate := actualQPS * 100 / float64(targetQPS)
	if rate > 100 {
		return 100
	}
	return rate
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

	task, taskErr := r.Get(id)
	if taskErr != nil {
		return
	}
	controlToken := r.taskControlToken(id)
	resetMessage := "正在重置缓存与章节指标"
	if isArchiveScenarioExperiment(task.Experiment) {
		resetMessage = "正在建立任务级缓存场景"
	} else if task.Experiment != ExperimentCacheAsideRead {
		resetMessage = "正在重置秒杀库存、订单、令牌桶与指标"
	}
	if !r.transition(id, StatusResetting, resetMessage) {
		return
	}
	if err := r.resetExperiment(taskContext, task, controlToken); err != nil {
		if taskContext.Err() != nil {
			r.finishContextEnd(id, taskContext, "重置阶段")
			return
		}
		r.finish(id, StatusFailed, CodeRunnerFailure, "重置数据失败："+err.Error(), EventFailed)
		return
	}
	r.emitStep(id, EventResetCompleted, "数据重置完成", "success")

	task, taskErr = r.Get(id)
	if taskErr != nil {
		return
	}
	if task.Experiment == ExperimentSeckillStockBurst {
		r.runStockBurst(taskContext, id, task)
		return
	}
	targetURL := fmt.Sprintf("%s/api/archives/%d/%s", r.appBaseURL, task.ArchiveID, task.Mode)
	requestHeaders := make([]string, 0, 1)
	if isArchiveScenarioExperiment(task.Experiment) {
		targetURL = r.appBaseURL + "/internal/cache-experiments/read"
		requestHeaders = append(requestHeaders, "X-Experiment-Token: "+controlToken)
	}
	if task.Experiment == ExperimentSeckillRateLimit {
		targetURL = r.appBaseURL + "/api/seckill/rate-limit-probe"
	}
	// 单线程让两条读取路径保持一致的调度条件；真实并发仍由 -c 持久连接承担。
	// wrk2 镜像另有单调时钟、修正延迟回退和 HDR Histogram 入参校验三层保护，
	// 因此这里不再把 -t1 当作避免上游断言崩溃的唯一可靠性边界。
	args := wrkArguments(task, r.scriptPath, targetURL, requestHeaders...)
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
	stableHitSamples := 0
	evictionTriggered := false
	rebuildReported := false
	recoveryReported := false

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
			metrics, err := r.fetchAppMetrics(taskContext, task)
			if err == nil {
				r.updateProgress(id, now.UTC(), metrics)
				if !targetRateLogged && metrics.ActualQPS >= float64(task.Tier.Rate)*0.9 {
					targetRateLogged = true
					r.emitStep(id, EventLog, "已达到目标速率", "success")
				}
				if task.Experiment == ExperimentCacheBreakdown {
					if !evictionTriggered {
						if metrics.CurrentRequests > 0 && metrics.CurrentPositiveHits > 0 &&
							metrics.CurrentRedisMisses == 0 && metrics.CurrentHitRate >= 99 {
							stableHitSamples++
						} else {
							stableHitSamples = 0
						}
						if stableHitSamples >= 2 {
							state, injectErr := r.evictArchiveExperiment(taskContext, controlToken)
							if injectErr != nil {
								terminateProcess(command)
								<-waitChannel
								r.finish(id, StatusFailed, CodeRunnerFailure, "热点 Key 失效注入失败："+injectErr.Error(), EventFailed)
								return
							}
							evictionTriggered = true
							r.emitStep(id, EventCacheEvicted, "热点 Key 已真实删除："+state.At, "warning")
						}
					} else {
						if !rebuildReported && metrics.CacheRebuilds > 0 && metrics.RebuiltAt != "" {
							rebuildReported = true
							r.emitStep(id, EventCacheRebuilt, "热点缓存已由真实 MySQL 回源重建", "success")
						}
						if !recoveryReported && metrics.RecoveryDurationMS > 0 && metrics.StableAt != "" {
							recoveryReported = true
							r.emitStep(id, EventCacheRecovered, "命中率已经恢复稳定", "success")
						}
					}
				}
			}
		}
	}
}

func wrkArguments(task Task, scriptPath, targetURL string, headers ...string) []string {
	const threads = 1
	args := []string{
		"-t" + strconv.Itoa(threads),
		"-c" + strconv.Itoa(task.Tier.Connections),
		"-d" + strconv.Itoa(task.Tier.DurationSeconds) + "s",
		"-R" + strconv.Itoa(task.Tier.Rate),
		"--latency",
		"--u_latency",
		"--timeout", "2s",
		"-s", scriptPath,
		targetURL,
	}
	if len(headers) == 0 {
		return args
	}
	// wrk2 要求 Header 参数位于目标 URL 前；保持 URL 为最后一个参数。
	url := args[len(args)-1]
	args = args[:len(args)-1]
	for _, header := range headers {
		args = append(args, "-H", header)
	}
	return append(args, url)
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
	metrics, metricsErr := r.fetchAppMetrics(taskContext, task)
	if metricsErr != nil {
		r.finish(id, StatusFailed, CodeRunnerFailure, "指标收集失败："+metricsErr.Error(), EventFailed)
		return
	}
	if parsed.Requests <= 0 {
		r.finish(id, StatusFailed, CodeRunnerFailure, "wrk2 未产生有效请求", EventFailed)
		return
	}
	if parsed.P50MS <= 0 || parsed.RequestP50MS <= 0 {
		r.finish(id, StatusFailed, CodeRunnerFailure, "wrk2 未返回完整的 corrected / uncorrected 延迟直方图", EventFailed)
		return
	}
	metrics.ActualRequests = parsed.Requests
	metrics.ActualQPS = parsed.QPS
	metrics.DurationSeconds = parsed.Duration
	metrics.P50MS = parsed.P50MS
	metrics.P90MS = parsed.P90MS
	metrics.P95MS = parsed.P95MS
	metrics.P99MS = parsed.P99MS
	metrics.RequestP50MS = parsed.RequestP50MS
	metrics.RequestP90MS = parsed.RequestP90MS
	metrics.RequestP95MS = parsed.RequestP95MS
	metrics.RequestP99MS = parsed.RequestP99MS
	metrics.TargetCompletionRate = targetCompletionRate(parsed.QPS, task.Tier.Rate)
	metrics.Timeouts = parsed.Timeouts
	metrics.SocketErrors = parsed.SocketErrors
	metrics.LatencyScheduleFallbacks = parsed.LatencyScheduleFallbacks
	metrics.LatencySamplesDropped = parsed.LatencySamplesDropped
	// Socket Errors 是连接层事件计数，可能与请求不是一一对应，因此必须单列；
	// ErrorRate 只使用收到 HTTP 响应后的 non-2xx/3xx 数量，避免复合计数超过 100%。
	if task.Experiment == ExperimentSeckillRateLimit {
		// 限流结论以应用探针闭合的 allowed+limited 为权威请求总数。
		// wrk2 结束边界可能仍有极少量已到达应用但未进入自身汇总的响应，若混用两个总数会出现
		// “放行数大于请求数”的假矛盾；延迟直方图仍使用 wrk2 的完整结果。
		metrics.ActualRequests = metrics.AllowedRequests + metrics.RateLimited
		if parsed.Duration > 0 {
			metrics.ActualQPS = float64(metrics.ActualRequests) / parsed.Duration
		}
		metrics.TargetCompletionRate = targetCompletionRate(metrics.ActualQPS, task.Tier.Rate)
		metrics.HTTP2xx = metrics.AllowedRequests
		metrics.HTTP429 = metrics.RateLimited
		if parsed.Duration > 0 {
			metrics.AllowedQPS = float64(metrics.AllowedRequests) / parsed.Duration
			metrics.LimitedQPS = float64(metrics.RateLimited) / parsed.Duration
		}
		unexpected := parsed.Non2xxResponses - metrics.RateLimited
		if unexpected < 0 {
			unexpected = 0
		}
		metrics.HTTPUnexpected = unexpected
		metrics.ErrorRate = float64(unexpected) * 100 / float64(parsed.Requests)
	} else if task.Experiment == ExperimentCachePenetration {
		expectedNotFound := metrics.ExpectedNotFound
		unexpected := parsed.Non2xxResponses - expectedNotFound
		if unexpected < 0 {
			unexpected = 0
		}
		metrics.HTTPUnexpected = unexpected
		metrics.ErrorRate = float64(unexpected) * 100 / float64(parsed.Requests)
	} else {
		metrics.ErrorRate = float64(parsed.Non2xxResponses) * 100 / float64(parsed.Requests)
	}

	if task.Experiment == ExperimentCacheBreakdown {
		if metrics.EvictedAt == "" || metrics.CacheRebuilds != 1 || metrics.RebuiltAt == "" ||
			metrics.StableAt == "" || metrics.RecoveryDurationMS <= 0 {
			r.finish(id, StatusFailed, CodeRunnerFailure, "热点失效、重建与稳定恢复证据不完整", EventFailed)
			return
		}
		comparison := metrics.ScenarioComparison
		if comparison == nil || comparison.Stable.Requests <= 0 || comparison.Impact.Requests <= 0 ||
			comparison.Recovered.Requests <= 0 || comparison.Impact.RedisMisses <= 0 ||
			comparison.Impact.CacheRebuilds != 1 {
			r.finish(id, StatusFailed, CodeRunnerFailure, "热点失效前、冲击与恢复对比窗口不完整", EventFailed)
			return
		}
	}
	if task.Experiment == ExperimentCachePenetration {
		if metrics.NonexistentRequests <= 0 || metrics.ExpectedNotFound <= 0 || metrics.InvalidMySQLQueries <= 0 {
			r.finish(id, StatusFailed, CodeRunnerFailure, "缓存穿透任务没有形成完整的不存在查询证据", EventFailed)
			return
		}
		if task.Protection == ProtectionNone && (metrics.NegativeCacheHits != 0 || metrics.NegativeCacheWrites != 0) {
			r.finish(id, StatusFailed, CodeRunnerFailure, "未保护任务意外使用了负缓存", EventFailed)
			return
		}
		if task.Protection == ProtectionNegativeCache && (metrics.NegativeCacheHits <= 0 || metrics.NegativeCacheWrites != 1) {
			r.finish(id, StatusFailed, CodeRunnerFailure, "负缓存保护任务没有形成一次写入与后续命中", EventFailed)
			return
		}
	}

	r.mu.Lock()
	if record := r.records[id]; record != nil && record.Task.Status == StatusCollecting {
		record.Task.Metrics = metrics
		r.appendLogLocked(record, "info", "wrk2 结束")
		unexpectedNon2xx := parsed.Non2xxResponses
		if task.Experiment == ExperimentCachePenetration {
			unexpectedNon2xx -= metrics.ExpectedNotFound
			if unexpectedNon2xx < 0 {
				unexpectedNon2xx = 0
			}
		}
		if parsed.SocketErrors > 0 || unexpectedNon2xx > 0 {
			r.appendLogLocked(record, "warning", fmt.Sprintf(
				"检测到 Socket Errors %d 个、HTTP 非预期响应 %d 个",
				parsed.SocketErrors,
				unexpectedNon2xx,
			))
		}
		if parsed.LatencyScheduleFallbacks > 0 || parsed.LatencySamplesDropped > 0 {
			r.appendLogLocked(record, "warning", fmt.Sprintf(
				"压测器计时保护已介入：修正延迟回退 %d 个、非法直方图样本丢弃 %d 个",
				parsed.LatencyScheduleFallbacks,
				parsed.LatencySamplesDropped,
			))
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

func (r *Runner) resetExperiment(ctx context.Context, task Task, controlToken string) error {
	if isArchiveScenarioExperiment(task.Experiment) {
		return r.prepareArchiveExperiment(ctx, task, controlToken)
	}
	resetPath := "/api/chapters/cache-aside/reset"
	if task.Experiment != ExperimentCacheAsideRead {
		resetPath = "/api/lab/reset"
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, r.appBaseURL+resetPath, nil)
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

type archiveScenarioMetricCounters struct {
	Requests            int64   `json:"requests"`
	PositiveCacheHits   int64   `json:"positiveCacheHits"`
	RedisMisses         int64   `json:"redisMisses"`
	CoalescedAfterMiss  int64   `json:"coalescedAfterMiss"`
	MySQLFallbacks      int64   `json:"mysqlFallbacks"`
	SQLQueries          int64   `json:"sqlQueries"`
	CacheRebuilds       int64   `json:"cacheRebuilds"`
	NegativeCacheHits   int64   `json:"negativeCacheHits"`
	NegativeCacheWrites int64   `json:"negativeCacheWrites"`
	NonexistentRequests int64   `json:"nonexistentRequests"`
	InvalidMySQLQueries int64   `json:"invalidMySQLQueries"`
	ExpectedNotFound    int64   `json:"expectedNotFound"`
	Errors              int64   `json:"errors"`
	HitRate             float64 `json:"hitRate"`
	P95Latency          int64   `json:"p95Latency"`
	MaxLatency          int64   `json:"maxLatency"`
}

type archiveScenarioMetricSnapshot struct {
	Active             bool                          `json:"active"`
	Scenario           string                        `json:"scenario"`
	Protection         string                        `json:"protection"`
	Phase              string                        `json:"phase"`
	KeyPresent         bool                          `json:"keyPresent"`
	KeyPTTLMillis      int64                         `json:"keyPttlMillis"`
	Current            archiveScenarioMetricCounters `json:"current"`
	Round              archiveScenarioMetricCounters `json:"round"`
	Stable             archiveScenarioMetricCounters `json:"stable"`
	Impact             archiveScenarioMetricCounters `json:"impact"`
	Recovered          archiveScenarioMetricCounters `json:"recovered"`
	EvictedAt          string                        `json:"evictedAt"`
	RebuiltAt          string                        `json:"rebuiltAt"`
	StableAt           string                        `json:"stableAt"`
	RebuildDurationMS  int64                         `json:"rebuildDurationMs"`
	RecoveryDurationMS int64                         `json:"recoveryDurationMs"`
}

func (r *Runner) fetchAppMetrics(ctx context.Context, task Task) (TaskMetrics, error) {
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
		RateLimitQPS        int64 `json:"rateLimitQps"`
		ActivityStock       int64 `json:"activityStock"`
		RedisStock          int64 `json:"redisStock"`
		TotalRequests       int64 `json:"totalRequests"`
		QueueSuccess        int64 `json:"queueSuccess"`
		RateLimited         int64 `json:"rateLimited"`
		StockFailed         int64 `json:"stockFailed"`
		SystemErrors        int64 `json:"systemErrors"`
		CreateOrderEnqueued int64 `json:"createOrderEnqueued"`
		CreateOrderConsumed int64 `json:"createOrderConsumed"`
		CreateOrderBacklog  int64 `json:"createOrderBacklog"`
		Oversold            bool  `json:"oversold"`
		QPS                 int64 `json:"qps"`
		P95                 int64 `json:"p95"`
		P99                 int64 `json:"p99"`
		RateLimitProbe      struct {
			TotalRequests int64 `json:"totalRequests"`
			Allowed       int64 `json:"allowed"`
			Limited       int64 `json:"limited"`
			QPS           int64 `json:"qps"`
			P95           int64 `json:"p95"`
			P99           int64 `json:"p99"`
		} `json:"rateLimitProbe"`
		ArchiveRead struct {
			Direct   archiveMetricPath             `json:"direct"`
			Cached   archiveMetricPath             `json:"cached"`
			Scenario archiveScenarioMetricSnapshot `json:"scenario"`
		} `json:"archiveRead"`
	}
	if err := json.NewDecoder(response.Body).Decode(&snapshot); err != nil {
		return TaskMetrics{}, err
	}
	if task.Experiment == ExperimentSeckillRateLimit {
		probe := snapshot.RateLimitProbe
		limitedRate := float64(0)
		if probe.TotalRequests > 0 {
			limitedRate = float64(probe.Limited) * 100 / float64(probe.TotalRequests)
		}
		return TaskMetrics{
			ActualRequests:  probe.TotalRequests,
			ActualQPS:       float64(probe.QPS),
			AllowedRequests: probe.Allowed,
			RateLimitQPS:    snapshot.RateLimitQPS,
			RateLimited:     probe.Limited,
			RateLimitRate:   limitedRate,
			P95MS:           float64(probe.P95),
			P99MS:           float64(probe.P99),
		}, nil
	}
	if task.Experiment == ExperimentSeckillStockBurst {
		allowed := snapshot.TotalRequests - snapshot.RateLimited
		if allowed < 0 {
			allowed = 0
		}
		return TaskMetrics{
			ActualRequests:      snapshot.TotalRequests,
			ActualQPS:           float64(snapshot.QPS),
			AllowedRequests:     allowed,
			RateLimitQPS:        snapshot.RateLimitQPS,
			RateLimited:         snapshot.RateLimited,
			AdmissionSuccess:    snapshot.QueueSuccess,
			StockFailed:         snapshot.StockFailed,
			ActivityStock:       snapshot.ActivityStock,
			RedisStock:          snapshot.RedisStock,
			SystemErrors:        snapshot.SystemErrors,
			CreateOrderEnqueued: snapshot.CreateOrderEnqueued,
			CreateOrderConsumed: snapshot.CreateOrderConsumed,
			CreateOrderBacklog:  snapshot.CreateOrderBacklog,
			Oversold:            snapshot.Oversold,
			P95MS:               float64(snapshot.P95),
			P99MS:               float64(snapshot.P99),
		}, nil
	}
	if isArchiveScenarioExperiment(task.Experiment) {
		scenario := snapshot.ArchiveRead.Scenario
		errorRate := float64(0)
		if scenario.Round.Requests > 0 {
			errorRate = float64(scenario.Round.Errors) * 100 / float64(scenario.Round.Requests)
		}
		metrics := TaskMetrics{
			ActualRequests:        scenario.Round.Requests,
			ActualQPS:             float64(scenario.Current.Requests),
			ErrorRate:             errorRate,
			RedisHits:             scenario.Round.PositiveCacheHits,
			RedisMisses:           scenario.Round.RedisMisses,
			MySQLFallbacks:        scenario.Round.MySQLFallbacks,
			SQLQueries:            scenario.Round.SQLQueries,
			CacheHitRate:          scenario.Round.HitRate,
			CoalescedAfterMiss:    scenario.Round.CoalescedAfterMiss,
			CacheRebuilds:         scenario.Round.CacheRebuilds,
			NegativeCacheHits:     scenario.Round.NegativeCacheHits,
			NegativeCacheWrites:   scenario.Round.NegativeCacheWrites,
			NonexistentRequests:   scenario.Round.NonexistentRequests,
			InvalidMySQLQueries:   scenario.Round.InvalidMySQLQueries,
			ExpectedNotFound:      scenario.Round.ExpectedNotFound,
			CurrentRequests:       scenario.Current.Requests,
			CurrentPositiveHits:   scenario.Current.PositiveCacheHits,
			CurrentRedisMisses:    scenario.Current.RedisMisses,
			CurrentNegativeHits:   scenario.Current.NegativeCacheHits,
			CurrentMySQLFallbacks: scenario.Current.MySQLFallbacks,
			CurrentHitRate:        scenario.Current.HitRate,
			CurrentP95MS:          scenario.Current.P95Latency,
			CurrentMaxLatencyMS:   scenario.Current.MaxLatency,
			RunMaxLatencyMS:       scenario.Round.MaxLatency,
			ScenarioPhase:         scenario.Phase,
			KeyPresent:            scenario.KeyPresent,
			KeyPTTLMillis:         scenario.KeyPTTLMillis,
			EvictedAt:             scenario.EvictedAt,
			RebuiltAt:             scenario.RebuiltAt,
			StableAt:              scenario.StableAt,
			RebuildDurationMS:     scenario.RebuildDurationMS,
			RecoveryDurationMS:    scenario.RecoveryDurationMS,
		}
		if task.Experiment == ExperimentCacheBreakdown {
			metrics.ScenarioComparison = &ScenarioComparisonMetrics{
				Stable:    archiveScenarioWindowMetrics(scenario.Stable),
				Impact:    archiveScenarioWindowMetrics(scenario.Impact),
				Recovered: archiveScenarioWindowMetrics(scenario.Recovered),
			}
		}
		return metrics, nil
	}
	path := snapshot.ArchiveRead.Direct
	if task.Mode == "cached" {
		path = snapshot.ArchiveRead.Cached
	}
	mysqlFallbacks := path.TotalRequests
	if task.Mode == "cached" {
		mysqlFallbacks = path.CacheMisses
	}
	errorRate := float64(0)
	if path.TotalRequests > 0 {
		errorRate = float64(path.Errors) * 100 / float64(path.TotalRequests)
	}
	// 应用快照的 P95/P99 只描述服务端处理，不含压测器到应用的 HTTP 往返。
	// RequestP* 必须留给 wrk2 uncorrected histogram 在任务结束后填写，避免运行期
	// 把服务端延迟临时标成“实际请求延迟”，结算时又静默切换统计口径。
	return TaskMetrics{
		ActualRequests: path.TotalRequests,
		ActualQPS:      float64(path.QPS),
		ErrorRate:      errorRate,
		RedisHits:      path.CacheHits,
		MySQLFallbacks: mysqlFallbacks,
		SQLQueries:     path.SQLQueries,
		CacheHitRate:   float64(path.CacheHitRate),
		PoolPeak:       path.PoolPeak,
		PoolCapacity:   path.PoolCapacity,
	}, nil
}

func archiveScenarioWindowMetrics(source archiveScenarioMetricCounters) ScenarioWindowMetrics {
	return ScenarioWindowMetrics{
		Requests: source.Requests, PositiveCacheHits: source.PositiveCacheHits,
		RedisMisses: source.RedisMisses, CoalescedAfterMiss: source.CoalescedAfterMiss,
		MySQLFallbacks: source.MySQLFallbacks, SQLQueries: source.SQLQueries,
		CacheRebuilds: source.CacheRebuilds, Errors: source.Errors, HitRate: source.HitRate,
		P95MS: source.P95Latency, MaxLatencyMS: source.MaxLatency,
	}
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
	metrics.TargetCompletionRate = targetCompletionRate(metrics.ActualQPS, record.Task.Tier.Rate)
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
	if cleanupErr := r.finishArchiveExperiment(id); cleanupErr != nil {
		if status == StatusCompleted {
			status = StatusFailed
			code = CodeRunnerFailure
			eventType = EventFailed
			message = "缓存场景终态清理失败：" + cleanupErr.Error()
		} else {
			message += "；缓存场景清理失败：" + cleanupErr.Error()
		}
	}
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
	record.ControlToken = ""
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

func newTaskToken() string {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return fmt.Sprintf("cache-task-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(random)
}

func outputTail(output string, limit int) string {
	output = strings.Join(strings.Fields(output), " ")
	if len(output) <= limit {
		return output
	}
	return output[len(output)-limit:]
}
