@echo off
REM Einmalig: eigene Python-Umgebung fuer den Helfer anlegen und Abhaengigkeiten (numpy, faster-whisper) installieren.
cd /d "%~dp0"

where py >nul 2>nul
if errorlevel 1 (
  echo Python wurde nicht gefunden. Bitte Python 3.11 oder 3.12 von python.org installieren
  echo und beim Installieren "Add python.exe to PATH" anhaken.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Lege Python-Umgebung an ...
  py -3 -m venv .venv || goto :fail
)

echo Installiere Abhaengigkeiten ...
".venv\Scripts\python.exe" -m pip install --upgrade pip || goto :fail
".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :fail

echo.
echo Pruefe ffmpeg ...
where ffmpeg >nul 2>nul
if errorlevel 1 (
  if not exist "bin\ffmpeg.exe" (
    echo ffmpeg fehlt noch. Installieren mit:  winget install Gyan.FFmpeg
    echo oder ffmpeg.exe in den Ordner sidecar\bin legen.
  )
) else (
  echo ffmpeg gefunden.
)

echo.
echo Selbsttest ...
".venv\Scripts\python.exe" -m unittest discover -s tests || goto :fail

echo.
echo Fertig. Fuer B-Roll einmalig download-model.bat ausfuehren (laedt das Whisper-Modell).
echo Dann den Helfer mit start-sidecar.bat starten.
pause
exit /b 0

:fail
echo.
echo Da ist etwas schiefgegangen - siehe Meldungen oben.
pause
exit /b 1
