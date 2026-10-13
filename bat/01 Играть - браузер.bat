@echo off
setlocal
title TSWoW WebClient - web (dev)
cd /d "%~dp0.."

rem Web version, development, in one click: starts the gateway in its own window when it is not
rem running (script 10 builds it first), runs the Vite dev server with hot reload here, and
rem opens http://127.0.0.1:5173/ in the browser once both answer.
rem   01 ... --no-browser    do not open the browser (script 02 uses this)
rem Other scripts of this folder are found by their number: cmd reads a .bat in the console code
rem page, so their Cyrillic names are never written inside a script.

set "WEBCLIENT_RUNTIME=%WEBCLIENT_NODE_DIR%"
if not defined WEBCLIENT_RUNTIME set "WEBCLIENT_RUNTIME=%~dp0..\.runtime\node"
if exist "%WEBCLIENT_RUNTIME%\node.exe" set "PATH=%WEBCLIENT_RUNTIME%;%PATH%"

if not exist "node_modules\" (
    echo WebClient dependencies are missing. Run npm install in the WebClient folder first.
    pause
    exit /b 1
)

set "OPEN_BROWSER=1"
if /i "%~1"=="--no-browser" set "OPEN_BROWSER="

set "GATEWAY_BAT="
for %%F in ("%~dp010 *.bat") do set "GATEWAY_BAT=%%~fF"
if not defined GATEWAY_BAT (
    echo Script 10, the gateway start, is missing from the bat folder.
    pause
    exit /b 1
)

rem 10.11: only the gateway answers /health; anything else on 8090 would just make the page fail.
node tools\port.mjs check-gateway 8090
if errorlevel 2 (
    echo Port 8090 is taken by another program, not the WebClient gateway. Free it and try again.
    pause
    exit /b 1
)
if errorlevel 1 start "TSWoW WebClient Gateway" "%GATEWAY_BAT%"

node tools\port.mjs check 5173
if not errorlevel 1 (
    echo The Vite dev server is already running at http://127.0.0.1:5173/
    if defined OPEN_BROWSER node tools\port.mjs wait 8090 --timeout 600 --open http://127.0.0.1:5173/
    exit /b 0
)

if defined OPEN_BROWSER start "" /b node tools\port.mjs wait 8090 5173 --timeout 600 --open http://127.0.0.1:5173/
call npm run dev
if errorlevel 1 pause
