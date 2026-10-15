@echo off
setlocal
set "TEMP=%~dp0.agent-sync\temp"
set "TMP=%TEMP%"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0github-sync\control.ps1" -Action status
pause
endlocal
