@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "BRIDGE_DIR=%CD%"
set "WEB_ROOT=%BRIDGE_DIR%\..\web"
set "WEB_STATIC=%WEB_ROOT%"
set "DASH_URL=http://127.0.0.1:8765/"
set "WS_URL=ws://127.0.0.1:8765/ws"

REM --- Static web UI (plain HTML / JS, no Node) ---
echo.
echo [run_bridge.bat] Web dashboard: static files in "%WEB_ROOT%"
echo.

if not exist "%WEB_ROOT%\index.html" (
  echo [run_bridge.bat] Missing "%WEB_ROOT%\index.html"
  goto :fail
)
if not exist "%WEB_ROOT%\main.js" (
  echo [run_bridge.bat] Missing "%WEB_ROOT%\main.js"
  goto :fail
)
if not exist "%WEB_ROOT%\style.css" (
  echo [run_bridge.bat] Missing "%WEB_ROOT%\style.css"
  goto :fail
)

REM --- Python venv + bridge ---
echo [run_bridge.bat] Python bridge ^(venv + pip^)
echo.

set "VENV_PY=%BRIDGE_DIR%\.venv\Scripts\python.exe"

set "BOOT_PY=python"
python --version >nul 2>&1
if errorlevel 1 (
  set "BOOT_PY=py -3"
  py -3 --version >nul 2>&1
  if errorlevel 1 (
    echo [run_bridge.bat] No Python found. Install Python 3.10+ ^(python or py -3^).
    goto :fail
  )
)

if not exist "%VENV_PY%" (
  echo [run_bridge.bat] Creating virtual environment in .venv ...
  if "!BOOT_PY!"=="py -3" (
    py -3 -m venv .venv
  ) else (
    python -m venv .venv
  )
  if errorlevel 1 (
    echo [run_bridge.bat] Failed to create .venv
    goto :fail
  )
)

if not exist "%VENV_PY%" (
  echo [run_bridge.bat] Missing "%VENV_PY%"
  goto :fail
)

echo [run_bridge.bat] Installing / checking Python dependencies...
"%VENV_PY%" -m pip install --disable-pip-version-check -q -r requirements.txt
if errorlevel 1 (
  echo [run_bridge.bat] pip install failed.
  goto :fail
)

echo.
echo ============================================================
echo   Ball machine — dashboard and bridge
echo.
echo   Open this URL in your browser:
echo   !DASH_URL!
echo.
echo   WebSocket ^(same host as the page^):
echo   !WS_URL!
echo.
echo   AI models load from the network ^(Transformers.js via esm.sh^).
echo   Serial: auto-detected ^(override: --port COMn^)
echo ============================================================
echo.
echo Starting server... the default browser should open shortly.
echo Close this window or press Ctrl+C here to stop the bridge.
echo.

"%VENV_PY%" run_bridge.py --static "!WEB_STATIC!" %*
set "RC=!ERRORLEVEL!"

echo.
if not "!RC!"=="0" (
  echo [run_bridge.bat] Bridge stopped with error code !RC!.
) else (
  echo [run_bridge.bat] Bridge stopped.
)
echo.
pause
exit /b !RC!

:fail
echo.
echo [run_bridge.bat] Something went wrong ^(see messages above^).
echo.
pause
exit /b 1
