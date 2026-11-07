# Points the Agent Flow desktop shortcut at the tray app. -Startup also starts the tray at logon.
param([switch]$Startup)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "dist\AgentFlowTray.exe"
if (-not (Test-Path -LiteralPath $exe)) {
    Write-Host "Run run.cmd once first so the tray app is built."
    exit 1
}

$folders = @("Desktop")
if ($Startup) { $folders += "Startup" }
foreach ($folder in $folders) {
    $path = Join-Path ([Environment]::GetFolderPath($folder)) "Agent Flow.lnk"
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
    $shortcut.TargetPath = $exe
    # The desktop shortcut opens the dashboard; at logon the tray only starts.
    $shortcut.Arguments = $(if ($folder -eq "Desktop") { "--open" } else { "" })
    $shortcut.WorkingDirectory = $root
    $shortcut.IconLocation = (Join-Path $root "assets\tray\agent-flow.ico") + ",0"
    $shortcut.Description = "agent-flow dashboard in the Windows tray"
    $shortcut.Save()
    Write-Host "Updated $path"
}
