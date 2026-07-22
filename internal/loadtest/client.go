package loadtest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client 是主应用访问容器内 Runner 的受控客户端。
// 浏览器永远看不到 Runner 地址，Runner 端口也不暴露到宿主机。
type Client struct {
	baseURL     string
	controlHTTP *http.Client
	streamHTTP  *http.Client
}

// NewClient 创建有界超时的 Runner 控制与流式客户端。
func NewClient(baseURL string) *Client {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		baseURL = "http://loadtest-runner:8090"
	}
	return &Client{
		baseURL:     baseURL,
		controlHTTP: &http.Client{Timeout: 8 * time.Second},
		streamHTTP: &http.Client{Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			ResponseHeaderTimeout: 5 * time.Second,
		}},
	}
}

// Start 创建受控任务。
func (c *Client) Start(ctx context.Context, input CreateRequest) (CreateResponse, *APIError) {
	var output CreateResponse
	apiErr := c.doJSON(ctx, http.MethodPost, "/internal/loadtests", input, &output)
	return output, apiErr
}

// Get 读取 Runner 权威任务快照。
func (c *Client) Get(ctx context.Context, taskID string) (Task, *APIError) {
	var output Task
	apiErr := c.doJSON(ctx, http.MethodGet, taskPath(taskID), nil, &output)
	return output, apiErr
}

// Stop 请求 Runner 终止并回收对应 wrk2 进程。
func (c *Client) Stop(ctx context.Context, taskID string) (Task, *APIError) {
	var output Task
	apiErr := c.doJSON(ctx, http.MethodPost, taskPath(taskID)+"/stop", nil, &output)
	return output, apiErr
}

// OpenEvents 打开 Runner SSE 流；返回的 Body 必须由 handler 在浏览器断开时关闭。
func (c *Client) OpenEvents(ctx context.Context, taskID, lastEventID string) (*http.Response, *APIError) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+taskPath(taskID)+"/events", nil)
	if err != nil {
		return nil, unavailableError(err)
	}
	if lastEventID != "" {
		request.Header.Set("Last-Event-ID", lastEventID)
	}
	response, err := c.streamHTTP.Do(request)
	if err != nil {
		return nil, unavailableError(err)
	}
	if response.StatusCode != http.StatusOK {
		defer response.Body.Close()
		return nil, decodeRemoteError(response)
	}
	return response, nil
}

func (c *Client) doJSON(ctx context.Context, method, path string, input, output any) *APIError {
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return apiError(http.StatusInternalServerError, CodeRunnerFailure, "压测请求编码失败", err.Error())
		}
		body = bytes.NewReader(data)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return unavailableError(err)
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.controlHTTP.Do(request)
	if err != nil {
		return unavailableError(err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return decodeRemoteError(response)
	}
	if output != nil {
		if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(output); err != nil {
			return apiError(http.StatusBadGateway, CodeRunnerFailure, "Runner 返回了无效响应", err.Error())
		}
	}
	return nil
}

func taskPath(taskID string) string {
	return "/internal/loadtests/" + url.PathEscape(taskID)
}

func decodeRemoteError(response *http.Response) *APIError {
	var remote APIError
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&remote); err == nil && remote.Code != "" {
		if remote.Status == 0 {
			remote.Status = response.StatusCode
		}
		return &remote
	}
	return apiError(response.StatusCode, CodeRunnerFailure, "Runner 请求失败", fmt.Sprintf("HTTP %d", response.StatusCode))
}

func unavailableError(err error) *APIError {
	return apiError(http.StatusServiceUnavailable, CodeRunnerUnavailable, "压测 Runner 暂不可用", err.Error())
}
