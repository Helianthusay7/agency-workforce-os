param(
  [switch]$Build,
  [switch]$NoBrowser,
  [string]$DataDir
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
if (!$DataDir) {
  $DataDir = if ($env:AGENCY_DATA_DIR) { $env:AGENCY_DATA_DIR } else { Join-Path $Root "data" }
}
$PidFile = Join-Path $DataDir "agency-workstation.pid"
$SecretFile = Join-Path $DataDir "auth.secret.local"
$HostName = if ($env:AGENCY_HOST) { $env:AGENCY_HOST } else { "127.0.0.1" }
$Port = if ($env:PORT) { [int]$env:PORT } else { 4173 }
$Url = "http://${HostName}:${Port}/"

function Test-HttpOk($targetUrl) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing $targetUrl -TimeoutSec 2
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
  } catch {
    return $false
  }
}

function New-LocalSecret {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return [Convert]::ToBase64String($bytes)
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

if (!(Test-Path $SecretFile)) {
  New-LocalSecret | Set-Content -NoNewline -Encoding ascii $SecretFile
}

$env:AGENCY_AUTH_SECRET = Get-Content -Raw $SecretFile
$env:AGENCY_HOST = $HostName
$env:PORT = [string]$Port
$env:AGENCY_DESKTOP_MODE = "true"
$env:AGENCY_STATE_FILE = Join-Path $DataDir "state.local.json"

$node = Get-Command node -ErrorAction SilentlyContinue
if (!$node) {
  throw "Node.js 20+ is required. Install Node.js, then run this launcher again."
}

$serverJs = Join-Path $Root "dist\server.js"
$clientJs = Join-Path $Root "public\app.js"
if ($Build -or !(Test-Path $serverJs) -or !(Test-Path $clientJs)) {
  Push-Location $Root
  try {
    npm.cmd run build
  } finally {
    Pop-Location
  }
}

if (!(Test-HttpOk $Url)) {
  if (Test-Path $PidFile) {
    $oldPid = Get-Content -Raw $PidFile
    if ($oldPid -and (Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue)) {
      Write-Host "Existing workstation process is running but did not respond at $Url"
    }
  }

  $process = Start-Process -FilePath "node" -ArgumentList @("dist/server.js") -WorkingDirectory $Root -PassThru -WindowStyle Hidden
  Set-Content -NoNewline -Encoding ascii $PidFile ([string]$process.Id)

  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-HttpOk $Url) {
      $ready = $true
      break
    }
  }
  if (!$ready) {
    throw "Workstation did not start at $Url. Check the Node process or run npm run dev manually."
  }
}

if (!$NoBrowser) {
  Start-Process $Url
}
Write-Host "Agency Workforce OS is running at $Url"
Write-Host "State file: $env:AGENCY_STATE_FILE"
Write-Host "Stop it with: npm run desktop:stop"