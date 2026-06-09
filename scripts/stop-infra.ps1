# Stop Docker dependency services without deleting their data volumes.

$ErrorActionPreference = "Stop"

Set-Location -Path (Resolve-Path "$PSScriptRoot\..")

docker compose stop app rocketmq-init rocketmq-broker rocketmq-namesrv redis mysql
