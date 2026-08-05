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

func TestQueryTideWhitelist(t *testing.T) {
	expected := map[int]TierID{
		100:  TierQPS100,
		300:  TierQPS300,
		800:  TierQPS800,
		1500: TierQPS1500,
	}
	for rate, expectedID := range expected {
		config, ok := ResolveRate(rate)
		if !ok {
			t.Fatalf("rate %d missing", rate)
		}
		if config.ID != expectedID || config.Rate != rate || config.Connections != 0 ||
			config.DurationSeconds != DefaultDurationSeconds {
			t.Fatalf("rate %d mismatch: %+v", rate, config)
		}
	}
	if _, ok := ResolveRate(500); ok {
		t.Fatal("500 QPS must not be accepted by the new query tide protocol")
	}
}

func TestCreateRequestAcceptsControlledConnectionModes(t *testing.T) {
	auto := CreateRequest{
		Experiment:     ExperimentCacheAsideRead,
		ArchiveID:      StarMarrowArchiveID,
		Mode:           "direct",
		Rate:           800,
		ConnectionMode: ConnectionModeAuto,
	}
	config, message := ValidateCreateRequest(auto)
	if message != "" {
		t.Fatal(message)
	}
	if config.Rate != 800 || config.Connections != 0 {
		t.Fatalf("unexpected auto config before runner resolution: %+v", config)
	}

	manual := auto
	manual.ConnectionMode = ConnectionModeManual
	manual.Connections = 300
	config, message = ValidateCreateRequest(manual)
	if message != "" {
		t.Fatal(message)
	}
	if config.Connections != 300 {
		t.Fatalf("manual connections not preserved: %+v", config)
	}
}

func TestCreateRequestRejectsUncontrolledInputs(t *testing.T) {
	tests := []CreateRequest{
		{Experiment: "shell", ArchiveID: StarMarrowArchiveID, Mode: "cached", Tier: TierVisitors},
		{Experiment: ExperimentCacheAsideRead, ArchiveID: 2, Mode: "cached", Tier: TierVisitors},
		{Experiment: ExperimentCacheAsideRead, ArchiveID: 99, Mode: "cached", Tier: TierVisitors},
		{Experiment: ExperimentCacheAsideRead, ArchiveID: StarMarrowArchiveID, Mode: "http://example.com", Tier: TierVisitors},
		{Experiment: ExperimentCacheAsideRead, ArchiveID: StarMarrowArchiveID, Mode: "cached", Tier: TierID("custom")},
		{Experiment: ExperimentCacheAsideRead, ArchiveID: StarMarrowArchiveID, Mode: "cached", Rate: 500},
		{Experiment: ExperimentCacheAsideRead, ArchiveID: StarMarrowArchiveID, Mode: "cached", Tier: TierVisitors, Rate: 100},
		{
			Experiment: ExperimentCacheAsideRead, ArchiveID: StarMarrowArchiveID, Mode: "cached", Rate: 800,
			ConnectionMode: ConnectionModeAuto, Connections: 300,
		},
		{
			Experiment: ExperimentCacheAsideRead, ArchiveID: StarMarrowArchiveID, Mode: "cached", Rate: 800,
			ConnectionMode: ConnectionModeManual, Connections: 64,
		},
	}
	for _, input := range tests {
		if _, message := ValidateCreateRequest(input); message == "" {
			t.Fatalf("expected request to be rejected: %+v", input)
		}
	}
}

func TestValidateSeckillExperimentsKeepVariablesIsolated(t *testing.T) {
	rateTier, message := ValidateCreateRequest(CreateRequest{
		Experiment: ExperimentSeckillRateLimit,
		Rate:       1500,
	})
	if message != "" {
		t.Fatalf("valid rate-limit request rejected: %s", message)
	}
	if rateTier.Rate != 1500 || rateTier.DurationSeconds != SeckillRateDurationSeconds || rateTier.Connections != 70 {
		t.Fatalf("unexpected rate-limit tier: %+v", rateTier)
	}

	stockTier, message := ValidateCreateRequest(CreateRequest{Experiment: ExperimentSeckillStockBurst})
	if message != "" {
		t.Fatalf("valid stock burst rejected: %s", message)
	}
	if stockTier.Connections != SeckillStockConcurrency || stockTier.Rate != 0 {
		t.Fatalf("unexpected stock burst tier: %+v", stockTier)
	}

	invalid := []CreateRequest{
		{Experiment: ExperimentSeckillRateLimit, Rate: 500},
		{Experiment: ExperimentSeckillRateLimit, Rate: 800, ArchiveID: 4},
		{Experiment: ExperimentSeckillStockBurst, Rate: 300},
		{Experiment: ExperimentSeckillStockBurst, Connections: 70},
	}
	for _, input := range invalid {
		if _, detail := ValidateCreateRequest(input); detail == "" {
			t.Fatalf("expected isolated seckill workload to reject %+v", input)
		}
	}
}
