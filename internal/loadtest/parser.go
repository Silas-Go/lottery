package loadtest

import (
	"bufio"
	"regexp"
	"strconv"
	"strings"
)

var (
	requestsPattern = regexp.MustCompile(`^\s*([0-9]+) requests in ([0-9.]+)(us|ms|s),`)
	qpsPattern      = regexp.MustCompile(`^Requests/sec:\s+([0-9.]+)`)
	latencyPattern  = regexp.MustCompile(`^\s*(50|75|90|99)\.0+%\s+([0-9.]+)(us|ms|s)`)
	socketPattern   = regexp.MustCompile(`Socket errors: connect ([0-9]+), read ([0-9]+), write ([0-9]+), timeout ([0-9]+)`)
	non2xxPattern   = regexp.MustCompile(`Non-2xx or 3xx responses: ([0-9]+)`)
)

type wrkResult struct {
	Requests   int64
	QPS        float64
	Duration   float64
	P50MS      float64
	P90MS      float64
	P95MS      float64
	P99MS      float64
	Timeouts   int64
	ErrorCount int64
}

type percentilePoint struct {
	value      float64
	percentile float64
}

// parseWrkOutput 只解析 wrk2 的汇总和有界直方图，不把逐请求内容带到页面。
func parseWrkOutput(output string) wrkResult {
	var result wrkResult
	var detailed bool
	var points []percentilePoint
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		line := scanner.Text()
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
				result.P50MS = value
			case "90":
				result.P90MS = value
			case "99":
				result.P99MS = value
			}
			continue
		}
		if match := socketPattern.FindStringSubmatch(line); len(match) == 5 {
			for index := 1; index <= 4; index++ {
				value, _ := strconv.ParseInt(match[index], 10, 64)
				result.ErrorCount += value
				if index == 4 {
					result.Timeouts = value
				}
			}
			continue
		}
		if match := non2xxPattern.FindStringSubmatch(line); len(match) == 2 {
			value, _ := strconv.ParseInt(match[1], 10, 64)
			result.ErrorCount += value
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
				points = append(points, percentilePoint{value: value, percentile: percentileValue})
			}
		}
	}
	if result.P50MS == 0 {
		result.P50MS = percentileAt(points, .50)
	}
	if result.P90MS == 0 {
		result.P90MS = percentileAt(points, .90)
	}
	result.P95MS = percentileAt(points, .95)
	if result.P99MS == 0 {
		result.P99MS = percentileAt(points, .99)
	}
	return result
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
