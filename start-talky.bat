@echo off
setlocal

cd /d "%~dp0"
title Talky - WhatsApp AI Agent

where bun >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Bun is not installed or not in PATH.
  echo Install Bun from https://bun.sh and reopen this file.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] Installing dependencies...
  bun install
  if errorlevel 1 (
    echo [ERROR] bun install failed.
    pause
    exit /b 1
  )
)

echo [INFO] Starting Talky...
echo [INFO] Keep this window open while bot is running.
echo.

bun run start
set EXIT_CODE=%ERRORLEVEL%

echo.
if not "%EXIT_CODE%"=="0" (
  echo [ERROR] Talky exited with code %EXIT_CODE%.
) else (
  echo [INFO] Talky exited.
)
pause
exit /b %EXIT_CODE%

