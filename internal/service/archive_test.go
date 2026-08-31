package service

import (
	"silas/internal/database"
	"testing"
	"time"
)

func TestValidateArchiveMaterialIDOnlyAllowsStarMarrow(t *testing.T) {
	if appErr := validateArchiveMaterialID(database.StarMarrowMaterialID); appErr != nil {
		t.Fatalf("star marrow should be accepted: %v", appErr)
	}
	for _, id := range []int{1, 2, 3, 401, 402, 403} {
		appErr := validateArchiveMaterialID(id)
		if appErr == nil || appErr.Code != CodeArchiveNotFound {
			t.Fatalf("archive %d should be hidden, got %#v", id, appErr)
		}
	}
}

func TestArchiveExperimentOriginDelayIsExplicitAndOptional(t *testing.T) {
	if ArchiveCacheBreakdownOriginDelay != 100*time.Millisecond {
		t.Fatalf("unexpected backend origin delay: %s", ArchiveCacheBreakdownOriginDelay)
	}
	start := time.Now()
	waitArchiveExperimentOrigin(20 * time.Millisecond)
	if elapsed := time.Since(start); elapsed < 20*time.Millisecond {
		t.Fatalf("experiment origin delay was skipped: %s", elapsed)
	}

	// 普通 Cache-Aside 传入 0；该分支不创建额外的定时器或改变返回值。
	waitArchiveExperimentOrigin(0)
}
