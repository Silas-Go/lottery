package metrics

import (
	"testing"
	"time"
)

func TestArchiveReadMetricsKeepPathsIndependent(t *testing.T) {
	ResetArchiveRead()
	t.Cleanup(ResetArchiveRead)

	RecordArchiveRequest(ArchivePathDirect)
	RecordArchiveSQLQueries(ArchivePathDirect, 9*time.Millisecond, 4, 2, 20)
	RecordArchiveLatency(ArchivePathDirect, 12*time.Millisecond, false)

	RecordArchiveRequest(ArchivePathCached)
	RecordArchiveCacheMiss()
	RecordArchiveSQLQueries(ArchivePathCached, 5*time.Millisecond, 4, 1, 20)
	RecordArchiveLatency(ArchivePathCached, 7*time.Millisecond, false)
	RecordArchiveRequest(ArchivePathCached)
	RecordArchiveCacheHit()
	RecordArchiveLatency(ArchivePathCached, time.Millisecond, false)

	snapshot := SnapshotArchiveRead(ArchiveCacheTTL)
	if snapshot.Direct.TotalRequests != 1 || snapshot.Direct.SQLQueries != 4 || snapshot.Direct.DBReads != 4 {
		t.Fatalf("unexpected direct snapshot: %+v", snapshot.Direct)
	}
	if snapshot.Direct.CacheHits != 0 || snapshot.Direct.CacheMisses != 0 {
		t.Fatalf("direct path must not inherit cache counters: %+v", snapshot.Direct)
	}
	if snapshot.Cached.TotalRequests != 2 || snapshot.Cached.SQLQueries != 4 || snapshot.Cached.DBReads != 4 {
		t.Fatalf("unexpected cached snapshot: %+v", snapshot.Cached)
	}
	if snapshot.Cached.CacheHitRate != 50 {
		t.Fatalf("expected 50%% hit rate, got %d", snapshot.Cached.CacheHitRate)
	}
	if snapshot.Cached.P99 != 1 {
		t.Fatalf("expected bounded sorted P99 sample, got %d", snapshot.Cached.P99)
	}
}
