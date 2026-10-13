@echo off
setlocal
title TSWoW WebClient - stop gateway
cd /d "%~dp0.."

rem Stops the WebClient gateway listening on GATEWAY_PORT (8090) - the one started by script 10
rem or 11, or the players' server of script 32 together with its page (both live in one
rem process). tools\stop-gateway.mjs stops only this client's own node processes and refuses
rem when the port belongs to another program.
rem   12 ... --dry-run    only say what would be stopped

set "WEBCLIENT_RUNTIME=%WEBCLIENT_NODE_DIR%"
if not defined WEBCLIENT_RUNTIME set "WEBCLIENT_RUNTIME=%~dp0..\.runtime\node"
if exist "%WEBCLIENT_RUNTIME%\node.exe" set "PATH=%WEBCLIENT_RUNTIME%;%PATH%"

node tools\stop-gateway.mjs %*
if errorlevel 1 (
    pause
    exit /b 1
)
pause
