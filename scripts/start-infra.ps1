# Start only the services the local Go app depends on.
# The Go app itself should run on the host with scripts/run-local-app.ps1.

$ErrorActionPreference = "Stop"

Set-Location -Path (Resolve-Path "$PSScriptRoot\..")

function Wait-ContainerHealthy {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [int]$TimeoutSeconds = 90
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $status = docker inspect -f "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" $Name 2>$null
        if ($status -eq "healthy" -or $status -eq "running") {
            Write-Host "$Name ready: $status"
            return
        }
        Start-Sleep -Seconds 2
    }

    throw "$Name is not ready after $TimeoutSeconds seconds"
}

function Wait-ContainerExitedZero {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [int]$TimeoutSeconds = 120
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $state = docker inspect -f "{{.State.Status}} {{.State.ExitCode}}" $Name 2>$null
        if ($state) {
            $parts = $state.Split(" ")
            $status = $parts[0]
            $exitCode = [int]$parts[1]
            if ($status -eq "exited" -and $exitCode -eq 0) {
                Write-Host "$Name completed"
                return
            }
            if ($status -eq "exited" -and $exitCode -ne 0) {
                throw "$Name exited with code $exitCode"
            }
        }
        Start-Sleep -Seconds 2
    }

    throw "$Name did not complete after $TimeoutSeconds seconds"
}

docker compose up -d mysql redis rocketmq-namesrv rocketmq-broker

Wait-ContainerHealthy "lottery-mysql"
Wait-ContainerHealthy "lottery-redis"
Wait-ContainerHealthy "lottery-rocketmq-namesrv"
Wait-ContainerHealthy "lottery-rocketmq-broker"

docker compose up -d --force-recreate rocketmq-init
Wait-ContainerExitedZero "lottery-rocketmq-init"

docker compose ps mysql redis rocketmq-namesrv rocketmq-broker rocketmq-init
