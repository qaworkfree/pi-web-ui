@echo off
rem Use the installed automatic updater when this checkout belongs to the local stack.
if exist "%~dp0..\service-config.json" (
    call "%~dp0..\Launch pipipiPopopo.cmd" %*
    exit /b
)
rem Visible foreground launcher. Paths with spaces are supported; no hidden processes.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-workfree-local.ps1" %*
if errorlevel 1 pause
