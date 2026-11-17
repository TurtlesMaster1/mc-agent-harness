@echo off
REM Starts the timelapse recorder (1 frame per second; files in recordings\).
cd /d "%~dp0"
if exist recordings\STOP del recordings\STOP
powershell -NoProfile -Command "Start-Process node -ArgumentList 'record.js' -WorkingDirectory '%~dp0.' -WindowStyle Hidden"
echo timelapse recording started. Stop it with stop-record.cmd
