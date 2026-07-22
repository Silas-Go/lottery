package loadtest

import "testing"

func TestTierWhitelist(t *testing.T) {
	expected := map[TierID]struct {
		rate        int
		connections int
	}{
		TierVisitors:    {rate: 100, connections: 16},
		TierTideEve:     {rate: 500, connections: 32},
		TierCrowd:       {rate: 1500, connections: 64},
		TierBoilingCity: {rate: 3000, connections: 96},
	}
	for id, want := range expected {
		config, ok := ResolveTier(id)
		if !ok {
			t.Fatalf("tier %s missing", id)
		}
		if config.Rate != want.rate || config.Connections != want.connections || config.DurationSeconds != 20 {
			t.Fatalf("tier %s mismatch: %+v", id, config)
		}
	}
}

func TestCreateRequestRejectsUncontrolledInputs(t *testing.T) {
	tests := []CreateRequest{
		{Experiment: "shell", ArchiveID: 2, Mode: "cached", Tier: TierVisitors},
		{Experiment: ExperimentCacheAsideRead, ArchiveID: 99, Mode: "cached", Tier: TierVisitors},
		{Experiment: ExperimentCacheAsideRead, ArchiveID: 2, Mode: "http://example.com", Tier: TierVisitors},
		{Experiment: ExperimentCacheAsideRead, ArchiveID: 2, Mode: "cached", Tier: TierID("custom")},
	}
	for _, input := range tests {
		if _, message := ValidateCreateRequest(input); message == "" {
			t.Fatalf("expected request to be rejected: %+v", input)
		}
	}
}
