@echo off
REM Stops the timelapse recorder and finishes the current video file.
cd /d "%~dp0"
if not exist recordings mkdir recordings
echo stop> recordings\STOP
echo asked the recorder to stop; the file is finished within a few seconds
