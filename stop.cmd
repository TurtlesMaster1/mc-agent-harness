@echo off
REM Stops the players and their brains.  "stop.cmd all" also stops the Minecraft server and the tunnels.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1" %*
