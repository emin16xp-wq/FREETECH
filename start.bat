@echo off
title Orbit AI
cd /d "%~dp0"

rem ===== Orbit AI launcher =====

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not in PATH.
  echo Download it from https://nodejs.org  ^(LTS version^), then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo First run detected - installing dependencies, this can take a few minutes...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Read the messages above.
    echo Tip: set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ and try again.
    pause
    exit /b 1
  )
)

echo Starting Orbit AI...  ^(close this window to stop it^)
call npm start
if errorlevel 1 (
  echo.
  echo [ERROR] Orbit AI exited with an error. Read the messages above.
  pause
)
