# Installs what is missing, builds, restarts the Windows tray app and exits. run.cmd calls this.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$exe = Join-Path $root "dist\AgentFlowTray.exe"

if (-not (Test-Path -LiteralPath "node_modules")) {
    npm ci
    if ($LASTEXITCODE -ne 0) { exit 1 }
}
npm run build
if ($LASTEXITCODE -ne 0) { exit 1 }

# Quit a running tray first: its exe cannot be replaced while it runs, and its serve holds the port.
$running = @(Get-Process -Name "AgentFlowTray" -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe })
if ($running.Count -gt 0) {
    Write-Host "Quitting the running tray app."
    Start-Process -FilePath $exe -ArgumentList "--quit" -Wait
    $running | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue
    if (@($running | Where-Object { -not $_.HasExited }).Count -gt 0) {
        Write-Host "The running tray app did not quit. Quit it from its tray menu and run this again."
        exit 1
    }
}

& (Join-Path $PSScriptRoot "build-tray.ps1")
if ($LASTEXITCODE -ne 0) { exit 1 }

Start-Process -FilePath $exe -ArgumentList "--open" -WorkingDirectory $root
Write-Host "Agent Flow is in the tray: http://127.0.0.1:8791/"
