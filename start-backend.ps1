[CmdletBinding()]
param(
    [ValidateSet("all", "single")]
    [string]$Connectors = "all"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Start-ServiceWindow {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,

        [Parameter(Mandatory = $true)]
        [string]$Command
    )

    if (-not (Test-Path -LiteralPath $WorkingDirectory)) {
        throw "[$Name] Directory not found: $WorkingDirectory"
    }

    $psCommand = "Set-Location -LiteralPath '$WorkingDirectory'; $Command"

    Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoExit", "-Command", $psCommand) `
        -WindowStyle Normal | Out-Null

    Write-Host "Started $Name in a new PowerShell window."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is not available in PATH. Install Node.js 22+ and retry."
}

$hsmDir = Join-Path $root "authenx-hsm"
$mainDir = Join-Path $root "authenx-node"
$singleConnectorDir = Join-Path $root "authenx-connector"
$allConnectorsDir = Join-Path $root "colleges"

Start-ServiceWindow -Name "AuthenX HSM (:9099)" -WorkingDirectory $hsmDir -Command "node server.js"
Start-ServiceWindow -Name "AuthenX Main Server (:3000)" -WorkingDirectory $mainDir -Command "node src/server.js"

if ($Connectors -eq "all") {
    Start-ServiceWindow -Name "All College Connectors (:9001-:9010)" -WorkingDirectory $allConnectorsDir -Command "node start-all-connectors.js"
}
else {
    Start-ServiceWindow -Name "Single Connector (:9001)" -WorkingDirectory $singleConnectorDir -Command "node connector.js"
}

Write-Host ""
Write-Host "Backend launch requested."
Write-Host "Run smoke test from repo root in another terminal:" -ForegroundColor Cyan
Write-Host "node smoke-test.js"
Write-Host ""
Write-Host "Optional end-to-end test:" -ForegroundColor Cyan
Write-Host "node e2e-test.js"
