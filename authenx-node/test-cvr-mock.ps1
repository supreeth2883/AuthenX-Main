#Requires -Version 5.1
<#
.SYNOPSIS
  Acceptance tests for the CVR College mock ERP (PostgreSQL-backed).

.DESCRIPTION
  Detects the running backend port using the same candidate list as
  start-backend-stack.ps1, logs in as the CVR admin, and verifies:
    - stu_ref_001, stu_ref_002, stu_ref_004  → HTTP 200 with student data
                                                and source="mock_erp"
    - stu_ref_UNKNOWN                         → HTTP 404 with clear error

.USAGE
  # From repo root or authenx-node/:
  .\authenx-node\test-cvr-mock.ps1

  # With explicit backend port:
  .\authenx-node\test-cvr-mock.ps1 -Port 3001
#>
param(
  [int]$Port = 0    # 0 = auto-detect from start-backend-stack.ps1 candidate list
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── 1. Detect backend port ─────────────────────────────────────────────────────
if ($Port -eq 0) {
  $candidatePorts = @(3001, 3002, 3100, 3200, 3300)
  $Port = $candidatePorts | Where-Object {
      (Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue)
  } | Select-Object -First 1

  if (-not $Port) {
    Write-Error "No backend port found in [$($candidatePorts -join ', ')]. Start the server first."
    exit 1
  }
}
$base = "http://localhost:$Port"
Write-Host "Backend detected on port $Port ($base)" -ForegroundColor Cyan

# ── 2. Login as CVR admin ──────────────────────────────────────────────────────
Write-Host "`nLogging in as cvradmin@authenx.in..."
try {
  $loginResp = Invoke-RestMethod -Uri "$base/v1/auth/login" -Method POST `
      -ContentType 'application/json' `
      -Body '{"email":"cvradmin@authenx.in","password":"CVRAdmin@123"}'
} catch {
  Write-Error "Login failed: $($_.Exception.Message).`nRun: node mock-erp-cvr-seed.js (sets the password)"
  exit 1
}
$token = $loginResp.token
if (-not $token) {
  Write-Error "No token in login response: $($loginResp | ConvertTo-Json -Depth 3)"
  exit 1
}
Write-Host "Token acquired: $($token.Substring(0, [Math]::Min(30,$token.Length)))..." -ForegroundColor Green

$headers = @{ Authorization = "Bearer $token" }
$passed  = 0
$failed  = 0

# ── 3. Known refs — expect HTTP 200, source = mock_erp ────────────────────────
$knownRefs = @(
  @{ ref = 'stu_ref_001'; expectName = 'SUPREETH K' },
  @{ ref = 'stu_ref_002'; expectName = 'PRIYA SHARMA' },
  @{ ref = 'stu_ref_004'; expectName = 'ANANYA PATEL' }
)

Write-Host "`nTesting known student refs:"
foreach ($entry in $knownRefs) {
  $ref  = $entry.ref
  $body = [pscustomobject]@{ student_ref_token = $ref; nonce = "test_$(Get-Random)" } | ConvertTo-Json -Compress
  try {
    $r = Invoke-RestMethod -Uri "$base/v1/connector/verify" -Method POST `
        -ContentType 'application/json' -Headers $headers -Body $body
    $nameOk   = ($r.name   -eq $entry.expectName)
    $sourceOk = ($r.source -eq 'mock_erp')
    if ($nameOk -and $sourceOk) {
      Write-Host ("  PASS  {0} -> name={1}  branch={2}  source={3}" -f $ref, $r.name, $r.branch, $r.source) -ForegroundColor Green
      $passed++
    } else {
      Write-Host ("  FAIL  {0} -> name={1} (want {2})  source={3} (want mock_erp)" -f $ref, $r.name, $entry.expectName, $r.source) -ForegroundColor Red
      $failed++
    }
  } catch {
    Write-Host "  FAIL  $ref -> HTTP error: $($_.Exception.Message)" -ForegroundColor Red
    $failed++
  }
}

# ── 4. Unknown ref — expect HTTP 404 ──────────────────────────────────────────
Write-Host "`nTesting unknown ref (expect 404):"
$body = '{"student_ref_token":"stu_ref_UNKNOWN","nonce":"test"}'
try {
  Invoke-RestMethod -Uri "$base/v1/connector/verify" -Method POST `
      -ContentType 'application/json' -Headers $headers -Body $body | Out-Null
  Write-Host "  FAIL  stu_ref_UNKNOWN -> got HTTP 200 (expected 404)" -ForegroundColor Red
  $failed++
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code -eq 404) {
    Write-Host "  PASS  stu_ref_UNKNOWN -> HTTP 404 (correct)" -ForegroundColor Green
    $passed++
  } else {
    Write-Host "  FAIL  stu_ref_UNKNOWN -> HTTP $code (expected 404)" -ForegroundColor Red
    $failed++
  }
}

# ── 5. Summary ────────────────────────────────────────────────────────────────
Write-Host "`n────────────────────────────────"
$colour = if ($failed -eq 0) { 'Green' } else { 'Red' }
Write-Host "Results: $passed passed, $failed failed" -ForegroundColor $colour
if ($failed -gt 0) { exit 1 }
