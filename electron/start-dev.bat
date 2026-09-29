@echo off
setlocal
title TSWoW WebClient - Electron (dev)
cd /d "%~dp0.."

rem Electron version, development, in one click: starts what is missing in their own windows —
rem the Vite dev server (web\start-dev.bat) and the gateway (start-gateway.bat) — then opens the
rem shell (electron\main.cjs) on the performance cores around the page from Vite. Until both
rem answer, the window says what it is waiting for. Extra options pass through, for example:
rem   start-dev.bat --priority=high
rem   start-dev.bat --webclient-url=http://127.0.0.1:5173/?framexml=1
rem   start-dev.bat --web-dir=dist\web        the built page instead of Vite (stop Vite first)
rem F11 toggles full screen, F12 opens DevTools, Ctrl+R reloads.

set "WEBCLIENT_RUNTIME=%WEBCLIENT_NODE_DIR%"
if not defined WEBCLIENT_RUNTIME set "WEBCLIENT_RUNTIME=%~dp0..\.runtime\node"
if exist "%WEBCLIENT_RUNTIME%\node.exe" set "PATH=%WEBCLIENT_RUNTIME%;%PATH%"

set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
    echo Electron is not installed. Run "npm install" in the electron folder first.
    pause
    exit /b 1
)

node tools\port.mjs check 5173
if errorlevel 1 (
    rem web\start-dev.bat also starts the gateway when it is missing.
    start "TSWoW WebClient - web (dev)" "%~dp0..\web\start-dev.bat" --no-browser
) else (
    node tools\port.mjs check 8090 || start "TSWoW WebClient Gateway" "%~dp0..\start-gateway.bat"
)

start "" "%ELECTRON%" "%~dp0." %*
