@echo off
setlocal
title TSWoW WebClient - local test of the players' setup
cd /d "%~dp0.."

rem Tries the setup for other players on this machine alone, before anything is sent: starts
rem start-server.bat listening on 127.0.0.1 only (nothing reachable from outside) in its own window,
rem then opens the very app from dist\player (build-player.bat) against it.
rem   test-local.bat            the player app
rem   test-local.bat browser    the same page in the browser, http://127.0.0.1:8091/
rem Close the server window to stop the test.

set "WEBCLIENT_RUNTIME=%WEBCLIENT_NODE_DIR%"
if not defined WEBCLIENT_RUNTIME set "WEBCLIENT_RUNTIME=%~dp0..\.runtime\node"
if exist "%WEBCLIENT_RUNTIME%\node.exe" set "PATH=%WEBCLIENT_RUNTIME%;%PATH%"

if not exist "node_modules\" (
    echo WebClient dependencies are missing. Run npm install in the WebClient folder first.
    pause
    exit /b 1
)

node tools\test-local.mjs %*
if errorlevel 1 pause
