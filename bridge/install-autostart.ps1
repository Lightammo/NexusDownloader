#Requires -Version 5.1
<#
.SYNOPSIS
    Adds a Startup shortcut so the local bridge runs at login, then starts it.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$server = Join-Path $PSScriptRoot 'server.js'
$node = (Get-Command node -ErrorAction Stop).Source
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'Nexus Downloader Bridge.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $node
$shortcut.Arguments = '"' + $server + '"'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.WindowStyle = 0
$shortcut.Description = 'Nexus Downloader local bridge'
$shortcut.Save()

Write-Host "Created startup shortcut: $shortcutPath"
& (Join-Path $PSScriptRoot 'start.ps1')
