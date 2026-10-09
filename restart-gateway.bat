@echo off
setlocal
title TSWoW WebClient Gateway
cd /d "%~dp0"

rem Restarts the WebClient gateway after a TSWoW build changed the client patches.
rem   restart-gateway.bat         stop the running gateway and start it again; rebuilds the
rem                               gateway first when src/ changed after the last build
rem   restart-gateway.bat build   always rebuild the gateway first (tools\build-gateway.mjs,
rem                               a few seconds; the page in dist\web is built by web\build.bat)

set "WEBCLIENT_RUNTIME=%WEBCLIENT_NODE_DIR%"
if not defined WEBCLIENT_RUNTIME set "WEBCLIENT_RUNTIME=%~dp0.runtime\node"
if exist "%WEBCLIENT_RUNTIME%\node.exe" set "PATH=%WEBCLIENT_RUNTIME%;%PATH%"

if not exist "node_modules\" (
    echo WebClient dependencies are missing. Run npm install first.
    pause
    exit /b 1
)

node tools\stop-gateway.mjs
if errorlevel 1 (
    pause
    exit /b 1
)

set "REBUILD="
if /i "%~1"=="build" set "REBUILD=1"
if not exist "dist\code\gateway\main.js" set "REBUILD=1"
rem Sources edited since the last build: a restart alone would keep serving the old code.
if not defined REBUILD node tools\gateway-build-stale.mjs && set "REBUILD=1"

if defined REBUILD (
    call npm run gateway:dev
) else (
    node --enable-source-maps tools\start-gateway.mjs
)
if errorlevel 1 pause
