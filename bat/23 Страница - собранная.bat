@echo off
setlocal
title TSWoW WebClient - web (built)
cd /d "%~dp0.."

rem Web version, built: serves dist\web (script 20) at http://127.0.0.1:5173/ without rebuilding
rem and without hot reload (vite preview). Stop script 01 first: both use the same port, the one
rem the gateway accepts. The gateway must be running as well.

set "WEBCLIENT_RUNTIME=%WEBCLIENT_NODE_DIR%"
if not defined WEBCLIENT_RUNTIME set "WEBCLIENT_RUNTIME=%~dp0..\.runtime\node"
if exist "%WEBCLIENT_RUNTIME%\node.exe" set "PATH=%WEBCLIENT_RUNTIME%;%PATH%"

if not exist "dist\web\index.html" (
    echo The web version is not built yet. Run script 20, the game build, from the bat folder first.
    pause
    exit /b 1
)

call npm run preview
if errorlevel 1 pause
