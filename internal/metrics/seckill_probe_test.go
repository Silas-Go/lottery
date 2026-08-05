package metrics

import (
	"testing"
	"time"
)

func TestRateLimitProbeMetricsStaySeparateAndReset(t *testing.T) {
	ResetRateLimitProbe()
	RecordRateLimitProbe(true, 2*time.Millisecond)
	RecordRateLimitProbe(false, 3*time.Millisecond)

	snapshot := SnapshotRateLimitProbe()
	if snapshot.TotalRequests != 2 || snapshot.Allowed != 1 || snapshot.Limited != 1 {
		t.Fatalf("unexpected probe snapshot: %+v", snapshot)
	}
	if snapshot.P95 <= 0 || snapshot.P99 <= 0 {
		t.Fatalf("probe latency percentiles were not recorded: %+v", snapshot)
	}

	ResetRateLimitProbe()
	reset := SnapshotRateLimitProbe()
	if reset.TotalRequests != 0 || reset.Allowed != 0 || reset.Limited != 0 {
		t.Fatalf("probe reset did not clear counters: %+v", reset)
	}
}
