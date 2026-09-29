@echo off
setlocal
title TSWoW WebClient - server for players
cd /d "%~dp0.."

rem Serves the game to other players from this machine (tools\start-server.mjs): the built page on
rem PUBLIC_WEB_PORT (8091) and the gateway on 8090, on every network interface, for PUBLIC_HOST
rem from .env. Players open http://PUBLIC_HOST:8091/ in a browser or run the player app
rem (build-player.bat). This machine's own development keeps working through the same gateway.
rem A gateway running only for this machine is stopped first; the build is refreshed when src\ is
rem newer than it.
rem   start-server.bat build    always rebuild first
rem Close this window (or Ctrl+C) to stop serving.

set "WEBCLIENT_RUNTIME=%WEBCLIENT_NODE_DIR%"
if not defined WEBCLIENT_RUNTIME set "WEBCLIENT_RUNTIME=%~dp0..\.runtime\node"
if exist "%WEBCLIENT_RUNTIME%\node.exe" set "PATH=%WEBCLIENT_RUNTIME%;%PATH%"

if not exist "node_modules\" (
    echo WebClient dependencies are missing. Run npm install in the WebClient folder first.
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
if not exist "dist\web\index.html" set "REBUILD=1"
if not exist "dist\code\gateway\main.js" set "REBUILD=1"
if not defined REBUILD node tools\gateway-build-stale.mjs && set "REBUILD=1"
if defined REBUILD (
    call npm run build
    if errorlevel 1 (
        pause
        exit /b 1
    )
)

node --enable-source-maps tools\start-server.mjs
if errorlevel 1 pause
