@echo off
setlocal
title TSWoW WebClient Gateway
cd /d "%~dp0"

if not exist "node_modules\" (
    echo WebClient dependencies are missing. Run npm install first.
    pause
    exit /b 1
)

call npm run gateway:dev
if errorlevel 1 pause
