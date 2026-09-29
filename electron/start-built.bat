@echo off
setlocal
title TSWoW WebClient - Electron

rem Electron version, built: dist\electron\WoWWebClient.exe serves its own copy of the page on
rem http://127.0.0.1:5173/, so the Vite dev server must not be running. When no gateway listens
rem on 127.0.0.1:8090 the exe starts one from this WebClient folder and stops it on exit (log:
rem .runtime\logs\electron-gateway.log). Options as in start-dev.bat.

set "APP=%~dp0..\dist\electron\WoWWebClient.exe"
if not exist "%APP%" (
    echo The Electron version is not built yet. Run electron\build.bat first.
    pause
    exit /b 1
)

start "" "%APP%" %*
