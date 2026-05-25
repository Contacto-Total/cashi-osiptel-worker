# Genera el ZIP distribuible de cashi-osiptel-worker
# Uso: powershell -ExecutionPolicy Bypass -File build-zip.ps1

$dest = "..\cashi-osiptel-worker-dist.zip"
$temp = "$env:TEMP\cashi-osi-dist"

if (Test-Path $dest) { Remove-Item $dest -Force }
if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
New-Item $temp -ItemType Directory | Out-Null

# Copiar todo excepto lo que no debe ir en el ZIP
robocopy . $temp /E `
    /XD node_modules dist .git deploy docker scripts docs `
    /XF .env worker.lock "*.log" "*.zip" Dockerfile docker-compose.yml `
    /NFL /NDL /NJH /NJS | Out-Null

Compress-Archive -Path "$temp\*" -DestinationPath $dest -Force
Remove-Item $temp -Recurse -Force

$size = [math]::Round((Get-Item $dest).Length / 1MB, 2)
Write-Host ""
Write-Host "ZIP creado: $dest ($size MB)"
Write-Host ""
Write-Host "Contenido para el companero:"
Write-Host "  1. Descomprimir el ZIP"
Write-Host "  2. Doble clic en setup.bat  (instala deps + Chromium, ~3 min)"
Write-Host "  3. Doble clic en 'Osiptel Worker' del escritorio"
