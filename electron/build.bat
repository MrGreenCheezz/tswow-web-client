@echo off
setlocal
title TSWoW WebClient - Electron build
cd /d "%~dp0.."

rem Builds the Electron version: first the web version (npm run build: dist\web and dist\code),
rem then packs Electron with that page into dist\electron (electron\build.mjs).
rem Result: dist\electron\WoWWebClient.exe, started by electron\start-built.bat.

set "WEBCLIENT_RUNTIME=%WEBCLIENT_NODE_DIR%"
if not defined WEBCLIENT_RUNTIME set "WEBCLIENT_RUNTIME=%~dp0..\.runtime\node"
if exist "%WEBCLIENT_RUNTIME%\node.exe" set "PATH=%WEBCLIENT_RUNTIME%;%PATH%"

if not exist "node_modules\" (
    echo WebClient dependencies are missing. Run npm install in the WebClient folder first.
    pause
    exit /b 1
)
if not exist "electron\node_modules\electron\dist\electron.exe" (
    echo Electron is not installed. Run "npm install" in the electron folder first.
    pause
    exit /b 1
)

call npm run build
if errorlevel 1 (
    echo The web build failed; the Electron version was not packed.
    pause
    exit /b 1
)
node electron\build.mjs
if errorlevel 1 (
    pause
    exit /b 1
)
pause
