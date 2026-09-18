@echo off
rem The window language is picked on first launch and remembered in ui-language.txt. :3
rem UTF-8 console, so the Chinese option renders properly on any Windows locale. :3
chcp 65001 >nul
title Cider CC UwU :3
cd /d "%~dp0.."

if not exist "proxy.mjs" (
    echo [ERROR] proxy.mjs not found. Run this from the project folder.
    pause
    exit /b 1
)

set "CC_STREAM_IDLE_MS=300000"
set "CC_NONSTREAM_IDLE_MS=300000"

rem PROXY_PORT moves the relay off 3050; scripts\stop.cmd reads the same variable. :3
if defined PROXY_PORT set "PORT=%PROXY_PORT%"

rem Whoever starts the relay leaves a log file; default is logs\relay.log. :3
if not exist "%~dp0..\logs" mkdir "%~dp0..\logs"
if not defined LOG_FILE set "LOG_FILE=%~dp0..\logs\relay.log"

rem The banner must follow the real port, or it shows a URL that does not exist. :3
set "SHOW_PORT=%PORT%"
if not defined SHOW_PORT set "SHOW_PORT=3050"

echo ============================================================
echo   Cider CC UwU ~ pulling up a stool :3
echo   URL:    http://127.0.0.1:%SHOW_PORT%
echo   Models: http://127.0.0.1:%SHOW_PORT%/v1/models
echo   Stop:   close this window (or Ctrl+C)
echo ============================================================
echo.

node proxy.mjs

echo.
echo The bar is closed. Press any key to tidy up.
pause >nul
