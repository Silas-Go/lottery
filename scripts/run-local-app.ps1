# Run the Go app on the host while MySQL, Redis, and RocketMQ run in Docker.

$ErrorActionPreference = "Stop"

Set-Location -Path (Resolve-Path "$PSScriptRoot\..")

& "$PSScriptRoot\start-infra.ps1"

# Free localhost:5678 if an old containerized app is still around.
$oldAppContainer = docker ps -aq --filter "name=^/lottery-app$"
if ($oldAppContainer) {
    docker stop lottery-app | Out-Null
}

if (-not (Test-Path ".\log")) {
    New-Item -ItemType Directory -Path ".\log" | Out-Null
}

$env:COMPUTERNAME = "itcheer"
$env:LOTTERY_HTTP_ADDR = "localhost:5678"
$env:LOTTERY_MYSQL_HOST = "127.0.0.1"
$env:LOTTERY_MYSQL_PORT = "3306"
$env:LOTTERY_MYSQL_USER = "tester"
$env:LOTTERY_MYSQL_PASSWORD = "123456"
$env:LOTTERY_MYSQL_DATABASE = "lottery"
$env:LOTTERY_REDIS_ADDR = "127.0.0.1:6379"
$env:LOTTERY_REDIS_DB = "2"
$env:LOTTERY_MQ_ENABLED = "true"
$env:LOTTERY_MQ_ENDPOINT = "127.0.0.1:8081"
$env:LOTTERY_MQ_TOPIC = "CANCEL_ORDER"
$env:LOTTERY_MQ_CONSUMER_GROUP = "lottery"
$env:LOTTERY_COOKIE_DOMAIN = "localhost"
$env:LOTTERY_RATE_LIMIT_QPS = "800"

Write-Host "Starting local Go app at http://localhost:5678/"
Write-Host "Press Ctrl+C to stop the app. Docker infra will keep running."

go run .
