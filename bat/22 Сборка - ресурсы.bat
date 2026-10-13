@echo off
setlocal
title TSWoW WebClient - asset extraction
cd /d "%~dp0.."

rem One-off asset extraction: spell and creature-family icons, the item and creature name dumps,
rem and every item display icon. Everything else the gateway generates on demand.
rem
rem No compiler is needed any more: the archives are read in process through StormLib's
rem WebAssembly build (tools/mpq.mjs), which replaced the C++ helper this script used to build.
rem Locations come from tools/paths.mjs - set CLIENT_DIR or TSWOW_INSTALL to override.

set "WEBCLIENT_RUNTIME=%WEBCLIENT_NODE_DIR%"
if not defined WEBCLIENT_RUNTIME set "WEBCLIENT_RUNTIME=%~dp0..\.runtime\node"
if exist "%WEBCLIENT_RUNTIME%\node.exe" set "PATH=%WEBCLIENT_RUNTIME%;%PATH%"

if not exist "node_modules\" (
    echo WebClient dependencies are missing. Run npm install first.
    pause
    exit /b 1
)

call npm run assets:icons || goto failed
call npm run assets:creatures || goto failed
call npm run assets:items || goto failed
call npm run assets:item-icons || goto failed
echo.
echo Assets extracted.
pause
exit /b 0

:failed
pause
exit /b 1
