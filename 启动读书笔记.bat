@echo off
rem ============================================================
rem  Reading Notes - double-click this file to start the app.
rem
rem  NOTE: this file is intentionally pure ASCII. Chinese text
rem  inside a .bat gets garbled by the Windows console code page,
rem  so every Chinese message is printed by Node instead.
rem ============================================================
setlocal
title Reading Notes
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node

node --no-warnings "scripts\launch.mjs"
set "RC=%errorlevel%"

if not "%RC%"=="0" (
  echo.
  echo   ------------------------------------------------------------
  echo   Startup failed. Please read the message above.
  echo   ------------------------------------------------------------
  echo.
  pause
)
exit /b %RC%

:no_node
echo.
echo   [!] Node.js was not found on this computer.
echo.
echo       This system needs Node.js 22.5 or newer.
echo.
echo       1. Download and install it from:  https://nodejs.org
echo          (pick the LTS version, keep clicking Next)
echo       2. Close this window.
echo       3. Double-click this file again.
echo.
pause
exit /b 1