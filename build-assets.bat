@echo off
REM One-off asset extraction: spell and creature-family icons, the item and creature name dumps,
REM and every item display icon. Everything else the gateway generates on demand.
REM
REM No compiler is needed any more: the archives are read in process through StormLib's
REM WebAssembly build (tools/mpq.mjs), which replaced the C++ helper this script used to build.
REM Locations come from tools/paths.mjs - set CLIENT_DIR or TSWOW_INSTALL to override.
setlocal
cd /d "%~dp0"

if not exist "node_modules\" (
    echo WebClient dependencies are missing. Run npm install first.
    exit /b 1
)

call npm run assets:icons || exit /b 1
call npm run assets:creatures || exit /b 1
call npm run assets:items || exit /b 1
call npm run assets:item-icons || exit /b 1
endlocal
