@echo off
setlocal
title pipipiPopopo launcher
rem Prefer Windows PowerShell modules even when called from PowerShell 7.
set "PSModulePath=%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules;%ProgramFiles%\WindowsPowerShell\Modules;%PSModulePath%"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -File "%~dp0launch.ps1" %*
if errorlevel 1 (
    echo.
    echo Startup failed. See the message above and logs\launcher.log.
    pause
    exit /b 1
)
