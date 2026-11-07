@echo off
setlocal
cd /d "%~dp0"

rem Installs what is missing, builds, restarts the Windows tray app and exits.
rem The tray serves the dashboard on http://127.0.0.1:8791/; see "Windows tray app" in README.md.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-tray.ps1
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo The agent-flow tray app did not start.
pause
exit /b 1
