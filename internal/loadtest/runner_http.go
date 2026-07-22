package loadtest

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const maxCreateBodyBytes = 4 << 10

// Handler 暴露 Runner 的容器内 HTTP 接口。
// 接口只接收受控任务字段；没有 target、脚本路径或命令字段，调用者不能把 Runner 变成通用命令执行器。
func (r *Runner) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", r.handleHealth)
	mux.HandleFunc("/internal/loadtests", r.handleCollection)
	mux.HandleFunc("/internal/loadtests/", r.handleTask)
	return mux
}

func (r *Runner) handleHealth(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writer.Header().Set("Allow", http.MethodGet)
		writeRunnerError(writer, apiError(http.StatusMethodNotAllowed, CodeInvalidRequest, "请求方法不受支持", request.Method))
		return
	}
	writeRunnerJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
}

func (r *Runner) handleCollection(writer http.ResponseWriter, request *http.Request) {
	if request.URL.Path != "/internal/loadtests" {
		http.NotFound(writer, request)
		return
	}
	if request.Method != http.MethodPost {
		writer.Header().Set("Allow", http.MethodPost)
		writeRunnerError(writer, apiError(http.StatusMethodNotAllowed, CodeInvalidRequest, "请求方法不受支持", request.Method))
		return
	}

	request.Body = http.MaxBytesReader(writer, request.Body, maxCreateBodyBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var input CreateRequest
	if err := decoder.Decode(&input); err != nil {
		writeRunnerError(writer, apiError(http.StatusBadRequest, CodeInvalidRequest, "压测请求不是有效 JSON", err.Error()))
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeRunnerError(writer, apiError(http.StatusBadRequest, CodeInvalidRequest, "请求体只能包含一个 JSON 对象", ""))
		return
	}

	task, apiErr := r.Start(input)
	if apiErr != nil {
		writeRunnerError(writer, apiErr)
		return
	}
	writeRunnerJSON(writer, http.StatusAccepted, CreateResponse{TaskID: task.ID, Status: task.Status})
}

func (r *Runner) handleTask(writer http.ResponseWriter, request *http.Request) {
	tail := strings.Trim(strings.TrimPrefix(request.URL.Path, "/internal/loadtests/"), "/")
	parts := strings.Split(tail, "/")
	if len(parts) == 0 || parts[0] == "" || len(parts) > 2 {
		http.NotFound(writer, request)
		return
	}
	taskID := parts[0]
	if len(parts) == 1 && request.Method == http.MethodGet {
		task, apiErr := r.Get(taskID)
		if apiErr != nil {
			writeRunnerError(writer, apiErr)
			return
		}
		writeRunnerJSON(writer, http.StatusOK, task)
		return
	}
	if len(parts) == 2 && parts[1] == "stop" && request.Method == http.MethodPost {
		task, apiErr := r.Stop(taskID)
		if apiErr != nil {
			writeRunnerError(writer, apiErr)
			return
		}
		writeRunnerJSON(writer, http.StatusOK, task)
		return
	}
	if len(parts) == 2 && parts[1] == "events" && request.Method == http.MethodGet {
		r.streamEvents(writer, request, taskID)
		return
	}
	http.NotFound(writer, request)
}

// streamEvents 回放断线期间遗漏的事件，再持续推送新事件。
// Last-Event-ID 由浏览器 EventSource 自动携带，因此断线重连不会依赖前端伪造进度。
func (r *Runner) streamEvents(writer http.ResponseWriter, request *http.Request, taskID string) {
	flusher, ok := writer.(http.Flusher)
	if !ok {
		writeRunnerError(writer, apiError(http.StatusInternalServerError, CodeRunnerFailure, "当前 HTTP writer 不支持 SSE", ""))
		return
	}
	lastEventID, _ := strconv.ParseInt(request.Header.Get("Last-Event-ID"), 10, 64)
	replay, events, unsubscribe, apiErr := r.Subscribe(taskID, lastEventID)
	if apiErr != nil {
		writeRunnerError(writer, apiErr)
		return
	}
	defer unsubscribe()

	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-cache")
	writer.Header().Set("Connection", "keep-alive")
	writer.Header().Set("X-Accel-Buffering", "no")
	writer.WriteHeader(http.StatusOK)
	for _, event := range replay {
		if err := writeSSEEvent(writer, event); err != nil {
			return
		}
	}
	flusher.Flush()

	task, getErr := r.Get(taskID)
	if getErr == nil && task.Status.Terminal() {
		return
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case <-heartbeat.C:
			if _, err := fmt.Fprint(writer, ": keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case event := <-events:
			if err := writeSSEEvent(writer, event); err != nil {
				return
			}
			flusher.Flush()
			if event.Status.Terminal() {
				return
			}
		}
	}
}

func writeSSEEvent(writer io.Writer, event Event) error {
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(writer, "id: %d\nevent: %s\ndata: %s\n\n", event.ID, event.Type, data)
	return err
}

func writeRunnerError(writer http.ResponseWriter, apiErr *APIError) {
	writer.Header().Set("X-Error-Code", apiErr.Code)
	writeRunnerJSON(writer, apiErr.Status, apiErr)
}

func writeRunnerJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
