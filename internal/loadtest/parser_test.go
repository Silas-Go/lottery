package loadtest

import (
	"math"
	"testing"
)

func TestParseWrkOutput(t *testing.T) {
	output := `Running 20s test @ http://app:5678/api/archives/2/cached
  4 threads and 96 connections
  Thread calibration: mean lat.: 1.423ms, rate sampling interval: 10ms
  Latency Distribution (HdrHistogram - Recorded Latency)
 50.000%    1.10ms
 75.000%    1.70ms
 90.000%    2.40ms
 99.000%    8.20ms
  Detailed Percentile spectrum:
       Value   Percentile   TotalCount 1/(1-Percentile)
       1.100     0.500000        30000         2.00
       3.500     0.950000        57000        20.00
       8.200     0.990000        59400       100.00
#[Mean    =        1.423, StdDeviation   =        0.982]
  60000 requests in 20.00s, 15.23MB read
  Socket errors: connect 0, read 1, write 0, timeout 2
  Non-2xx or 3xx responses: 3
Requests/sec:   3000.00
Transfer/sec:    779.63KB`

	result := parseWrkOutput(output)
	if result.Requests != 60000 || result.Timeouts != 2 || result.ErrorCount != 6 {
		t.Fatalf("unexpected counts: %+v", result)
	}
	assertNear(t, result.QPS, 3000)
	assertNear(t, result.Duration, 20)
	assertNear(t, result.P50MS, 1.1)
	assertNear(t, result.P90MS, 2.4)
	assertNear(t, result.P95MS, 3.5)
	assertNear(t, result.P99MS, 8.2)
}

func TestDurationConversion(t *testing.T) {
	assertNear(t, durationToMilliseconds(900, "us"), .9)
	assertNear(t, durationToMilliseconds(2, "s"), 2000)
	assertNear(t, durationToSeconds(500, "ms"), .5)
}

func assertNear(t *testing.T, actual, expected float64) {
	t.Helper()
	if math.Abs(actual-expected) > .001 {
		t.Fatalf("expected %.3f, got %.3f", expected, actual)
	}
}
