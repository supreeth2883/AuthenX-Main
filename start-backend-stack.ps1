[CmdletBinding()]
param(
  [string]$PgHost = 'localhost',
  [int]$PgPort = 5432,
  [string]$PgUser = 'postgres',
  [SecureString]$PgPassword,
  [string]$PgDatabase = 'postgres',
  [int]$BackendPort = 3001,
  [int]$HsmPort = 9099,
  [int]$StartupTimeoutSec = 25,
  [switch]$SkipPostgresValidation,
  [switch]$SkipCvrSeed
)

$ErrorActionPreference = 'Stop'

function Write-Step {
  param([string]$Message)
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function ConvertTo-PlainText {
  param([SecureString]$SecureValue)
  if ($null -eq $SecureValue) { return '' }

  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function ConvertTo-SingleQuotedPsString {
  param([string]$Value)
  if ($null -eq $Value) { return '' }
  return $Value -replace "'", "''"
}

function Get-LocalListeningProcessId {
  param([int]$Port)
  try {
    return Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1 -ExpandProperty OwningProcess
  } catch {
    return $null
  }
}

function Test-PortFree {
  param([int]$Port)
  return -not (Get-LocalListeningProcessId -Port $Port)
}

function Test-TcpPortReachable {
  param(
    [string]$HostName,
    [int]$Port,
    [int]$TimeoutMs = 2000
  )

  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connectTask = $client.ConnectAsync($HostName, $Port)
    if (-not $connectTask.Wait($TimeoutMs)) {
      return $false
    }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Get-HttpJson {
  param(
    [string]$Url,
    [int]$TimeoutSec = 3
  )
  try {
    return Invoke-RestMethod -Uri $Url -Method GET -TimeoutSec $TimeoutSec -ErrorAction Stop
  } catch {
    return $null
  }
}

function Wait-ForHttpOk {
  param(
    [string]$Url,
    [int]$TimeoutSec = 25,
    [int]$IntervalMs = 500,
    [scriptblock]$Predicate
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $json = Get-HttpJson -Url $Url -TimeoutSec 2
    if ($null -ne $json) {
      if ($Predicate) {
        if (& $Predicate $json) { return $json }
      } else {
        return $json
      }
    }
    Start-Sleep -Milliseconds $IntervalMs
  }

  return $null
}

$repoRoot = Split-Path -Parent $PSCommandPath
$hsmDir = Join-Path $repoRoot 'authenx-hsm'
$backendDir = Join-Path $repoRoot 'authenx-node'

if (-not (Test-Path $hsmDir)) {
  throw "Missing directory: $hsmDir"
}
if (-not (Test-Path $backendDir)) {
  throw "Missing directory: $backendDir"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js is not available in PATH. Install Node.js and retry.'
}

$hsmHealthUrl = "http://127.0.0.1:$HsmPort/health"

$pgPasswordPlain = ConvertTo-PlainText $PgPassword

if ([string]::IsNullOrWhiteSpace($pgPasswordPlain)) {
  if (-not [string]::IsNullOrWhiteSpace($env:PG_PROVISION_PASSWORD)) {
    $pgPasswordPlain = $env:PG_PROVISION_PASSWORD
  } else {
    $pgPasswordPlain = 'Postgres@123'
  }
}

Write-Step 'Checking PostgreSQL service'
$pgService = Get-Service | Where-Object { $_.Name -like 'postgresql*' } | Sort-Object Name -Descending | Select-Object -First 1
if ($pgService) {
  if ($pgService.Status -ne 'Running') {
    Write-Host "Starting service: $($pgService.Name)"
    Start-Service -Name $pgService.Name
    (Get-Service -Name $pgService.Name).WaitForStatus('Running', [TimeSpan]::FromSeconds(20))
  }
  Write-Host "PostgreSQL service is running: $($pgService.Name)" -ForegroundColor Green
} else {
  Write-Warning 'No PostgreSQL Windows service matching postgresql-x64-* was found.'
}

$psqlExe = $null
$psqlCandidates = @(
  'C:\Program Files\PostgreSQL\18\bin\psql.exe',
  'C:\Program Files\PostgreSQL\17\bin\psql.exe',
  'C:\Program Files\PostgreSQL\16\bin\psql.exe',
  'C:\Program Files\PostgreSQL\15\bin\psql.exe'
)
foreach ($candidate in $psqlCandidates) {
  if (Test-Path $candidate) {
    $psqlExe = $candidate
    break
  }
}
if (-not $psqlExe) {
  $psqlCmd = Get-Command psql -ErrorAction SilentlyContinue
  if ($psqlCmd) {
    $psqlExe = $psqlCmd.Source
  }
}

if (-not $SkipPostgresValidation) {
  Write-Step 'Validating PostgreSQL credentials'
  if (-not $psqlExe) {
    Write-Warning 'psql executable not found. Skipping SQL validation.'
  } else {
    $env:PGPASSWORD = $pgPasswordPlain
    & $psqlExe -h $PgHost -p $PgPort -U $PgUser -d $PgDatabase -c 'SELECT current_user, current_database();' | Out-Host
    if ($LASTEXITCODE -ne 0) {
      throw 'PostgreSQL validation failed. Verify PgHost/PgPort/PgUser/PgPassword.'
    }
    Write-Host 'PostgreSQL login check passed.' -ForegroundColor Green
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
}

$useDemoDb = -not (Test-TcpPortReachable -HostName $PgHost -Port $PgPort)
if ($useDemoDb) {
  Write-Warning "PostgreSQL is not reachable at ${PgHost}:${PgPort}. Starting backend in demo mode with an in-memory database."
}

$pgHostEsc = ConvertTo-SingleQuotedPsString $PgHost
$pgPortEsc = ConvertTo-SingleQuotedPsString ([string]$PgPort)
$pgUserEsc = ConvertTo-SingleQuotedPsString $PgUser
$pgDatabaseEsc = ConvertTo-SingleQuotedPsString $PgDatabase
$pgPasswordEsc = ConvertTo-SingleQuotedPsString $pgPasswordPlain
$hsmDirEsc = ConvertTo-SingleQuotedPsString $hsmDir
$backendDirEsc = ConvertTo-SingleQuotedPsString $backendDir

Write-Step 'Resolving backend port'
$candidatePorts = @($BackendPort, 3001, 3002, 3100, 3200, 3300) | Select-Object -Unique
$selectedBackendPort = $null
foreach ($candidatePort in $candidatePorts) {
  if (Test-PortFree -Port $candidatePort) {
    $selectedBackendPort = $candidatePort
    break
  }

  $health = Get-HttpJson -Url "http://127.0.0.1:$candidatePort/health" -TimeoutSec 2
  if ($health -and $health.status -eq 'ok') {
    Write-Host "AuthenX backend already healthy on port $candidatePort. Reusing it." -ForegroundColor Green
    $selectedBackendPort = $candidatePort
    break
  }
}

if (-not $selectedBackendPort) {
  throw 'No free backend port found in [3001,3002,3100,3200,3300]. Stop conflicting processes and retry.'
}

if ($selectedBackendPort -ne $BackendPort) {
  Write-Warning "Requested backend port $BackendPort is busy. Using $selectedBackendPort instead."
}

$BackendPort = $selectedBackendPort
$backendPortEsc = ConvertTo-SingleQuotedPsString ([string]$BackendPort)

$hsmNeedsStart = $true
$existingHsm = Get-HttpJson -Url $hsmHealthUrl -TimeoutSec 2
if ($existingHsm -and $existingHsm.status -eq 'ok' -and $existingHsm.service -eq 'authenx-hsm') {
  $hsmNeedsStart = $false
  Write-Step 'AuthenX HSM already running'
  Write-Host "Reusing HSM at $hsmHealthUrl" -ForegroundColor Green
} elseif (-not (Test-PortFree -Port $HsmPort)) {
  throw "Port $HsmPort is busy but not responding as AuthenX HSM. Free the port and retry."
}

if ($hsmNeedsStart) {
  Write-Step 'Starting AuthenX HSM'
  $hsmCommand = @"
Set-Location '$hsmDirEsc'
Write-Host 'AuthenX HSM starting on http://127.0.0.1:$HsmPort' -ForegroundColor Yellow
`$env:HSM_PORT = '$HsmPort'
node server.js
"@
  Start-Process powershell -ArgumentList '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $hsmCommand | Out-Null

  $hsmReady = Wait-ForHttpOk -Url $hsmHealthUrl -TimeoutSec $StartupTimeoutSec -Predicate {
    param($json)
    return ($json.status -eq 'ok' -and $json.service -eq 'authenx-hsm')
  }
  if (-not $hsmReady) {
    throw "HSM did not become healthy within $StartupTimeoutSec seconds ($hsmHealthUrl)."
  }
  Write-Host 'HSM health check passed.' -ForegroundColor Green
}

$backendNeedsStart = $true
$existingBackend = Get-HttpJson -Url "http://127.0.0.1:$BackendPort/health" -TimeoutSec 2
if ($existingBackend -and $existingBackend.status -eq 'ok') {
  $backendNeedsStart = $false
  Write-Step 'AuthenX backend already running'
  Write-Host "Reusing backend at http://127.0.0.1:$BackendPort" -ForegroundColor Green
} elseif (-not (Test-PortFree -Port $BackendPort)) {
  throw "Port $BackendPort is busy but not responding as AuthenX backend. Free the port and retry."
}

if ($backendNeedsStart) {
  Write-Step 'Starting AuthenX backend'
  $backendCommand = @"
`$env:PORT = '$backendPortEsc'
`$env:HSM_PORT = '$HsmPort'
`$env:AUTHENX_DEMO_DB = '$(if ($useDemoDb) { '1' } else { '0' })'
`$env:AUTHENX_PG_HOST = '$pgHostEsc'
`$env:AUTHENX_PG_PORT = '$pgPortEsc'
`$env:AUTHENX_PG_USER = '$pgUserEsc'
`$env:AUTHENX_PG_PASSWORD = '$pgPasswordEsc'
`$env:AUTHENX_PG_DATABASE = 'postgres'
`$env:CVR_ERP_PG_DB = 'postgres'
Set-Location '$backendDirEsc'
Write-Host 'AuthenX backend starting on http://127.0.0.1:$backendPortEsc' -ForegroundColor Yellow
node src/server.js
"@
  Start-Process powershell -ArgumentList '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $backendCommand | Out-Null

  $backendReady = Wait-ForHttpOk -Url "http://127.0.0.1:$BackendPort/health" -TimeoutSec $StartupTimeoutSec -Predicate {
    param($json)
    return ($json.status -eq 'ok')
  }
  if (-not $backendReady) {
    throw "Backend did not become healthy within $StartupTimeoutSec seconds (port $BackendPort)."
  }
  Write-Host 'Backend health check passed.' -ForegroundColor Green
}

if (-not $SkipCvrSeed) {
  if ($useDemoDb) {
    Write-Warning 'Skipping CVR mock ERP seed because demo mode uses an in-memory database process that is not shared with separate seed scripts.'
  } else {
    Write-Step 'Seeding CVR mock ERP data'
    Push-Location $backendDir
    try {
      $env:CVR_ERP_PG_DB = 'postgres'

      $env:AUTHENX_PG_HOST = $PgHost
      $env:AUTHENX_PG_PORT = [string]$PgPort
      $env:AUTHENX_PG_USER = $PgUser
      $env:AUTHENX_PG_PASSWORD = $pgPasswordPlain
      $env:AUTHENX_PG_DATABASE = 'postgres'

      node mock-erp-cvr-seed.js | Out-Host
      if ($LASTEXITCODE -ne 0) {
        Write-Warning 'CVR seed script returned a non-zero exit code. Backend is still running; verify PostgreSQL credentials and rerun seed if needed.'
      } else {
        Write-Host 'CVR seed completed.' -ForegroundColor Green
      }
    } finally {
      Pop-Location
    }
  }
}

Write-Step 'Done'
Write-Host "HSM:     http://127.0.0.1:$HsmPort/health" -ForegroundColor Green
Write-Host "Backend: http://127.0.0.1:$BackendPort/health" -ForegroundColor Green
Write-Host "Postgres: ${PgHost}:$PgPort (db=postgres user=$PgUser)" -ForegroundColor Green
Write-Host 'Shared postgres database env vars were injected into the backend process.' -ForegroundColor Green
Write-Host ''
Write-Host 'Usage examples:' -ForegroundColor DarkCyan
Write-Host '  .\start-backend-stack.ps1'
Write-Host '  .\start-backend-stack.ps1 -BackendPort 3001'
Write-Host '  .\start-backend-stack.ps1 -HsmPort 9099 -PgDatabase postgres'
Write-Host '  .\start-backend-stack.ps1 -PgPassword (ConvertTo-SecureString "yourPassword" -AsPlainText -Force)'
Write-Host '  .\start-backend-stack.ps1 -SkipPostgresValidation'
Write-Host '  .\start-backend-stack.ps1 -SkipCvrSeed'
