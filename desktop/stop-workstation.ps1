$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$PidFile = Join-Path $Root "data\agency-workstation.pid"

if (!(Test-Path $PidFile)) {
  Write-Host "No desktop workstation pid file found."
  exit 0
}

$pidValue = Get-Content -Raw $PidFile
if (!$pidValue) {
  Remove-Item -Force $PidFile
  Write-Host "Empty pid file removed."
  exit 0
}

$process = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
if ($process) {
  Stop-Process -Id $process.Id
  Write-Host "Stopped Agency Workforce OS process $($process.Id)."
} else {
  Write-Host "Process $pidValue is not running."
}
Remove-Item -Force $PidFile