package loadtest

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestRunnerAllowsOnlyOneActiveTask(t *testing.T) {
	resetEntered := make(chan struct{}, 1)
	app := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/chapters/cache-aside/reset" {
			http.NotFound(writer, request)
			return
		}
		select {
		case resetEntered <- struct{}{}:
		default:
		}
		<-request.Context().Done()
	}))
	defer app.Close()

	runner, err := NewRunner(RunnerOptions{
		AppBaseURL: app.URL,
		StatePath:  filepath.Join(t.TempDir(), "tasks.json"),
		Wrk2Path:   filepath.Join(t.TempDir(), "missing-wrk2"),
	})
	if err != nil {
		t.Fatal(err)
	}
	input := CreateRequest{Experiment: ExperimentCacheAsideRead, ArchiveID: 2, Mode: "direct", Tier: TierVisitors}
	first, apiErr := runner.Start(input)
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	select {
	case <-resetEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("runner did not enter reset")
	}
	if _, apiErr = runner.Start(input); apiErr == nil || apiErr.Code != CodeAlreadyRunning {
		t.Fatalf("expected %s, got %#v", CodeAlreadyRunning, apiErr)
	}
	if _, apiErr = runner.Stop(first.ID); apiErr != nil {
		t.Fatal(apiErr)
	}
}

func TestRunnerHTTPRejectsUnknownFields(t *testing.T) {
	runner, err := NewRunner(RunnerOptions{StatePath: filepath.Join(t.TempDir(), "tasks.json")})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/internal/loadtests", http.NoBody)
	request = request.WithContext(context.Background())
	recorder := httptest.NewRecorder()
	runner.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty body, got %d", recorder.Code)
	}
}

func TestAutoConnectionsUseConservativeBaseline(t *testing.T) {
	runner := &Runner{records: make(map[string]*taskRecord)}
	expected := map[int]int{
		100:  70,
		300:  140,
		800:  300,
		1500: 500,
	}
	for rate, want := range expected {
		got, _ := runner.resolveAutoConnectionsLocked(CreateRequest{ArchiveID: 2, Mode: "direct"}, rate)
		if got != want {
			t.Fatalf("rate %d: expected %d connections, got %d", rate, want, got)
		}
	}
}

func TestConnectionPlanUsesRunnerEstimatorWithoutCreatingTask(t *testing.T) {
	runner := &Runner{records: make(map[string]*taskRecord)}
	plan, apiErr := runner.PlanConnections(CreateRequest{
		Experiment:     ExperimentCacheAsideRead,
		ArchiveID:      4,
		Mode:           "direct",
		Rate:           800,
		ConnectionMode: ConnectionModeAuto,
	})
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	if plan.Connections != 300 || plan.ConnectionMode != ConnectionModeAuto || plan.Rate != 800 {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	if len(runner.records) != 0 || len(runner.order) != 0 || runner.activeID != "" {
		t.Fatalf("connection preview must not create a task: %+v", runner)
	}
}

func TestRunnerHTTPReturnsConnectionPlan(t *testing.T) {
	runner := &Runner{records: make(map[string]*taskRecord)}
	body, err := json.Marshal(CreateRequest{
		Experiment:     ExperimentCacheAsideRead,
		ArchiveID:      4,
		Mode:           "cached",
		Rate:           300,
		ConnectionMode: ConnectionModeManual,
		Connections:    140,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/internal/loadtests/connection-plan", bytes.NewReader(body))
	recorder := httptest.NewRecorder()
	runner.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	var plan ConnectionPlanResponse
	if err := json.NewDecoder(recorder.Body).Decode(&plan); err != nil {
		t.Fatal(err)
	}
	if plan.Connections != 140 || plan.ConnectionMode != ConnectionModeManual || plan.Reason != "用户手动指定" {
		t.Fatalf("unexpected plan: %+v", plan)
	}
}

func TestRunnerHTTPCreateReturnsLockedConnectionConfiguration(t *testing.T) {
	resetEntered := make(chan struct{}, 1)
	app := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/chapters/cache-aside/reset" {
			http.NotFound(writer, request)
			return
		}
		select {
		case resetEntered <- struct{}{}:
		default:
		}
		<-request.Context().Done()
	}))
	defer app.Close()

	runner, err := NewRunner(RunnerOptions{
		AppBaseURL: app.URL,
		StatePath:  filepath.Join(t.TempDir(), "tasks.json"),
		Wrk2Path:   filepath.Join(t.TempDir(), "missing-wrk2"),
	})
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(CreateRequest{
		Experiment:     ExperimentCacheAsideRead,
		ArchiveID:      4,
		Mode:           "direct",
		Rate:           800,
		ConnectionMode: ConnectionModeAuto,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/internal/loadtests", bytes.NewReader(body))
	recorder := httptest.NewRecorder()
	runner.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", recorder.Code, recorder.Body.String())
	}
	var response CreateResponse
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.TaskID == "" || response.Status != StatusStarting ||
		response.ConnectionMode != ConnectionModeAuto || response.Connections != 300 ||
		response.ConnectionReason == "" {
		t.Fatalf("create response omitted locked connection configuration: %+v", response)
	}
	if _, apiErr := runner.Stop(response.TaskID); apiErr != nil {
		t.Fatal(apiErr)
	}
}

func TestAutoConnectionsReuseSameConfigurationForBothPaths(t *testing.T) {
	runner := &Runner{
		records: map[string]*taskRecord{
			"direct": {
				Task: Task{
					ID:             "direct",
					ArchiveID:      2,
					Mode:           "direct",
					Status:         StatusCompleted,
					ConnectionMode: ConnectionModeAuto,
					Tier: TierConfig{
						Rate:        1500,
						Connections: 500,
					},
					Metrics: TaskMetrics{RequestP95MS: 210},
				},
			},
		},
		order: []string{"direct"},
	}
	connections, _ := runner.resolveAutoConnectionsLocked(
		CreateRequest{ArchiveID: 2, Mode: "cached"},
		1500,
	)
	if connections != 500 {
		t.Fatalf("expected cached path to reuse 500 connections, got %d", connections)
	}
}

func TestAutoConnectionsUseSlowerActualRequestHistory(t *testing.T) {
	runner := &Runner{
		records: map[string]*taskRecord{
			"direct": completedHistoricalTask("direct", 2, 800, 220),
			"cached": completedHistoricalTask("cached", 2, 800, 4),
		},
		order: []string{"direct", "cached"},
	}
	connections, _ := runner.resolveAutoConnectionsLocked(
		CreateRequest{ArchiveID: 2, Mode: "direct"},
		800,
	)
	if connections != 300 {
		t.Fatalf("expected slower direct P95 to select 300 connections, got %d", connections)
	}
}

func TestHistoricalLegacyOverloadDoesNotUseCorrectedLatency(t *testing.T) {
	task := Task{
		Tier: TierConfig{Rate: 1500, Connections: 64},
		Metrics: TaskMetrics{
			ActualQPS: 361.08,
			P95MS:     14680.06,
		},
	}
	got := historicalTaskRequestP95(task)
	assertNear(t, got, 64/361.08*1000)
}

func TestHistoricalOverloadUsesConduitOccupancyFloor(t *testing.T) {
	task := Task{
		Tier: TierConfig{Rate: 1500, Connections: 70},
		Metrics: TaskMetrics{
			ActualQPS:    100,
			RequestP95MS: 12,
			SocketErrors: 3,
		},
	}
	got := historicalTaskRequestP95(task)
	assertNear(t, got, 700)
}

func TestWrkArgumentsCollectBothLatencySemantics(t *testing.T) {
	task := Task{Tier: TierConfig{Rate: 1500, Connections: 500, DurationSeconds: 30}}
	got := wrkArguments(task, "/opt/read.lua", "http://app/direct")
	want := []string{
		"-t1",
		"-c500",
		"-d30s",
		"-R1500",
		"--latency",
		"--u_latency",
		"--timeout", "2s",
		"-s", "/opt/read.lua",
		"http://app/direct",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected wrk2 arguments:\nwant: %#v\n got: %#v", want, got)
	}
}

func TestRunnerLoadsLegacyPersistedTask(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "tasks.json")
	legacy := persistedState{Records: []persistedRecord{{
		Task: Task{
			ID:     "legacy-task",
			Mode:   "direct",
			Status: StatusCompleted,
			Tier: TierConfig{
				ID:              TierCrowd,
				Rate:            1500,
				Connections:     64,
				DurationSeconds: 20,
			},
		},
	}}}
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	runner, err := NewRunner(RunnerOptions{StatePath: statePath})
	if err != nil {
		t.Fatal(err)
	}
	task, apiErr := runner.Get("legacy-task")
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	if task.Tier.Connections != 64 || task.ConnectionMode != "" || task.Metrics.RequestP95MS != 0 {
		t.Fatalf("legacy task was not preserved: %+v", task)
	}
}

func completedHistoricalTask(mode string, archiveID, rate int, requestP95MS float64) *taskRecord {
	return &taskRecord{Task: Task{
		ID:        mode,
		ArchiveID: archiveID,
		Mode:      mode,
		Status:    StatusCompleted,
		Tier: TierConfig{
			Rate: rate,
		},
		Metrics: TaskMetrics{RequestP95MS: requestP95MS},
	}}
}
