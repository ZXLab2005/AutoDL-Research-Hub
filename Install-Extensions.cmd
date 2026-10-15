@echo off
setlocal
set "TEMP=%~dp0data\temp"
set "TMP=%TEMP%"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-Hub.ps1" -InstallExtensions -NoLaunch
pause
endlocal
