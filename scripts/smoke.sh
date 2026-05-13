#!/usr/bin/env bash
# ============================================================
# Smoke test del flujo Osiptel - bash
#
# Mismo flujo que smoke.ps1. Útil en CI Linux y dev macOS.
# ============================================================
set -euo pipefail

WORKER_URL=${WORKER_URL:-http://localhost:8090}
WORKER_TOKEN=${WORKER_TOKEN:-change-me-shared-secret}
BACKEND_URL=${BACKEND_URL:-http://localhost:8085}

step() { echo; echo "==> $1"; }
ok()   { echo "    OK: $1"; }
fail() { echo "    FAIL: $1" >&2; exit 1; }

# --- 1. Worker healthz ---
step "Worker healthz"
curl -fsS "$WORKER_URL/healthz" | tee /tmp/osiptel_health.json > /dev/null || fail "healthz unreachable"
status=$(jq -r '.status' /tmp/osiptel_health.json 2>/dev/null || echo "?")
[ "$status" = "ok" ] && ok "twoCaptchaConfigured=$(jq -r .twoCaptchaConfigured /tmp/osiptel_health.json)" || fail "status=$status"

# --- 2. Worker /check ---
step "Worker /check (sintetico)"
RID="smoke-$(date +%s)"
res=$(curl -fsS -X POST "$WORKER_URL/check" \
  -H "Content-Type: application/json" \
  -H "X-Worker-Token: $WORKER_TOKEN" \
  -d "{\"requestId\":\"$RID\",\"phone\":\"987654321\",\"dni\":\"12345678\"}")
ok "$(echo "$res" | jq -c '{status, operator, latencyMs}')"

# --- 3. Backend: encolar ---
step "Backend POST /api/v1/osiptel/batches"
http_code=$(curl -s -o /tmp/osiptel_batch.json -w "%{http_code}" -X POST "$BACKEND_URL/api/v1/osiptel/batches" \
  -H "Content-Type: application/json" \
  -d '{"phones":[{"phone":"987654321","dni":"12345678","tenantId":1,"subPortfolioId":1}]}')
if [ "$http_code" = "200" ]; then
  ok "$(jq -c '{enqueued, skipped, batchId}' /tmp/osiptel_batch.json)"
elif [ "$http_code" = "423" ]; then
  echo "    INFO: backend retorna 423 (Locked) - legal-review.signed-off=false en prod"
else
  fail "http=$http_code body=$(cat /tmp/osiptel_batch.json)"
fi

# --- 4. Backend: lookup ---
step "Backend GET /api/v1/osiptel/validations/987654321"
v=$(curl -fsS "$BACKEND_URL/api/v1/osiptel/validations/987654321")
ok "$(echo "$v" | jq -c '{status, dniMatch, operator}')"

# --- 5. Backend: metricas ---
step "Backend GET /api/v1/osiptel/metrics"
m=$(curl -fsS "$BACKEND_URL/api/v1/osiptel/metrics")
ok "$(echo "$m" | jq -c '{total, dniMatchRate}')"

echo
echo "SMOKE OK"
