@echo off
title Orbit AI - build Windows installer
cd /d "%~dp0"

rem ===== Builds dist\OrbitAI-Setup-1.0.0.exe =====

if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing dependencies first...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo Building the installer, this can take a few minutes...
call npm run dist
if errorlevel 1 (
  echo.
  echo [ERROR] Build failed. Read the messages above.
  pause
  exit /b 1
)

echo.
echo Done! Opening the dist folder...
start "" explorer dist
