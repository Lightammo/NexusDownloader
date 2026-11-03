#Requires -Version 5.1
[CmdletBinding()]
param(
    [string[]]$Browser = @('chrome', 'edge', 'brave', 'chromium')
)

$ErrorActionPreference = 'Stop'

# powershell.exe -File passes "chrome,edge" as a single string, so normalise.
$Browser = @($Browser | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

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
    if (Test-Path -LiteralPath $key) {
        Remove-Item -LiteralPath $key -Recurse -Force
        Write-Host "removed $name native host registration"
    }
    else {
        Write-Host "not registered: $name"
    }
}

Write-Host 'Done. You can also remove the unpacked extension from chrome://extensions.'
