package service

import (
	"context"
	"log/slog"
	"net/http"
	"silas/internal/loadtest"
)

// LoadtestService 编排主应用到内部 Runner 的任务调用。
// wrk2 生命周期和单任务锁仍归 Runner 所有，主应用只负责校验、转发和统一错误语义。
type LoadtestService struct {
	client *loadtest.Client
}

// NewLoadtestService 创建压测任务编排服务。
func NewLoadtestService(client *loadtest.Client) *LoadtestService {
	return &LoadtestService{client: client}
}

// Start 在主应用再次校验白名单后把任务交给 Runner。
func (s *LoadtestService) Start(ctx context.Context, input loadtest.CreateRequest) (loadtest.CreateResponse, *AppError) {
	if _, message := loadtest.ValidateCreateRequest(input); message != "" {
		return loadtest.CreateResponse{}, NewAppError(CodeLoadtestInvalidRequest, "压测请求不符合白名单", nil, "detail", message)
	}
	response, apiErr := s.client.Start(ctx, input)
	if apiErr != nil {
		return loadtest.CreateResponse{}, loadtestAppError(apiErr)
	}
	slog.Info("loadtest accepted", "task_id", response.TaskID, "archive_id", input.ArchiveID, "mode", input.Mode, "tier", input.Tier)
	return response, nil
}

// Get 返回 Runner 任务快照。
func (s *LoadtestService) Get(ctx context.Context, taskID string) (loadtest.Task, *AppError) {
	task, apiErr := s.client.Get(ctx, taskID)
	if apiErr != nil {
		return loadtest.Task{}, loadtestAppError(apiErr)
	}
	return task, nil
}

// Stop 显式取消任务；页面断开不会调用这里。
func (s *LoadtestService) Stop(ctx context.Context, taskID string) (loadtest.Task, *AppError) {
	task, apiErr := s.client.Stop(ctx, taskID)
	if apiErr != nil {
		return loadtest.Task{}, loadtestAppError(apiErr)
	}
	slog.Info("loadtest stop completed", "task_id", taskID, "status", task.Status)
	return task, nil
}

// OpenEvents 打开 Runner 的事件流并保留 Last-Event-ID。
func (s *LoadtestService) OpenEvents(ctx context.Context, taskID, lastEventID string) (*http.Response, *AppError) {
	response, apiErr := s.client.OpenEvents(ctx, taskID, lastEventID)
	if apiErr != nil {
		return nil, loadtestAppError(apiErr)
	}
	return response, nil
}

func loadtestAppError(apiErr *loadtest.APIError) *AppError {
	return NewAppError(apiErr.Code, apiErr.Message, apiErr, "runner_status", apiErr.Status)
}
