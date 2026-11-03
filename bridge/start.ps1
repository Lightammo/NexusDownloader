#Requires -Version 5.1
<#
.SYNOPSIS
    Starts the Nexus Downloader local bridge if it is not already running.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$port = 38765
$server = Join-Path $PSScriptRoot 'server.js'

try {
    $existing = Invoke-RestMethod -Uri "http://127.0.0.1:$port/ping" -TimeoutSec 2
    if ($existing.ok) {
        Write-Host "Bridge already running on http://127.0.0.1:$port"
        $existing | ConvertTo-Json -Depth 3
        exit 0
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

Write-Host "Bridge started (pid $($process.Id)) on http://127.0.0.1:$port"
$ping | ConvertTo-Json -Depth 3
