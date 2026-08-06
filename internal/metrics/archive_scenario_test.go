package metrics

import (
	"testing"
	"time"
)

func useFreshArchiveScenarioMeter(t *testing.T) *archiveScenarioMeter {
	t.Helper()
	previous := defaultArchiveScenario
	meter := &archiveScenarioMeter{seconds: make(map[int64]*archiveScenarioBucket)}
	defaultArchiveScenario = meter
	t.Cleanup(func() { defaultArchiveScenario = previous })
	return meter
}

func TestArchiveScenarioSeparatesPositiveMissAndNegativeHit(t *testing.T) {
	useFreshArchiveScenarioMeter(t)
	ResetArchiveScenario("cache-penetration", "negative-cache", "protected", 900004, false, 0)
	RecordArchiveScenarioSample(ArchiveScenarioSample{
		RedisMiss: true, NegativeCacheHit: true, Nonexistent: true,
		ExpectedNotFound: true, Duration: 2 * time.Millisecond,
	})

	snapshot := SnapshotArchiveScenario()
	if snapshot.Round.Requests != 1 || snapshot.Round.RedisMisses != 1 ||
		snapshot.Round.NegativeCacheHits != 1 || snapshot.Round.PositiveCacheHits != 0 {
		t.Fatalf("positive MISS and negative HIT were not kept separate: %+v", snapshot.Round)
	}
	if snapshot.Round.HitRate != 0 || snapshot.Round.ExpectedNotFound != 1 || snapshot.Round.Errors != 0 {
		t.Fatalf("expected 404 must not become a normal hit or system error: %+v", snapshot.Round)
	}
}

func TestArchiveScenarioRecoveryRequiresThreeCleanSeconds(t *testing.T) {
	meter := useFreshArchiveScenarioMeter(t)
	now := time.Now()
	meter.active = true
	meter.scenario = "cache-breakdown"
	meter.phase = "recovering"
	meter.keyPresent = true
	meter.evictedAt = now.Add(-11 * time.Second)
	meter.rebuiltAt = now.Add(-10 * time.Second)
	for offset := int64(1); offset <= archiveScenarioStableSeconds; offset++ {
		meter.seconds[now.Unix()-offset] = &archiveScenarioBucket{
			ArchiveScenarioCounters: ArchiveScenarioCounters{Requests: 100, PositiveCacheHits: 100},
		}
	}

	snapshot := SnapshotArchiveScenario()
	if snapshot.Phase != "recovered" || snapshot.StableAt == "" || snapshot.RecoveryDurationMS <= 0 {
		t.Fatalf("three clean seconds should close the recovery window: %+v", snapshot)
	}
}
