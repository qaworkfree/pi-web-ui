@echo off
setlocal
title pipipiPopopo server control
rem Interactive status / manual stop console for the local services.
set "PSModulePath=%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules;%ProgramFiles%\WindowsPowerShell\Modules;%PSModulePath%"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -File "%~dp0server-control.ps1"
if errorlevel 1 (
    echo.
    echo Server control exited with an error.
    pause
    exit /b 1
)
