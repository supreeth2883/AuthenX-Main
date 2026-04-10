[CmdletBinding()]
param(
    [ValidateSet("all", "single")]
    [string]$Connectors = "all"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $root "start-backend.ps1"

if (-not (Test-Path -LiteralPath $target)) {
    throw "Required script not found: $target"
}

& $target -Connectors $Connectors