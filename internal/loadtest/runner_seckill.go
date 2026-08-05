package loadtest

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"
)

type stockBurstHTTPResult struct {
	duration   time.Duration
	statusCode int
	body       string
	err        error
}

// runStockBurst 生成精确的 600 个唯一用户请求并同时放行。
// 这里故意不用持续 QPS：库存正确性实验关心固定请求数在同一竞争窗口内的原子裁决，
// 而不是一段时间内的到达率。600 小于令牌桶满桶容量 800，因此正常情况下限流不参与结果。
func (r *Runner) runStockBurst(ctx context.Context, id string, task Task) {
	baseline, err := r.fetchAppMetrics(ctx, task)
	if err != nil {
		r.finish(id, StatusFailed, CodeRunnerFailure, "读取秒杀实验基线失败："+err.Error(), EventFailed)
		return
	}
	if baseline.RateLimitQPS > 0 && baseline.RateLimitQPS < SeckillStockRequests {
		r.finish(id, StatusFailed, CodeRunnerFailure, fmt.Sprintf(
			"库存实验要求满桶容量至少为 %d，当前 LOTTERY_RATE_LIMIT_QPS=%d 会让限流器成为变量",
			SeckillStockRequests,
			baseline.RateLimitQPS,
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

	if !r.markSeckillRunning(id, "600 个唯一用户已就绪，正在同时争抢星髓") {
		return
	}
	startedAt := time.Now()
	for index := 0; index < SeckillStockRequests; index++ {
		uid := 1_000_000_000 + index + 1
		go func() {
			<-startGate
			requestStarted := time.Now()
			request, err := http.NewRequestWithContext(
				ctx,
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
			"批次完成：准入 %d，售罄/重复 %d，限流 %d，普通落单积压 %d",
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
	r.finish(id, StatusCompleted, "", "库存争抢完成，结果已冻结", EventCompleted)
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
