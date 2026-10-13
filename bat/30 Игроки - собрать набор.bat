@echo off
setlocal
title TSWoW WebClient - player app build
cd /d "%~dp0.."

rem Builds what to send to other players. First the app, dist\player\WoWWebClient.zip: Electron
rem with the shell only, it opens the page this machine serves (script 32) at PUBLIC_HOST and
rem PUBLIC_WEB_PORT from .env and holds nothing from a WoW client. Rebuild it after changing
rem either value; changes to the game itself reach players through script 32 alone.
rem Then the kit (tools\player-kit.mjs): a folder in dist with that zip, a short start guide with
rem the browser link and the playtest guide, plus the same folder as one zip; the folder opens
rem at the end.
rem   30 ... --url=http://203.0.113.10:8091/    another address for this one build

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
node tools\player-kit.mjs --open %*
if errorlevel 1 (
    pause
    exit /b 1
)
pause
