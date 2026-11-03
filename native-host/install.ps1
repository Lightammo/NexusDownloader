#Requires -Version 5.1
<#
.SYNOPSIS
    Installs the Nexus Downloader native messaging host for Chromium browsers.

.DESCRIPTION
    - builds NexusHost.exe (a tiny launcher for node host.js)
    - records the absolute path of node.exe
    - creates config.json on first run
    - writes the native messaging host manifest
    - registers the host under HKCU for Chrome / Edge / Brave / Chromium

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\native-host\install.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\native-host\install.ps1 -Browser chrome
#>
[CmdletBinding()]
param(
    [string[]]$Browser = @('chrome', 'edge'),

    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# powershell.exe -File passes "chrome,edge" as a single string, so normalise.
$Browser = @($Browser | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$validBrowsers = @('chrome', 'edge', 'brave', 'chromium')
foreach ($b in $Browser) {
    if ($validBrowsers -notcontains $b) {
        throw "Unsupported browser: $b. Valid values: $($validBrowsers -join ', ')"
    }
}

function Write-Step([string]$Text) {
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) {
    Write-Host "    $Text" -ForegroundColor Green
}

function Write-Warn2([string]$Text) {
    Write-Host "    $Text" -ForegroundColor Yellow
}

$hostDir = $PSScriptRoot
$rootDir = Split-Path -Parent $hostDir
$extensionDir = Join-Path $rootDir 'extension'
$extensionManifestPath = Join-Path $extensionDir 'manifest.json'

if (-not (Test-Path -LiteralPath $extensionManifestPath)) {
    throw "Extension manifest not found: $extensionManifestPath"
}

$extensionManifest = Get-Content -LiteralPath $extensionManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $extensionManifest.key) {
    throw "extension/manifest.json has no `"key`". Run 'node tools/gen-extension-key.js' first."
}

# --- extension id -----------------------------------------------------------
# Chrome extension id = first 16 bytes of SHA256(DER public key), each nibble
# mapped from 0..15 to a..p.
$der = [Convert]::FromBase64String([string]$extensionManifest.key)
$sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($der)
$idBuilder = New-Object System.Text.StringBuilder
for ($i = 0; $i -lt 16; $i++) {
    $b = [int]$sha[$i]
    [void]$idBuilder.Append([char](97 + ($b -shr 4)))
    [void]$idBuilder.Append([char](97 + ($b -band 0x0f)))
}
$extensionId = $idBuilder.ToString()

Write-Step "Extension ID: $extensionId"

# --- build the launcher -----------------------------------------------------
$cscCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) {
    throw "Cannot find csc.exe (.NET Framework 4.x). Install .NET Framework 4.8 or compile launcher/NexusHost.cs manually."
}

$launcherSource = Join-Path $hostDir 'launcher\NexusHost.cs'
$launcherExe = Join-Path $hostDir 'NexusHost.exe'
$needBuild = $Force -or (-not (Test-Path -LiteralPath $launcherExe))
if (-not $needBuild) {
    $needBuild = (Get-Item -LiteralPath $launcherSource).LastWriteTimeUtc -gt (Get-Item -LiteralPath $launcherExe).LastWriteTimeUtc
}

if ($needBuild) {
    Write-Step "Building NexusHost.exe"
    & $csc /nologo /target:exe /platform:x64 "/out:$launcherExe" $launcherSource
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcherExe)) {
        throw "Failed to compile $launcherExe (csc exit code $LASTEXITCODE)."
    }
    Write-Ok $launcherExe
}
else {
    Write-Ok "NexusHost.exe is up to date"
}

# --- node path --------------------------------------------------------------
Write-Step "Recording node.exe path"
$nodeCommand = Get-Command node -ErrorAction Stop
$nodePath = $nodeCommand.Source
if (-not $nodePath) { $nodePath = $nodeCommand.Path }
if (-not $nodePath -or -not (Test-Path -LiteralPath $nodePath)) {
    throw "node.exe not found in PATH."
}
[System.IO.File]::WriteAllText(
    (Join-Path $hostDir 'node_path.txt'),
    $nodePath,
    (New-Object System.Text.UTF8Encoding($false))
)
Write-Ok $nodePath

# --- config -----------------------------------------------------------------
$configPath = Join-Path $hostDir 'config.json'
if ($Force -or -not (Test-Path -LiteralPath $configPath)) {
    Write-Step "Creating config.json"

    $idmPath = ''
    try {
        $idmPath = [string](Get-ItemProperty -Path 'HKCU:\Software\DownloadManager' -Name ExePath -ErrorAction Stop).ExePath
    }
    catch { }

    if (-not $idmPath -or -not (Test-Path -LiteralPath $idmPath)) {
        $idmCandidates = @(
            (Join-Path $env:ProgramFiles 'Internet Download Manager\IDMan.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'Internet Download Manager\IDMan.exe')
        )
        foreach ($candidate in $idmCandidates) {
            if (Test-Path -LiteralPath $candidate) { $idmPath = $candidate; break }
        }
    }

    if (-not $idmPath -or -not (Test-Path -LiteralPath $idmPath)) {
        Write-Warn2 "IDM not found. Edit idmPath in $configPath before using."
        $idmPath = 'C:\Program Files (x86)\Internet Download Manager\IDMan.exe'
    }

    $config = [ordered]@{
        idmPath      = $idmPath
        downloadDir  = (Join-Path $rootDir 'downloads')
        allowedHosts = @('nexusmods.com', 'nexus-cdn.com')
        allowAnyHost = $false
        silent       = $true
        dryRun       = $false
    }
    $configJson = $config | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($configPath, $configJson, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok $configPath
}
else {
    Write-Ok "Keeping existing config.json"
}

# --- host manifest ----------------------------------------------------------
Write-Step "Writing native messaging host manifest"
$hostManifestPath = Join-Path $hostDir 'com.nexusdownloader.host.json'
$hostManifest = [ordered]@{
    name            = 'com.nexusdownloader.host'
    description     = 'Nexus Downloader native host (IDM bridge)'
    path            = $launcherExe
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$extensionId/")
}
$hostManifestJson = $hostManifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($hostManifestPath, $hostManifestJson, (New-Object System.Text.UTF8Encoding($false)))
Write-Ok $hostManifestPath

# --- registry ---------------------------------------------------------------
$registryRoots = [ordered]@{
    chrome   = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts'
    edge     = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
    brave    = 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
    chromium = 'HKCU:\Software\Chromium\NativeMessagingHosts'
}

foreach ($name in $Browser) {
    $root = $registryRoots[$name]
    if (-not $root) { throw "Unsupported browser: $name" }
    $key = Join-Path $root 'com.nexusdownloader.host'
    New-Item -Path $key -Force | Out-Null
    Set-Item -Path $key -Value $hostManifestPath
    Write-Ok "registered $name -> $key"
}

Write-Host ''
Write-Host 'Native host installed.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host "  1. Open chrome://extensions (or edge://extensions)"
Write-Host "  2. Enable 'Developer mode'"
Write-Host "  3. Click 'Load unpacked' and select: $extensionDir"
Write-Host "  4. Make sure the loaded extension id is: $extensionId"
Write-Host ''
Write-Host "Logs: $(Join-Path $hostDir 'logs\host.log')" -ForegroundColor DarkGray
