#!/usr/bin/env bash
# ============================================================
# Smoke test del cashi-osiptel-worker (modelo NO-ortogonal V17+)
#
# Variables (override por entorno):
#   WORKER_URL    default http://localhost:8090
#   WORKER_TOKEN  default change-me-shared-secret
#   DNI           default 12345678  (documento real para probar contra el portal)
#   BACKEND_URL   default http://localhost:8085
#   ID_MC         id de metodos_contacto para probar el flujo backend (opcional)
# ============================================================
set -euo pipefail

WORKER_URL=${WORKER_URL:-http://localhost:8090}
WORKER_TOKEN=${WORKER_TOKEN:-change-me-shared-secret}
DNI=${DNI:-12345678}
BACKEND_URL=${BACKEND_URL:-http://localhost:8085}
ID_MC=${ID_MC:-}

step() { echo; echo "==> $1"; }
ok()   { echo "    OK: $1"; }
fail() { echo "    FAIL: $1" >&2; exit 1; }

# --- 1. Worker healthz ---
step "Worker healthz"
curl -fsS "$WORKER_URL/healthz" | tee /tmp/osiptel_health.json > /dev/null || fail "healthz unreachable"
status=$(jq -r '.status' /tmp/osiptel_health.json 2>/dev/null || echo "?")
[ "$status" = "ok" ] || fail "status=$status"
ok "captchaMode=$(jq -r .captchaMode /tmp/osiptel_health.json) poolSize=$(jq -r .poolSize /tmp/osiptel_health.json)"

# --- 2. IP saliente del worker (debe ser peruana si la VPN esta activa) ---
step "IP saliente"
ip=$(curl -fsS --max-time 15 https://ifconfig.me 2>/dev/null || echo "?")
echo "    IP de esta maquina: $ip  (deberia ser peruana si corres tras VPN)"

# --- 3. Worker /check contra el portal real ---
step "Worker /check (DNI=$DNI)"
RID="smoke-$(date +%s)"
res=$(curl -fsS -X POST "$WORKER_URL/check" \
  -H "Content-Type: application/json" \
  -H "X-Worker-Token: $WORKER_TOKEN" \
  -d "{\"requestId\":\"$RID\",\"dni\":\"$DNI\",\"dniType\":\"DNI\"}") || fail "/check unreachable"
wstatus=$(echo "$res" | jq -r '.status')
ok "$(echo "$res" | jq -c '{status, linesCount: (.lines|length), captchaAttempts, latencyMs}')"
case "$wstatus" in
  OK|NOT_FOUND) echo "    -> portal respondio correctamente" ;;
  CAPTCHA_FAIL) echo "    -> score reCAPTCHA v3 bajo o grecaptcha no cargo. Evaluar stealth/xvfb." ;;
  BANNED)       echo "    -> portal bloqueo la IP. VPN PE no activa o IP en blacklist." ;;
  ERROR)        echo "    -> $(echo "$res" | jq -r '.error')  (revisar /tmp/osiptel-fail.{html,png})" ;;
esac

# --- 4. (Opcional) flujo completo via backend ---
if [ -n "$ID_MC" ]; then
  step "Backend POST /api/v1/osiptel/validate/$ID_MC"
  v=$(curl -fsS -X POST "$BACKEND_URL/api/v1/osiptel/validate/$ID_MC") || fail "backend unreachable"
  ok "$(echo "$v" | jq -c '{status, operator, errorDetail, latencyMs}')"
else
  echo
  echo "==> (paso backend omitido: exporta ID_MC=<id metodos_contacto> para probarlo)"
fi

echo
echo "SMOKE FIN"
