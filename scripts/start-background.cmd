@echo off
cd /d "%~dp0.."

if not exist "proxy.mjs" (
    echo [ERROR] proxy.mjs not found. Run this from the project folder.
    pause
    exit /b 1
)

if not exist "logs" mkdir "logs"
set "CC_STREAM_IDLE_MS=300000"
set "CC_NONSTREAM_IDLE_MS=300000"

rem The background relay has no window to ask in, so it always speaks English (UK) — logs included. :3
set "CC_UI_LANG=en-GB"

rem PROXY_PORT moves the relay off 3050; scripts\stop.cmd reads the same variable. :3
if defined PROXY_PORT set "PORT=%PROXY_PORT%"

rem Whoever starts the relay leaves a log file; default is logs\relay.log. :3
if not exist "%~dp0..\logs" mkdir "%~dp0..\logs"
if not defined LOG_FILE set "LOG_FILE=%~dp0..\logs\relay.log"

powershell -NoProfile -Command "$p = Start-Process -FilePath 'node' -ArgumentList 'proxy.mjs' -WorkingDirectory '%~dp0..' -WindowStyle Hidden -RedirectStandardOutput '%~dp0..\logs\relay.log' -RedirectStandardError '%~dp0..\logs\relay.err.log' -PassThru; $p.Id | Set-Content -LiteralPath '%~dp0..\logs\relay.pid'; Write-Output ('Cider CC UwU is open in the background ~ PID ' + $p.Id)"

echo.
echo Log file: %~dp0..\logs\relay.log
echo To close the bar, run scripts\stop.cmd
ping -n 4 127.0.0.1 >nul
exit /b 0
