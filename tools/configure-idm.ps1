#Requires -Version 5.1
<#
.SYNOPSIS
    Makes IDM start command-line downloads without confirmation dialogs.

.DESCRIPTION
    IDM 6.42 honours these three HKCU values for command-line downloads, but
    /n does not override them:
      StartDlgShowing    - show the "Start download" dialog
      ComplDlgShowing    - show the "Download complete" dialog
      startImmediately    - start queued downloads immediately

    The original values are backed up once to idm-settings-backup.json so this
    can be reverted with restore-idm.ps1.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$base = 'HKCU:\Software\DownloadManager'
$backupPath = Join-Path $PSScriptRoot 'idm-settings-backup.json'
$names = @('StartDlgShowing', 'ComplDlgShowing', 'startImmediately')

if (-not (Test-Path -LiteralPath $base)) {
    throw "IDM registry key not found: $base"
}

if (-not (Test-Path -LiteralPath $backupPath)) {
    $backup = [ordered]@{ backedUpAt = (Get-Date).ToString('o') }
    foreach ($name in $names) {
        $value = Get-ItemProperty -Path $base -Name $name -ErrorAction SilentlyContinue
        $backup[$name] = if ($null -ne $value) { $value.$name } else { $null }
    }
    $backup | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $backupPath -Encoding UTF8
    Write-Host "Backed up IDM settings to $backupPath"
}
else {
    Write-Host "Backup already exists: $backupPath"
}

Set-ItemProperty -Path $base -Name 'StartDlgShowing' -Value 0 -Type DWord
Set-ItemProperty -Path $base -Name 'ComplDlgShowing' -Value 0 -Type DWord
Set-ItemProperty -Path $base -Name 'startImmediately' -Value 1 -Type DWord

Write-Host 'IDM now starts command-line downloads silently.'

$idm = 'C:\Program Files (x86)\Internet Download Manager\IDMan.exe'
if (Test-Path -LiteralPath $idm) {
    Get-Process IDMan -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 800
    Start-Process -FilePath $idm
    Start-Sleep -Seconds 3
    Write-Host 'IDM restarted.'
}
