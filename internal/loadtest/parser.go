package loadtest

import (
	"bufio"
	"regexp"
	"strconv"
	"strings"
)

var (
	requestsPattern      = regexp.MustCompile(`^\s*([0-9]+) requests in ([0-9.]+)(us|ms|s),`)
	qpsPattern           = regexp.MustCompile(`^Requests/sec:\s+([0-9.]+)`)
	latencyPattern       = regexp.MustCompile(`^\s*(50|75|90|99)\.0+%\s+([0-9.]+)(us|ms|s)`)
	socketPattern        = regexp.MustCompile(`Socket errors: connect ([0-9]+), read ([0-9]+), write ([0-9]+), timeout ([0-9]+)`)
	non2xxPattern        = regexp.MustCompile(`Non-2xx or 3xx responses: ([0-9]+)`)
	latencySafetyPattern = regexp.MustCompile(
		`Latency safety: schedule fallbacks ([0-9]+), histogram drops ([0-9]+)`,
	)
)

type wrkResult struct {
	Requests                 int64
	QPS                      float64
	Duration                 float64
	P50MS                    float64
	P90MS                    float64
	P95MS                    float64
	P99MS                    float64
	RequestP50MS             float64
	RequestP90MS             float64
	RequestP95MS             float64
	RequestP99MS             float64
	Timeouts                 int64
	SocketErrors             int64
	Non2xxResponses          int64
	LatencyScheduleFallbacks int64
	LatencySamplesDropped    int64
}

type percentilePoint struct {
	value      float64
	percentile float64
}

type latencyHistogram struct {
	p50MS  float64
	p90MS  float64
	p95MS  float64
	p99MS  float64
	points []percentilePoint
}

// parseWrkOutput 只解析 wrk2 的汇总和两组有界直方图，不把逐请求内容带到页面。
// Recorded Latency 是按计划投递时刻修正后的需求侧延迟；Uncorrected Latency 才是
// HTTP 请求真正发出到收到响应的延迟，两者不能再共用一个“客户等待时间”标签。
func parseWrkOutput(output string) wrkResult {
	var result wrkResult
	var corrected latencyHistogram
	var uncorrected latencyHistogram
	current := &corrected
	var detailed bool
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.Contains(line, "Latency Distribution (HdrHistogram") {
			detailed = false
			if strings.Contains(line, "Uncorrected Latency") {
				current = &uncorrected
			} else {
				current = &corrected
			}
			continue
		}
		if match := requestsPattern.FindStringSubmatch(line); len(match) == 4 {
			result.Requests, _ = strconv.ParseInt(match[1], 10, 64)
			duration, _ := strconv.ParseFloat(match[2], 64)
			result.Duration = durationToSeconds(duration, match[3])
			continue
		}
		if match := qpsPattern.FindStringSubmatch(line); len(match) == 2 {
			result.QPS, _ = strconv.ParseFloat(match[1], 64)
			continue
		}
		if match := latencyPattern.FindStringSubmatch(line); len(match) == 4 {
			value, _ := strconv.ParseFloat(match[2], 64)
			value = durationToMilliseconds(value, match[3])
			switch match[1] {
			case "50":
				current.p50MS = value
			case "90":
				current.p90MS = value
			case "99":
				current.p99MS = value
			}
			continue
		}
		if match := socketPattern.FindStringSubmatch(line); len(match) == 5 {
			for index := 1; index <= 4; index++ {
				value, _ := strconv.ParseInt(match[index], 10, 64)
				result.SocketErrors += value
				if index == 4 {
					result.Timeouts = value
				}
			}
			continue
		}
		if match := non2xxPattern.FindStringSubmatch(line); len(match) == 2 {
			value, _ := strconv.ParseInt(match[1], 10, 64)
			result.Non2xxResponses += value
			continue
		}
		if match := latencySafetyPattern.FindStringSubmatch(line); len(match) == 3 {
			result.LatencyScheduleFallbacks, _ = strconv.ParseInt(match[1], 10, 64)
			result.LatencySamplesDropped, _ = strconv.ParseInt(match[2], 10, 64)
			continue
		}
		if strings.Contains(line, "Detailed Percentile spectrum") {
			detailed = true
			continue
		}
		if detailed && strings.HasPrefix(strings.TrimSpace(line), "#[Mean") {
			detailed = false
			continue
		}
		if detailed {
			fields := strings.Fields(line)
			if len(fields) < 4 {
				continue
			}
			value, valueErr := strconv.ParseFloat(fields[0], 64)
			percentileValue, percentileErr := strconv.ParseFloat(fields[1], 64)
			if valueErr == nil && percentileErr == nil && percentileValue >= 0 && percentileValue <= 1 {
				current.points = append(current.points, percentilePoint{value: value, percentile: percentileValue})
			}
		}
	}
	finalizeHistogram(&corrected)
	finalizeHistogram(&uncorrected)
	result.P50MS = corrected.p50MS
	result.P90MS = corrected.p90MS
	result.P95MS = corrected.p95MS
	result.P99MS = corrected.p99MS
	result.RequestP50MS = uncorrected.p50MS
	result.RequestP90MS = uncorrected.p90MS
	result.RequestP95MS = uncorrected.p95MS
	result.RequestP99MS = uncorrected.p99MS
	return result
}

func finalizeHistogram(histogram *latencyHistogram) {
	if histogram.p50MS == 0 {
		histogram.p50MS = percentileAt(histogram.points, .50)
	}
	if histogram.p90MS == 0 {
		histogram.p90MS = percentileAt(histogram.points, .90)
	}
	histogram.p95MS = percentileAt(histogram.points, .95)
	if histogram.p99MS == 0 {
		histogram.p99MS = percentileAt(histogram.points, .99)
	}
}

func percentileAt(points []percentilePoint, percentile float64) float64 {
	for _, point := range points {
		if point.percentile >= percentile {
			return point.value
		}
	}
	if len(points) > 0 {
		return points[len(points)-1].value
	}
	return 0
}

func durationToMilliseconds(value float64, unit string) float64 {
	switch unit {
	case "us":
		return value / 1000
	case "s":
		return value * 1000
	default:
		return value
	}
}

func durationToSeconds(value float64, unit string) float64 {
	switch unit {
	case "us":
		return value / 1_000_000
	case "ms":
		return value / 1000
	default:
		return value
	}
}
