@echo off
setlocal
title TSWoW WebClient - web (built)
cd /d "%~dp0.."

rem Web version, built: serves dist\web (web\build.bat) at http://127.0.0.1:5173/ without
rem rebuilding and without hot reload (vite preview). Stop web\start-dev.bat first: both use the
rem same port, the one the gateway accepts. The gateway must be running as well.

set "WEBCLIENT_RUNTIME=%WEBCLIENT_NODE_DIR%"
if not defined WEBCLIENT_RUNTIME set "WEBCLIENT_RUNTIME=%~dp0..\.runtime\node"
if exist "%WEBCLIENT_RUNTIME%\node.exe" set "PATH=%WEBCLIENT_RUNTIME%;%PATH%"

if not exist "dist\web\index.html" (
    echo The web version is not built yet. Run web\build.bat first.
    pause
    exit /b 1
)

call npm run preview
if errorlevel 1 pause
