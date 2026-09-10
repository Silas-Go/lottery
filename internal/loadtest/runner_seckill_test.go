package loadtest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
