package service

import (
	"silas/internal/database"
	"testing"
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
