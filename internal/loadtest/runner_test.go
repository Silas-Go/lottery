package loadtest

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
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
