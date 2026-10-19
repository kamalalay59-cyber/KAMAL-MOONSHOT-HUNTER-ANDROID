@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is missing. Install Node.js 20 or newer, then run this file again.
  pause
  exit /b 1
)
node -e "if (Number(process.versions.node.split('.')[0]) < 20) process.exit(1)"
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  pause
  exit /b 1
)
if not exist .env (
  copy .env.example .env >nul
  echo Created .env from the example. Add Telegram credentials there if you want alerts.
)
echo Starting local PAPER-only scanner. Keep this window open while it runs.
echo Dashboard: http://127.0.0.1:8787
node server.mjs
echo.
echo Scanner stopped.
pause
