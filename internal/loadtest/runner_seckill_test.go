package loadtest

import (
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
