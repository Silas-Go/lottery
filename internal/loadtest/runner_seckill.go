package loadtest

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"sort"
	"strings"
	"sync"
	"time"
)

type stockBurstHTTPResult struct {
	duration   time.Duration
	statusCode int
	body       string
	err        error
}

// runStockBurst 让同一批 1500 个唯一用户经过真实入口限流、Lua 准入和 MQ 落单。
// 1200 QPS 是令牌补充速率，1000 是库存总量；两者不能直接相减推断拒绝人数。
// 到达时间和满桶补充会影响分流，所有结果必须以真实快照及 HTTP 状态核对。
func (r *Runner) runStockBurst(ctx context.Context, id string, task Task) {
	baseline, err := r.fetchAppMetrics(ctx, task)
	if err != nil {
		r.finish(id, StatusFailed, CodeRunnerFailure, "读取秒杀实验基线失败："+err.Error(), EventFailed)
		return
	}
	if baseline.RateLimitQPS != SeckillEntryQPS || baseline.ActivityStock != SeckillInitialStock || baseline.RedisStock != SeckillInitialStock {
		r.finish(id, StatusFailed, CodeRunnerFailure, fmt.Sprintf(
			"流水线场景需要入口 %d QPS、初始库存 %d；当前为 %d QPS、活动库存 %d、Redis 库存 %d",
			SeckillEntryQPS, SeckillInitialStock, baseline.RateLimitQPS, baseline.ActivityStock, baseline.RedisStock,
		), EventFailed)
		return
	}

	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          SeckillStockConcurrency,
		MaxIdleConnsPerHost:   SeckillStockConcurrency,
		MaxConnsPerHost:       SeckillStockConcurrency,
		IdleConnTimeout:       10 * time.Second,
		TLSHandshakeTimeout:   3 * time.Second,
		ResponseHeaderTimeout: 12 * time.Second,
		DialContext: (&net.Dialer{
			Timeout:   3 * time.Second,
			KeepAlive: 15 * time.Second,
		}).DialContext,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second}
	results := make(chan stockBurstHTTPResult, SeckillStockRequests)
	startGate := make(chan struct{})
	var ready sync.WaitGroup
	ready.Add(SeckillStockRequests)

	if !r.markSeckillRunning(id, "正在为 1500 个唯一用户准备连接，连接就绪后统一发送请求") {
		return
	}
	startedAt := time.Now()
	for index := 0; index < SeckillStockRequests; index++ {
		uid := 1_000_000_000 + index + 1
		go func() {
			var once sync.Once
			announceReady := func() { once.Do(ready.Done) }
			defer announceReady() // 建连失败也必须结束准备，避免等待永不释放。
			requestStarted := time.Now()
			// 只预建连接，不预发业务请求；排除 DNS/TCP 建连将洪峰摊平的影响。
			requestContext := httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
				GotConn: func(httptrace.GotConnInfo) {
					announceReady()
					select {
					case <-startGate:
					case <-ctx.Done():
					}
					requestStarted = time.Now()
				},
			})
			request, err := http.NewRequestWithContext(
				requestContext,
				http.MethodGet,
				fmt.Sprintf("%s/lucky?uid=%d", r.appBaseURL, uid),
				nil,
			)
			if err != nil {
				results <- stockBurstHTTPResult{duration: time.Since(requestStarted), err: err}
				return
			}
			response, err := client.Do(request)
			if err != nil {
				results <- stockBurstHTTPResult{duration: time.Since(requestStarted), err: err}
				return
			}
			body, readErr := io.ReadAll(io.LimitReader(response.Body, 8<<10))
			_ = response.Body.Close()
			results <- stockBurstHTTPResult{
				duration:   time.Since(requestStarted),
				statusCode: response.StatusCode,
				body:       strings.TrimSpace(string(body)),
				err:        readErr,
			}
		}()
	}
	prepared := make(chan struct{})
	go func() { ready.Wait(); close(prepared) }()
	select {
	case <-prepared:
	case <-ctx.Done():
		r.finishContextEnd(id, ctx, "连接准备阶段")
		return
	}
	startedAt = time.Now()
	close(startGate)

	latencies := make([]time.Duration, 0, SeckillStockRequests)
	completed := int64(0)
	http2xx := int64(0)
	http429 := int64(0)
	httpUnexpected := int64(0)
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()

	for completed < SeckillStockRequests {
		select {
		case <-ctx.Done():
			r.finishContextEnd(id, ctx, "库存争抢阶段")
			return
		case result := <-results:
			completed++
			latencies = append(latencies, result.duration)
			switch {
			case result.err != nil:
				httpUnexpected++
			case result.statusCode >= 200 && result.statusCode < 300 && (result.body == "0" || result.body == "4"):
				http2xx++
			case result.statusCode == http.StatusTooManyRequests:
				http429++
			default:
				httpUnexpected++
			}
		case now := <-ticker.C:
			metrics, err := r.fetchAppMetrics(ctx, task)
			if err == nil {
				metrics.ActualRequests = completed
				metrics.HTTP2xx = http2xx
				metrics.HTTP429 = http429
				metrics.HTTPUnexpected = httpUnexpected
				metrics.DurationSeconds = time.Since(startedAt).Seconds()
				r.updateProgress(id, now.UTC(), metrics)
			}
		}
	}

	if !r.transition(id, StatusCollecting, "请求批次已结束，正在观察普通落单消费进度") {
		return
	}
	metrics, err := r.waitForCreateOrderDrain(ctx, task, 5*time.Second)
	if err != nil {
		if ctx.Err() != nil {
			r.finishContextEnd(id, ctx, "结果收集阶段")
			return
		}
		r.finish(id, StatusFailed, CodeRunnerFailure, "秒杀指标收集失败："+err.Error(), EventFailed)
		return
	}
	duration := time.Since(startedAt)
	metrics.ActualRequests = completed
	metrics.ActualQPS = float64(completed) / duration.Seconds()
	metrics.DurationSeconds = duration.Seconds()
	metrics.TargetCompletionRate = float64(completed) * 100 / SeckillStockRequests
	metrics.RequestP50MS = durationPercentileMS(latencies, .50)
	metrics.RequestP90MS = durationPercentileMS(latencies, .90)
	metrics.RequestP95MS = durationPercentileMS(latencies, .95)
	metrics.RequestP99MS = durationPercentileMS(latencies, .99)
	metrics.HTTP2xx = http2xx
	metrics.HTTP429 = http429
	metrics.HTTPUnexpected = httpUnexpected
	metrics.ErrorRate = float64(httpUnexpected) * 100 / float64(SeckillStockRequests)

	r.mu.Lock()
	if record := r.records[id]; record != nil && record.Task.Status == StatusCollecting {
		record.Task.Metrics = metrics
		r.appendLogLocked(record, "success", fmt.Sprintf(
			"批次完成：准入并入队 %d，售罄/重复 %d，限流 %d，普通落单积压 %d",
			metrics.AdmissionSuccess,
			metrics.StockFailed,
			metrics.RateLimited,
			metrics.CreateOrderBacklog,
		))
		if httpUnexpected > 0 || metrics.SystemErrors > 0 {
			r.appendLogLocked(record, "warning", fmt.Sprintf(
				"检测到 HTTP 异常 %d 个、服务端系统异常 %d 个",
				httpUnexpected,
				metrics.SystemErrors,
			))
		}
		r.persistLocked()
	}
	r.mu.Unlock()
	r.finish(id, StatusCompleted, "", "两道防线实验完成，本轮结果已冻结", EventCompleted)
}

func (r *Runner) markSeckillRunning(id, message string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	record := r.records[id]
	if record == nil || !validTransition(record.Task.Status, StatusRunning) {
		return false
	}
	now := time.Now().UTC()
	record.Task.Status = StatusRunning
	record.Task.StartedAt = &now
	r.updateClockLocked(record, now)
	r.appendLogLocked(record, "info", message)
	r.publishLocked(record, EventLoadtestStarted, message, nil)
	r.persistLocked()
	return true
}

func (r *Runner) waitForCreateOrderDrain(ctx context.Context, task Task, maximum time.Duration) (TaskMetrics, error) {
	deadline := time.Now().Add(maximum)
	for {
		metrics, err := r.fetchAppMetrics(ctx, task)
		if err != nil {
			return TaskMetrics{}, err
		}
		if metrics.CreateOrderBacklog == 0 || time.Now().After(deadline) {
			return metrics, nil
		}
		select {
		case <-ctx.Done():
			return TaskMetrics{}, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func durationPercentileMS(values []time.Duration, quantile float64) float64 {
	if len(values) == 0 {
		return 0
	}
	copyValues := append([]time.Duration(nil), values...)
	sort.Slice(copyValues, func(i, j int) bool { return copyValues[i] < copyValues[j] })
	index := int(float64(len(copyValues)-1) * quantile)
	return float64(copyValues[index].Microseconds()) / 1000
}
