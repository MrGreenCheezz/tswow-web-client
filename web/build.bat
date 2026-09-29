@echo off
setlocal
title TSWoW WebClient - web build
cd /d "%~dp0.."

rem Builds the web version (npm run build): dist\web is the page as static files, dist\code the
rem gateway that start-gateway.bat and restart-gateway.bat run. web\start-built.bat serves
rem dist\web without the dev server.

set "WEBCLIENT_RUNTIME=%WEBCLIENT_NODE_DIR%"
if not defined WEBCLIENT_RUNTIME set "WEBCLIENT_RUNTIME=%~dp0..\.runtime\node"
if exist "%WEBCLIENT_RUNTIME%\node.exe" set "PATH=%WEBCLIENT_RUNTIME%;%PATH%"

if not exist "node_modules\" (
    echo WebClient dependencies are missing. Run npm install in the WebClient folder first.
    pause
    exit /b 1
)

call npm run build
if errorlevel 1 (
    pause
    exit /b 1
)
echo.
echo Web version built: dist\web (page) and dist\code (gateway).
pause
