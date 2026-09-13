# Registers the native messaging host with Firefox for the current Windows user.
# No admin rights needed. Re-run it if you move the project folder.

$ErrorActionPreference = 'Stop'

$hostName = 'keepass_launcher'
$extensionId = 'keepass-launcher@local'
$manifestPath = Join-Path $PSScriptRoot "$hostName.json"
$registryKey = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"

$manifest = [ordered]@{
    name               = $hostName
    description        = 'KeePass Launcher database file reader'
    path               = Join-Path $PSScriptRoot 'host.bat'
    type               = 'stdio'
    allowed_extensions = @($extensionId)
}

# Write without a BOM; Firefox's JSON parser does not accept one.
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

New-Item -Path $registryKey -Force | Out-Null
Set-ItemProperty -Path $registryKey -Name '(default)' -Value $manifestPath

Write-Host "Registered native host '$hostName' -> $manifestPath"
