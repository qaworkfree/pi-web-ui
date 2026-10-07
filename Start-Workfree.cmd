@echo off
rem Visible foreground launcher. Paths with spaces are supported; no hidden processes.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-workfree-local.ps1" %*
if errorlevel 1 pause
