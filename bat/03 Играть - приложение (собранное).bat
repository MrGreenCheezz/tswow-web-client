@echo off
setlocal
title TSWoW WebClient - Electron
cd /d "%~dp0.."

rem Electron version, built: dist\electron\WoWWebClient.exe serves its own copy of the page on
rem http://127.0.0.1:5173/, so the Vite dev server must not be running. When no gateway listens
rem on 127.0.0.1:8090 the exe starts one from this WebClient folder and stops it on exit (log:
rem .runtime\logs\electron-gateway.log). Options as in script 02, for example --allow-stale.

set "APP=%~dp0..\dist\electron\WoWWebClient.exe"
if not exist "%APP%" (
    echo The Electron version is not built yet. Run script 21, the app build, from the bat folder first.
    pause
    exit /b 1
)

start "" "%APP%" %*
