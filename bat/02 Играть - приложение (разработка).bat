@echo off
setlocal
title TSWoW WebClient - Electron (dev)
cd /d "%~dp0.."

rem Electron version, development, in one click: starts what is missing in their own windows -
rem the Vite dev server (script 01) and the gateway (script 10) - then opens the shell
rem (electron\main.cjs) on the performance cores around the page from Vite. Until both answer,
rem the window says what it is waiting for. Extra options pass through, for example:
rem   02 ... --priority=high
rem   02 ... --webclient-url=http://127.0.0.1:5173/?framexml=1
rem   02 ... --web-dir=dist\web        the built page instead of Vite (stop Vite first)
rem F11 toggles full screen, F12 opens DevTools, Ctrl+R reloads.

set "WEBCLIENT_RUNTIME=%WEBCLIENT_NODE_DIR%"
if not defined WEBCLIENT_RUNTIME set "WEBCLIENT_RUNTIME=%~dp0..\.runtime\node"
if exist "%WEBCLIENT_RUNTIME%\node.exe" set "PATH=%WEBCLIENT_RUNTIME%;%PATH%"

set "ELECTRON=%~dp0..\electron\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
    echo Electron is not installed. Run "npm install" in the electron folder first.
    pause
    exit /b 1
)

rem Scripts 01 and 10 by their number: their Cyrillic names are never written inside a .bat.
set "WEB_DEV_BAT="
for %%F in ("%~dp001 *.bat") do set "WEB_DEV_BAT=%%~fF"
set "GATEWAY_BAT="
for %%F in ("%~dp010 *.bat") do set "GATEWAY_BAT=%%~fF"
if not defined WEB_DEV_BAT goto missing
if not defined GATEWAY_BAT goto missing

node tools\port.mjs check 5173
if errorlevel 1 (
    rem Script 01 also starts the gateway when it is missing.
    start "TSWoW WebClient - web (dev)" "%WEB_DEV_BAT%" --no-browser
) else (
    node tools\port.mjs check 8090 || start "TSWoW WebClient Gateway" "%GATEWAY_BAT%"
)

start "" "%ELECTRON%" "%CD%\electron" %*
exit /b 0

:missing
echo Script 01 or 10 is missing from the bat folder.
pause
exit /b 1
