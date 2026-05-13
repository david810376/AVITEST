param(
  [string]$InstallDir = "C:\Program Files\Plustek\WebFXScan2",
  [string]$PfxPassword = "1234567",
  [string]$RemoteOrigin = "https://avitest-iota.vercel.app",
  [switch]$SkipStart
)

$ErrorActionPreference = "Stop"

function Write-Step($Message) {
  Write-Host ""
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Fail($Message) {
  Write-Host ""
  Write-Host "ERROR: $Message" -ForegroundColor Red
  exit 1
}

$webScanExe = Join-Path $InstallDir "WebScan2.exe"
$iniPath = Join-Path $InstallDir "LibWebFxScan.ini"

Write-Step "Checking WebFXScan2 files"
if (!(Test-Path -LiteralPath $webScanExe)) {
  Fail "WebScan2.exe was not found at $webScanExe"
}
if (!(Test-Path -LiteralPath $iniPath)) {
  Fail "LibWebFxScan.ini was not found at $iniPath"
}

$ini = Get-Content -LiteralPath $iniPath -Raw
Write-Host $ini

$certificateMatch = [regex]::Match($ini, "(?m)^\s*Certificate\s*=\s*(.+?)\s*$")
if (!$certificateMatch.Success) {
  Fail "LibWebFxScan.ini does not contain a Certificate= setting."
}

$certificateName = $certificateMatch.Groups[1].Value.Trim().Trim('"')
$pfxPath = if ([System.IO.Path]::IsPathRooted($certificateName)) {
  $certificateName
} else {
  Join-Path $InstallDir $certificateName
}

if (!(Test-Path -LiteralPath $pfxPath)) {
  Fail "The certificate file from LibWebFxScan.ini was not found: $pfxPath"
}

if ($ini -notmatch "(?m)^\s*Port\s*=\s*17778\s*$") {
  Write-Warning "LibWebFxScan.ini does not show Port = 17778."
}
if ($ini -notmatch "(?m)^\s*WSS\s*=\s*1\s*$") {
  Write-Warning "LibWebFxScan.ini does not show WSS=1. The browser code expects wss://."
}
Write-Host "Certificate file: $pfxPath"

Write-Step "Importing WebScan2 certificate into CurrentUser trusted roots"
$securePassword = ConvertTo-SecureString $PfxPassword -AsPlainText -Force
certutil -f -user -p $PfxPassword -importpfx Root $pfxPath | Write-Host

$certs = Get-ChildItem Cert:\CurrentUser\Root | Where-Object {
  $_.Subject -match "127\.0\.0\.1|localhost|Plustek" -or
  $_.FriendlyName -match "Plustek|WebFX|WebScan"
}

if (!$certs) {
  Write-Warning "No obvious WebScan2 certificate was found in CurrentUser trusted roots."
} else {
  $certs | Select-Object Subject, FriendlyName, Thumbprint, NotAfter | Format-Table -AutoSize
}

if (!$SkipStart) {
  Write-Step "Starting WebScan2.exe if needed"
  $running = Get-Process -Name "WebScan2" -ErrorAction SilentlyContinue
  if (!$running) {
    Start-Process -FilePath $webScanExe -WorkingDirectory $InstallDir
    Start-Sleep -Seconds 2
  }
}

Write-Step "Checking port 17778"
$connections = Get-NetTCPConnection -LocalPort 17778 -ErrorAction SilentlyContinue
if (!$connections) {
  Fail "Nothing is listening on port 17778. Start WebScan2.exe and run this script again."
}

$connections | Select-Object LocalAddress, LocalPort, State, OwningProcess, @{
  Name = "Process"
  Expression = { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName }
} | Format-Table -AutoSize

Write-Step "Testing https://localhost:17778/"
try {
  $response = Invoke-WebRequest -UseBasicParsing https://localhost:17778/ -TimeoutSec 5
  Write-Host "HTTP status: $($response.StatusCode)"
} catch {
  $statusCode = $_.Exception.Response.StatusCode.value__
  if ($statusCode -eq 501) {
    Write-Host "HTTP status: 501 Not Implemented"
    Write-Host "This is OK. It means the browser can reach the local WebScan2 HTTPS/WSS endpoint."
  } else {
    Write-Host $_.Exception.Message -ForegroundColor Yellow
    Fail "The local HTTPS/WSS endpoint is not trusted or not reachable."
  }
}

Write-Step "Testing WebSocket handshake with remote site Origin"
$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if (!$curl) {
  Write-Warning "curl.exe was not found. Skipping WebSocket Origin handshake test."
} else {
  $curlOutput = & curl.exe -vk --http1.1 `
    -H "Connection: Upgrade" `
    -H "Upgrade: websocket" `
    -H "Sec-WebSocket-Version: 13" `
    -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" `
    -H "Origin: $RemoteOrigin" `
    "https://localhost:17778/webscan2" `
    --max-time 5 2>&1

  $curlText = ($curlOutput | Out-String)
  if ($curlText -match "101 Switching Protocols") {
    Write-Host "WebSocket handshake accepted for Origin: $RemoteOrigin"
  } else {
    Write-Host $curlText -ForegroundColor Yellow
    Fail "WebScan2 did not accept the WebSocket handshake for Origin: $RemoteOrigin"
  }
}

Write-Step "Done"
Write-Host "Now open https://localhost:17778/ in the same browser used for the Vercel demo."
Write-Host "Expected browser result: 501 Not Implemented."
Write-Host "Then open https://avitest-iota.vercel.app/"
