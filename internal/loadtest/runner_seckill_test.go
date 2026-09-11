package loadtest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestDurationPercentileMS(t *testing.T) {
	values := []time.Duration{time.Millisecond, 5 * time.Millisecond, 3 * time.Millisecond, 2 * time.Millisecond}
	if got := durationPercentileMS(values, .50); got != 2 {
		t.Fatalf("p50=%v, want=2", got)
	}
	if got := durationPercentileMS(values, .99); got != 3 {
		t.Fatalf("p99=%v, want=3 for nearest-rank floor used by the lab", got)
	}
}

// 新计数为零与旧服务缺失字段必须区分；无论哪种情况都不能从 queueSuccess 推断。
func TestStockMetricsPreserveIndependentLuaAdmission(t *testing.T) {
	cases := []struct {
		name, payload string
		want          *int64
	}{
		{"mq_failure_after_admission", `{"luaAdmissionSuccess":2,"queueSuccess":1}`, int64Pointer(2)},
		{"zero_admissions", `{"luaAdmissionSuccess":0,"queueSuccess":1}`, int64Pointer(0)},
		{"legacy_snapshot", `{"queueSuccess":300}`, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(tc.payload)) }))
			defer app.Close()
			runner := &Runner{appBaseURL: app.URL, httpClient: app.Client()}
			got, err := runner.fetchAppMetrics(context.Background(), Task{Experiment: ExperimentSeckillStockBurst})
			if err != nil {
				t.Fatal(err)
			}
			if tc.want == nil {
				if got.LuaAdmissionSuccess != nil {
					t.Fatal("legacy snapshot fabricated a Lua count")
				}
			} else if got.LuaAdmissionSuccess == nil || *got.LuaAdmissionSuccess != *tc.want {
				t.Fatalf("wrong Lua count: %+v", got)
			}
			data, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			var restored TaskMetrics
			if err := json.Unmarshal(data, &restored); err != nil {
				t.Fatal(err)
			}
			if (restored.LuaAdmissionSuccess == nil) != (tc.want == nil) {
				t.Fatal("persistence lost missing/zero distinction")
			}
		})
	}
}

func int64Pointer(value int64) *int64 { return &value }

// 同一批请求允许出现预期 429，并保留资格、库存拒绝与限流的独立统计。
// 仅连接 httptest 服务，不接触开发环境库存或 MQ。
func TestPipelineBurstIncludesBothDefenses(t *testing.T) {
	var requests atomic.Int64
	var users sync.Map
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/api/lab/reset":
			w.Write([]byte(`{}`))
		case "/api/metrics/snapshot":
			n := requests.Load()
			admitted := min(n, 1000)
			allowed := min(n, 1200)
			json.NewEncoder(w).Encode(map[string]any{"run_id": "test-run", "rateLimitQps": 1200, "activityStock": 1000, "redisStock": 1000 - admitted, "totalRequests": n, "rateLimited": n - allowed, "luaAdmissionSuccess": admitted, "stockFailed": allowed - admitted, "queueSuccess": admitted, "createOrderEnqueued": admitted, "createOrderConsumed": admitted})
		case "/lucky":
			uid := req.URL.Query().Get("uid")
			if _, duplicate := users.LoadOrStore(uid, true); duplicate || uid == "" {
				http.Error(w, "duplicate user", 500)
				return
			}
			n := requests.Add(1)
			if n <= 1000 {
				w.Write([]byte("4"))
			} else if n <= 1200 {
				w.Write([]byte("0"))
			} else {
				w.WriteHeader(429)
			}
		default:
			http.NotFound(w, req)
		}
	}))
	defer app.Close()
	runner, err := NewRunner(RunnerOptions{AppBaseURL: app.URL, StatePath: filepath.Join(t.TempDir(), "tasks.json")})
	if err != nil {
		t.Fatal(err)
	}
	task, apiErr := runner.Start(CreateRequest{Experiment: ExperimentSeckillStockBurst})
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		task, apiErr = runner.Get(task.ID)
		if apiErr != nil {
			t.Fatal(apiErr)
		}
		if task.Status.Terminal() {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if task.Status != StatusCompleted {
		runner.Stop(task.ID)
		t.Fatalf("pipeline status=%s error=%s", task.Status, task.ErrorMessage)
	}
	m := task.Metrics
	if m.ActualRequests != 1500 || m.HTTP429 != 300 || m.RateLimited != 300 || m.StockFailed != 200 || m.LuaAdmissionSuccess == nil || *m.LuaAdmissionSuccess != 1000 || m.RedisStock != 0 || m.ErrorRate != 0 || m.HTTPUnexpected != 0 {
		t.Fatalf("incorrect pipeline accounting: %+v", m)
	}
}
