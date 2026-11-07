# Compiles the Windows tray app with the csc.exe that ships with .NET Framework 4 (C# 5), so nothing extra is installed.
param([string]$Out)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
if (-not $Out) { $Out = Join-Path $root "dist\AgentFlowTray.exe" }

# Not RuntimeEnvironment.GetRuntimeDirectory(): under PowerShell 7 that is .NET, which has no csc.exe.
$csc = @("Framework64", "Framework") |
    ForEach-Object { Join-Path $env:WINDIR "Microsoft.NET\$_\v4.0.30319\csc.exe" } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
if (-not $csc) {
    Write-Host "csc.exe from .NET Framework 4 was not found under $env:WINDIR\Microsoft.NET."
    exit 1
}

New-Item -ItemType Directory -Force (Split-Path -Parent $Out) | Out-Null
& $csc /nologo /target:winexe /optimize+ "/out:$Out" "/win32icon:$(Join-Path $root 'assets\tray\agent-flow.ico')" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll (Join-Path $root "tray\AgentFlowTray.cs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Built $Out"
