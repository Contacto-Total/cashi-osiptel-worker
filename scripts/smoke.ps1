# ============================================================
# Smoke test del flujo Osiptel - PowerShell
#
# Verifica:
#   1. Worker healthz
#   2. Worker /check directo (stub o real)
#   3. Backend Java: POST /api/v1/osiptel/batches  (en perfil dev)
#   4. Backend Java: GET /api/v1/osiptel/validations/{phone}
#   5. Backend Java: GET /api/v1/osiptel/metrics
#
# Variables:
#   $WORKER_URL    - default http://localhost:8090
#   $WORKER_TOKEN  - default change-me-shared-secret
#   $BACKEND_URL   - default http://localhost:8085
# ============================================================

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$WORKER_URL   = if ($env:WORKER_URL)   { $env:WORKER_URL }   else { "http://localhost:8090" }
$WORKER_TOKEN = if ($env:WORKER_TOKEN) { $env:WORKER_TOKEN } else { "change-me-shared-secret" }
$BACKEND_URL  = if ($env:BACKEND_URL)  { $env:BACKEND_URL }  else { "http://localhost:8085" }

function Step($title) {
    Write-Host ""
    Write-Host "==> $title" -ForegroundColor Cyan
}

function Ok($msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "    FAIL: $msg" -ForegroundColor Red; exit 1 }

# ----- 1. Worker healthz -----
Step "Worker healthz"
try {
    $health = Invoke-RestMethod -Uri "$WORKER_URL/healthz" -Method Get
    if ($health.status -eq "ok") { Ok ("twoCaptchaConfigured=" + $health.twoCaptchaConfigured) } else { Fail "status != ok" }
} catch { Fail $_.Exception.Message }

# ----- 2. Worker /check directo -----
Step "Worker /check (sintetico)"
$body = @{
    requestId = "smoke-$(Get-Date -UFormat %s)"
    phone     = "987654321"
    dni       = "12345678"
} | ConvertTo-Json -Compress
try {
    $res = Invoke-RestMethod -Uri "$WORKER_URL/check" -Method Post `
        -Headers @{ "X-Worker-Token" = $WORKER_TOKEN; "Content-Type" = "application/json" } `
        -Body $body
    Ok ("status=" + $res.status + " operator=" + $res.operator + " latencyMs=" + $res.latencyMs)
} catch { Fail $_.Exception.Message }

# ----- 3. Backend: encolar lote -----
Step "Backend POST /api/v1/osiptel/batches"
$batch = @{
    phones = @(
        @{ phone = "987654321"; dni = "12345678"; tenantId = 1; subPortfolioId = 1 }
    )
} | ConvertTo-Json -Depth 4 -Compress
try {
    $b = Invoke-RestMethod -Uri "$BACKEND_URL/api/v1/osiptel/batches" -Method Post `
        -Headers @{ "Content-Type" = "application/json" } `
        -Body $batch
    Ok ("enqueued=" + $b.enqueued + " skipped=" + $b.skipped + " batchId=" + $b.batchId)
} catch {
    if ($_.Exception.Response.StatusCode.value__ -eq 423) {
        Write-Host "    INFO: backend retorna 423 (Locked) - normal si legal-review.signed-off=false en prod" -ForegroundColor Yellow
    } else { Fail $_.Exception.Message }
}

# ----- 4. Backend: lookup -----
Step "Backend GET /api/v1/osiptel/validations/987654321"
try {
    $v = Invoke-RestMethod -Uri "$BACKEND_URL/api/v1/osiptel/validations/987654321"
    Ok ("status=" + $v.status + " dniMatch=" + $v.dniMatch + " operator=" + $v.operator)
} catch { Fail $_.Exception.Message }

# ----- 5. Backend: métricas -----
Step "Backend GET /api/v1/osiptel/metrics"
try {
    $m = Invoke-RestMethod -Uri "$BACKEND_URL/api/v1/osiptel/metrics"
    Ok ("total=" + $m.total + " dniMatchRate=" + $m.dniMatchRate)
} catch { Fail $_.Exception.Message }

Write-Host ""
Write-Host "SMOKE OK" -ForegroundColor Green
