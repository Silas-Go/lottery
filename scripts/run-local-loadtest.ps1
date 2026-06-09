# Run wrk2 against the host Go app without starting the app container.

param(
    [int]$Rate = 500,
    [string]$Duration = "30s",
    [int]$Threads = 4,
    [int]$Connections = 128,
    [string]$Timeout = "2s",
    [string]$TargetUrl = "http://host.docker.internal:5678/lucky"
)

$ErrorActionPreference = "Stop"

Set-Location -Path (Resolve-Path "$PSScriptRoot\..")

try {
    Invoke-WebRequest -Uri "http://localhost:5678/api/metrics/snapshot" -UseBasicParsing -TimeoutSec 3 | Out-Null
} catch {
    Write-Warning "Local Go app is not responding at http://localhost:5678/. Start it with scripts/run-local-app.ps1 first."
}

Write-Host "Running wrk2 against $TargetUrl"
Write-Host "Rate=$Rate Duration=$Duration Threads=$Threads Connections=$Connections Timeout=$Timeout"

$composeArgs = @(
    "--profile", "loadtest",
    "run", "--rm", "--no-deps",
    "-e", "TARGET_URL=$TargetUrl",
    "-e", "RATE=$Rate",
    "-e", "DURATION=$Duration",
    "-e", "THREADS=$Threads",
    "-e", "CONNECTIONS=$Connections",
    "-e", "TIMEOUT=$Timeout",
    "wrk2"
)

docker compose @composeArgs
