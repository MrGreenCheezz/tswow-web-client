@echo off
setlocal
title TSWoW WebClient - player app build
cd /d "%~dp0.."

rem Builds the app to send to other players: dist\player\WoWWebClient.zip. It is Electron with the
rem shell only: it opens the page this machine serves (start-server.bat) at PUBLIC_HOST and
rem PUBLIC_WEB_PORT from .env, and holds nothing from a WoW client. Rebuild it after changing
rem either value; changes to the game itself reach players through start-server.bat alone.
rem   build-player.bat --url=http://203.0.113.10:8091/    another address for this one build

set "WEBCLIENT_RUNTIME=%WEBCLIENT_NODE_DIR%"
if not defined WEBCLIENT_RUNTIME set "WEBCLIENT_RUNTIME=%~dp0..\.runtime\node"
if exist "%WEBCLIENT_RUNTIME%\node.exe" set "PATH=%WEBCLIENT_RUNTIME%;%PATH%"

if not exist "electron\node_modules\electron\dist\electron.exe" (
    echo Electron is not installed. Run "npm install" in the electron folder first.
    pause
    exit /b 1
)

node electron\build.mjs --player %*
if errorlevel 1 (
    pause
    exit /b 1
)
start "" "dist\player"
pause
