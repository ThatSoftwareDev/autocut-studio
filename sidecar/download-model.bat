@echo off
REM Laedt EINMALIG ein Whisper-Modell nach sidecar\models (nur die Modelldatei, keine Medien).
REM Aufruf: download-model.bat            -> Modell "small" (ca. 0,5 GB)
REM         download-model.bat base       -> kleiner/schneller, ungenauer
REM Danach arbeitet der Helfer komplett offline.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Bitte zuerst setup.bat ausfuehren.
  pause
  exit /b 1
)
set MODEL=%1
if "%MODEL%"=="" set MODEL=small
".venv\Scripts\python.exe" -m autocut_sidecar download-model %MODEL%
echo.
echo Helfer-Fenster schliessen und start-sidecar.bat neu starten, damit das Modell erkannt wird.
pause
