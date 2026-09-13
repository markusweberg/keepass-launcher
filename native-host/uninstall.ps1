# Removes the native messaging host registration created by install.ps1.

$ErrorActionPreference = 'Stop'

$hostName = 'keepass_launcher'
$registryKey = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"
$manifestPath = Join-Path $PSScriptRoot "$hostName.json"

if (Test-Path $registryKey) { Remove-Item -Path $registryKey -Recurse }
if (Test-Path $manifestPath) { Remove-Item -Path $manifestPath }

Write-Host "Unregistered native host '$hostName'"
