#Requires -Version 5.1
<#
.SYNOPSIS
    Starts the Nexus Downloader local bridge if it is not already running.
.DESCRIPTION
    Also warns when the bridge already on the port is an older build: v0.3 added
    the Collections endpoints (/check, /idmHistory, subdir), and an old process
    keeps answering /ping, so the extension would only report "bridge too old".
#>
[CmdletBinding()]
param(
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'

$port = 38765
$server = Join-Path $PSScriptRoot 'server.js'
$expected = ''
try {
    $match = Select-String -LiteralPath $server -Pattern "^const VERSION = '([0-9.]+)';" | Select-Object -First 1
    if ($match) { $expected = $match.Matches[0].Groups[1].Value }
} catch {
    # version is only used for the warning
}

function Get-BridgePidFromLog([string]$LogPath, [int]$LocalPort) {
    # netstat is not reliable in every shell/profile; the bridge logs its own pid
    # with the address it bound, so the log is the dependable source.
    if (-not (Test-Path -LiteralPath $LogPath)) { return 0 }
    $found = 0
    foreach ($line in (Get-Content -LiteralPath $LogPath -Tail 2000)) {
        if (-not $line) { continue }
        try { $entry = $line | ConvertFrom-Json } catch { continue }
        if ($entry.event -ne 'bridge-start') { continue }
        if ([string]$entry.address -notmatch ":$LocalPort$") { continue }
        if ($entry.pid) { $found = [int]$entry.pid }
    }
    return $found
}

try {
    $existing = Invoke-RestMethod -Uri "http://127.0.0.1:$port/ping" -TimeoutSec 2
    if ($existing.ok) {
        $versionMatches = (-not $expected -or $existing.bridge -eq $expected)
        if (-not $Restart -and $versionMatches) {
            Write-Host "Bridge already running on http://127.0.0.1:$port (v$($existing.bridge))"
            $existing | ConvertTo-Json -Depth 3
            exit 0
        }

        if (-not $versionMatches) {
            Write-Warning "An older bridge (v$($existing.bridge), expected v$expected) is already running on port $port."
        }
        if (-not $Restart) {
            Write-Warning "Stop that process, or run: powershell -ExecutionPolicy Bypass -File .\bridge\start.ps1 -Restart"
            exit 1
        }

        $ownerPid = Get-BridgePidFromLog (Join-Path $PSScriptRoot 'bridge.log') $port
        if ($ownerPid -gt 0) {
            $owner = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
            if (-not $owner -or $owner.ProcessName -ne 'node') {
                Write-Warning "Log points at pid $ownerPid, which is not a node process visible to you."
                Write-Warning "The old bridge was probably started elevated (or by another user). End node.exe in Task Manager (run as administrator), then run this script again."
                exit 1
            }
            Write-Host "Stopping old bridge (pid $ownerPid)..."
            try {
                Stop-Process -Id $ownerPid -Force -ErrorAction Stop
                Start-Sleep -Milliseconds 700
            } catch {
                Write-Warning "Could not stop pid $ownerPid : $($_.Exception.Message). Close it manually and run again."
                exit 1
            }
        } else {
            Write-Warning "Could not find the old bridge process in bridge.log. Close it manually (Task Manager -> node.exe) and run again."
            exit 1
        }
    }
}
catch {
    # not running yet
}

$node = (Get-Command node -ErrorAction Stop).Source
$process = Start-Process -FilePath $node -ArgumentList "`"$server`"" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
Start-Sleep -Milliseconds 800

try {
    $ping = Invoke-RestMethod -Uri "http://127.0.0.1:$port/ping" -TimeoutSec 3
}
catch {
    throw "Bridge failed to start. Check $PSScriptRoot\bridge.log"
}

Write-Host "Bridge started (pid $($process.Id)) on http://127.0.0.1:$port (v$($ping.bridge))"
$ping | ConvertTo-Json -Depth 3
