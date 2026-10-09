@echo off
REM Startet den lokalen Analyse-Helfer (nur 127.0.0.1). Fenster offen lassen.
cd /d "%~dp0"
title AutoCut-Helfer
if not exist ".venv\Scripts\python.exe" (
  echo Bitte zuerst setup.bat ausfuehren.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m autocut_sidecar %*
pause
