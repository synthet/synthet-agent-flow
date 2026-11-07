@echo off
setlocal
cd /d "%~dp0"

rem A second serve would fail on the port, so reuse a dashboard that is already up. -f: a 404 means another app.
curl.exe -sf -o NUL --max-time 2 http://127.0.0.1:8791/api/board
if not errorlevel 1 (
  start "" http://127.0.0.1:8791/
  exit /b 0
)

if not exist "dist\cli\main.js" (
  call npm run build
  if errorlevel 1 goto failed
)

node bin\agent-flow.js serve --open
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo The agent-flow dashboard did not start.
pause
exit /b 1