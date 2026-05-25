@echo off
title cashi-osiptel-worker (iniciando)
cd /d "%~dp0"

:: ── Pre-flight checks ──────────────────────────────────────────────
where node >NUL 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js no instalado. Corre primero setup.bat
    pause & exit /b 1
)

if not exist node_modules (
    echo [ERROR] Dependencias no instaladas. Corre primero setup.bat
    pause & exit /b 1
)

if not exist dist\server.js (
    echo [ERROR] Worker no compilado. Corre primero setup.bat
    pause & exit /b 1
)

if not exist .env (
    echo [ERROR] Archivo .env no encontrado. Corre primero setup.bat
    pause & exit /b 1
)

:: ── Detectar doble instancia por titulo de ventana ─────────────────
powershell -NoProfile -Command "if (Get-Process | Where-Object {$_.MainWindowTitle -eq 'cashi-osiptel-worker'}) { exit 1 } else { exit 0 }"
if %ERRORLEVEL% == 1 (
    echo [ERROR] El worker ya esta corriendo. Cierra esa ventana primero.
    pause & exit /b 1
)

title cashi-osiptel-worker
echo ================================================================
echo   cashi-osiptel-worker
echo   Validando titularidad de telefonos contra el portal Osiptel.
echo   Cerrando esta ventana detiene el worker.
echo ================================================================
echo.

:: ── Loop con auto-restart ──────────────────────────────────────────
:loop
node --env-file=.env dist\server.js
set EXIT=%ERRORLEVEL%

echo.
echo [WARN] Worker detenido (codigo %EXIT%). Reiniciando en 10s... (Ctrl+C para salir)
timeout /t 10 /nobreak >NUL
goto loop
