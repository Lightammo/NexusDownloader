#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$base = 'HKCU:\Software\DownloadManager'
$backupPath = Join-Path $PSScriptRoot 'idm-settings-backup.json'

if (-not (Test-Path -LiteralPath $backupPath)) {
    throw "No backup found: $backupPath"
}

$backup = Get-Content -LiteralPath $backupPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($name in @('StartDlgShowing', 'ComplDlgShowing', 'startImmediately')) {
    $value = $backup.$name
    if ($null -ne $value) {
        Set-ItemProperty -Path $base -Name $name -Value ([int]$value) -Type DWord
        Write-Host "restored $name = $value"
    }
}

Write-Host 'Original IDM dialog settings restored. Restart IDM to apply.'
