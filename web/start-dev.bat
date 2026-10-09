@echo off
setlocal
title TSWoW WebClient - web (dev)
cd /d "%~dp0.."

rem Web version, development, in one click: starts the gateway in its own window when it is not
rem running (start-gateway.bat builds it first), runs the Vite dev server with hot reload here, and
rem opens http://127.0.0.1:5173/ in the browser once both answer.
rem   start-dev.bat --no-browser    do not open the browser (electron\start-dev.bat uses this)

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

rem 10.11: only the gateway answers /health; anything else on 8090 would just make the page fail.
node tools\port.mjs check-gateway 8090
if errorlevel 2 (
    echo Port 8090 is taken by another program, not the WebClient gateway. Free it and try again.
    pause
    exit /b 1
)
if errorlevel 1 start "TSWoW WebClient Gateway" "%~dp0..\start-gateway.bat"

node tools\port.mjs check 5173
if not errorlevel 1 (
    echo The Vite dev server is already running at http://127.0.0.1:5173/
    if defined OPEN_BROWSER node tools\port.mjs wait 8090 --timeout 600 --open http://127.0.0.1:5173/
    exit /b 0
)

if defined OPEN_BROWSER start "" /b node tools\port.mjs wait 8090 5173 --timeout 600 --open http://127.0.0.1:5173/
call npm run dev
if errorlevel 1 pause
