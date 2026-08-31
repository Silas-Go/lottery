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
	if snapshot.Recovered.Requests != 100 || snapshot.Recovered.HitRate != 100 {
		t.Fatalf("recovered comparison window was not frozen: %+v", snapshot.Recovered)
	}
}

func TestArchiveScenarioFreezesStableImpactAndRecoveredWindows(t *testing.T) {
	meter := useFreshArchiveScenarioMeter(t)
	now := time.Now()
	meter.active = true
	meter.scenario = "cache-breakdown"
	meter.phase = "stable"
	meter.seconds[now.Unix()-1] = &archiveScenarioBucket{
		ArchiveScenarioCounters: ArchiveScenarioCounters{Requests: 300, PositiveCacheHits: 300},
		latencies:               []int64{1, 1, 2},
	}

	RecordArchiveScenarioEvicted(now)
	RecordArchiveScenarioSample(ArchiveScenarioSample{
		RedisMiss: true, MySQLFallback: true, CacheRebuilt: true,
		Duration: 4 * time.Millisecond,
	})
	RecordArchiveScenarioSample(ArchiveScenarioSample{
		RedisMiss: true, Coalesced: true, Duration: 3 * time.Millisecond,
	})
	RecordArchiveScenarioSample(ArchiveScenarioSample{
		PositiveCacheHit: true, Duration: time.Millisecond,
	})

	snapshot := SnapshotArchiveScenario()
	if snapshot.Stable.Requests != 300 || snapshot.Stable.HitRate != 100 {
		t.Fatalf("stable comparison window was not frozen: %+v", snapshot.Stable)
	}
	if snapshot.Impact.Requests != 3 || snapshot.Impact.RedisMisses != 2 ||
		snapshot.Impact.MySQLFallbacks != 1 || snapshot.Impact.CoalescedAfterMiss != 1 ||
		snapshot.Impact.CacheRebuilds != 1 {
		t.Fatalf("impact comparison window did not preserve real paths: %+v", snapshot.Impact)
	}
	if snapshot.Impact.HitRate <= 0 || snapshot.Impact.HitRate >= 100 || snapshot.Impact.MaxLatency != 4 {
		t.Fatalf("impact comparison window did not preserve rate or latency: %+v", snapshot.Impact)
	}
}

func TestArchiveScenarioReportsBackendRebuildWindow(t *testing.T) {
	meter := useFreshArchiveScenarioMeter(t)
	now := time.Now()
	meter.active = true
	meter.scenario = "cache-breakdown"
	meter.evictedAt = now.Add(-115 * time.Millisecond)
	meter.rebuiltAt = now

	snapshot := SnapshotArchiveScenario()
	if snapshot.EvictedAt == "" || snapshot.RebuiltAt == "" || snapshot.RebuildDurationMS != 115 {
		t.Fatalf("rebuild window must come from backend event timestamps: %+v", snapshot)
	}
}

func TestArchiveScenarioKeepsImpactOpenUntilSlowRebuildCompletes(t *testing.T) {
	meter := useFreshArchiveScenarioMeter(t)
	meter.active = true
	meter.scenario = "cache-breakdown"
	meter.evictedAt = time.Now().Add(-2 * time.Second)

	RecordArchiveScenarioSample(ArchiveScenarioSample{
		RedisMiss: true, MySQLFallback: true, CacheRebuilt: true, Duration: 2 * time.Second,
	})
	snapshot := SnapshotArchiveScenario()
	if snapshot.Impact.Requests != 1 || snapshot.Impact.MySQLFallbacks != 1 || snapshot.Impact.CacheRebuilds != 1 {
		t.Fatalf("slow rebuild must remain part of the real impact window: %+v", snapshot.Impact)
	}
}
