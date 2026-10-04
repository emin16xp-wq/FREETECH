@echo off
title Orbit AI - clean install
cd /d "%~dp0"

rem ===== Run this if the app misbehaves or updates went wrong =====

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not in PATH.
  pause
  exit /b 1
)

echo Removing old dependencies...
if exist node_modules rmdir /s /q node_modules
if exist package-lock.json del package-lock.json

echo Installing fresh dependencies, please wait...
call npm install
if errorlevel 1 (
  echo.
  echo [ERROR] npm install failed. Read the messages above.
  pause
  exit /b 1
)

echo.
echo Done! Now double-click start.bat
pause
