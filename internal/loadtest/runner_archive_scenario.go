package loadtest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type archiveExperimentControlState struct {
	Scenario      string `json:"scenario"`
	Protection    string `json:"protection"`
	ArchiveID     int    `json:"archiveId"`
	MissingID     int    `json:"missingId"`
	CacheKey      string `json:"cacheKey"`
	KeyPresent    bool   `json:"keyPresent"`
	KeyPTTLMillis int64  `json:"keyPttlMillis"`
	OriginDelayMS int64  `json:"originDelayMs"`
	Deleted       bool   `json:"deleted"`
	At            string `json:"at"`
}

func (r *Runner) taskControlToken(id string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if record := r.records[id]; record != nil {
		return record.ControlToken
	}
	return ""
}

func (r *Runner) prepareArchiveExperiment(ctx context.Context, task Task, token string) error {
	var state archiveExperimentControlState
	if err := r.postArchiveExperimentControl(ctx, "/internal/cache-experiments/prepare", map[string]any{
		"token": token, "scenario": task.Experiment, "protection": task.Protection,
	}, &state); err != nil {
		return err
	}
	if task.Experiment == ExperimentCacheBreakdown && (!state.KeyPresent || state.KeyPTTLMillis <= 0) {
		return fmt.Errorf("breakdown preparation did not create a hot cache key")
	}
	if task.Experiment == ExperimentCacheBreakdown && state.OriginDelayMS <= 0 {
		return fmt.Errorf("breakdown preparation did not return the backend origin delay")
	}
	if task.Experiment == ExperimentCachePenetration && state.MissingID != CachePenetrationMissingID {
		return fmt.Errorf("penetration preparation returned unexpected missing id %d", state.MissingID)
	}
	if state.CacheKey == "" {
		return fmt.Errorf("cache experiment preparation did not return the real cache key")
	}
	r.mu.Lock()
	if record := r.records[task.ID]; record != nil {
		record.Task.CacheKey = state.CacheKey
		record.Task.OriginDelayMS = state.OriginDelayMS
		record.Task.Metrics.KeyPresent = state.KeyPresent
		record.Task.Metrics.KeyPTTLMillis = state.KeyPTTLMillis
		r.persistLocked()
	}
	r.mu.Unlock()
	return nil
}

func (r *Runner) evictArchiveExperiment(ctx context.Context, token string) (archiveExperimentControlState, error) {
	var state archiveExperimentControlState
	err := r.postArchiveExperimentControl(ctx, "/internal/cache-experiments/evict", map[string]string{"token": token}, &state)
	if err != nil {
		return state, err
	}
	if !state.Deleted || state.KeyPresent {
		return state, fmt.Errorf("cache eviction did not remove the hot key")
	}
	return state, nil
}

func (r *Runner) finishArchiveExperiment(id string) error {
	r.mu.Lock()
	record := r.records[id]
	if record == nil || !isArchiveScenarioExperiment(record.Task.Experiment) {
		r.mu.Unlock()
		return nil
	}
	token := record.ControlToken
	r.mu.Unlock()
	if token == "" {
		// finish 可能被子进程退出、停止请求和超时边界同时触发；首个调用完成清理后，
		// 后续调用保持幂等，不再拿空令牌重复访问主应用。
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var state archiveExperimentControlState
	return r.postArchiveExperimentControl(ctx, "/internal/cache-experiments/finish", map[string]string{"token": token}, &state)
}

func (r *Runner) postArchiveExperimentControl(ctx context.Context, path string, input, output any) error {
	data, err := json.Marshal(input)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, r.appBaseURL+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := r.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4<<10))
		return fmt.Errorf("cache experiment control %s returned HTTP %d: %s", path, response.StatusCode, string(body))
	}
	if output != nil {
		if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(output); err != nil {
			return err
		}
	}
	return nil
}
