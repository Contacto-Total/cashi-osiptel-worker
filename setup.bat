@echo off
title Instalacion - cashi-osiptel-worker
cd /d "%~dp0"

echo ================================================================
echo   cashi-osiptel-worker -- Setup
echo ================================================================
echo.

:: ── Verificar Node.js ──────────────────────────────────────────────
where node >NUL 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js no esta instalado.
    echo Abriendo pagina de descarga...
    start https://nodejs.org/en/download
    echo.
    echo Instala Node.js 20 LTS y vuelve a correr este setup.bat
    pause & exit /b 1
)

for /f %%v in ('node -v') do set NODE_VER=%%v
echo [OK] Node.js encontrado: %NODE_VER%

:: ── Crear .env si no existe ────────────────────────────────────────
if not exist .env (
    echo.
    echo Creando .env desde .env.example...
    copy .env.example .env >NUL
    echo [OK] .env creado
    echo      Edita .env si necesitas cambiar BACKEND_URL o BACKEND_TOKEN
) else (
    echo [OK] .env ya existe
)

:: ── Instalar dependencias ──────────────────────────────────────────
echo.
echo Instalando dependencias (npm install)...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm install fallo. Revisa tu conexion a internet.
    pause & exit /b 1
)
echo [OK] Dependencias instaladas

:: ── Compilar TypeScript ───────────────────────────────────────────
echo.
echo Compilando TypeScript (npm run build)...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] La compilacion fallo. Revisa los errores arriba.
    pause & exit /b 1
)
echo [OK] Compilacion exitosa

:: ── Instalar Chromium (Playwright) ────────────────────────────────
echo.
echo Instalando Chromium para Playwright (puede tardar 2-3 min)...
call npm run playwright:install
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] No se pudo instalar Chromium. Revisa tu conexion.
    pause & exit /b 1
)
echo [OK] Chromium instalado

:: ── Crear acceso directo en escritorio ────────────────────────────
echo.
echo Creando acceso directo en el escritorio...
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\Osiptel Worker.lnk'); $sc.TargetPath = '%~dp0start.bat'; $sc.WorkingDirectory = '%~dp0'; $sc.WindowStyle = 1; $sc.Description = 'cashi-osiptel-worker'; $sc.Save()"
echo [OK] Acceso directo "Osiptel Worker" creado en el escritorio

echo.
echo ================================================================
echo   Instalacion completada.
echo   Doble clic en "Osiptel Worker" del escritorio para arrancar.
echo   No requiere ninguna configuracion adicional.
echo ================================================================
echo.
pause
