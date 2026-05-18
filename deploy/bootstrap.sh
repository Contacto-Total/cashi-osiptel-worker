#!/usr/bin/env bash
#
# Bootstrap del cashi-osiptel-worker en una VM Ubuntu.
# Idempotente: se puede correr varias veces sin romper nada.
#
# Uso:
#   sudo bash deploy/bootstrap.sh
#
# Hace:
#   1. Verifica Node 20+.
#   2. Crea el usuario de servicio (osiptelworker).
#   3. Da permiso de traversal al path del repo para ese usuario.
#   4. npm ci (instala dependencias).
#   5. Instala Chromium de Playwright en un path compartido (/opt/ms-playwright).
#   6. npm run build (compila TS -> dist/).
#   7. Crea .env desde .env.example si no existe.
#   8. Genera e instala el unit systemd con los paths reales.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_USER="${WORKER_USER:-osiptelworker}"
BROWSERS_PATH="/opt/ms-playwright"
SERVICE_NAME="cashi-osiptel-worker"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: corré con sudo -> sudo bash deploy/bootstrap.sh" >&2
  exit 1
fi

echo "==> Repo detectado: $REPO_DIR"

# ---- 1. Node ----
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node no está instalado. Instalá Node 20 LTS:" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs" >&2
  exit 1
fi
NODE_BIN="$(command -v node)"
echo "==> Node $($NODE_BIN -v) en $NODE_BIN"

# ---- 2. Usuario de servicio ----
if ! id "$WORKER_USER" >/dev/null 2>&1; then
  useradd -r -m -d /var/lib/osiptel-worker -s /bin/bash "$WORKER_USER"
  echo "==> Usuario $WORKER_USER creado"
else
  echo "==> Usuario $WORKER_USER ya existe"
fi

# ---- 3. Traversal hasta el repo (el worker user debe poder 'cd' al path) ----
d="$REPO_DIR"
while [ "$d" != "/" ]; do
  chmod o+x "$d" 2>/dev/null || true
  d="$(dirname "$d")"
done
echo "==> Permiso de traversal aplicado hasta $REPO_DIR"

# ---- 4. Dependencias npm ----
cd "$REPO_DIR"
echo "==> npm ci"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

# ---- 5. Chromium de Playwright (path compartido, legible por cualquier usuario) ----
echo "==> Instalando Chromium de Playwright en $BROWSERS_PATH"
mkdir -p "$BROWSERS_PATH"
PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_PATH" npx --yes playwright install --with-deps chromium
chmod -R a+rX "$BROWSERS_PATH"

# ---- 6. Build ----
echo "==> npm run build"
npm run build

# ---- 7. Permisos de lectura para el worker user ----
chmod -R a+rX "$REPO_DIR/dist" "$REPO_DIR/node_modules"

# ---- 8. .env ----
if [ ! -f "$REPO_DIR/.env" ]; then
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  echo "==> .env creado desde .env.example"
  ENV_NEEDS_EDIT=1
else
  echo "==> .env ya existe (no se toca)"
  ENV_NEEDS_EDIT=0
fi
chown "$WORKER_USER":"$WORKER_USER" "$REPO_DIR/.env"
chmod 600 "$REPO_DIR/.env"

# ---- 9. Unit systemd ----
echo "==> Instalando unit systemd /etc/systemd/system/$SERVICE_NAME.service"
sed -e "s|__REPO_DIR__|$REPO_DIR|g" \
    -e "s|__WORKER_USER__|$WORKER_USER|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__BROWSERS_PATH__|$BROWSERS_PATH|g" \
    "$REPO_DIR/deploy/$SERVICE_NAME.service" > "/etc/systemd/system/$SERVICE_NAME.service"
systemctl daemon-reload

echo ""
echo "============================================================"
echo " Bootstrap COMPLETO."
echo "============================================================"
if [ "$ENV_NEEDS_EDIT" -eq 1 ]; then
  echo " 1. EDITA el .env con el WORKER_TOKEN real:"
  echo "      sudo nano $REPO_DIR/.env"
  echo "      (WORKER_TOKEN debe coincidir con cashi.osiptel.worker-token del backend)"
fi
echo " 2. (Recomendado) Montar la VPN PE: ver docs/VPN-SETUP.md"
echo " 3. Arrancar el servicio:"
echo "      sudo systemctl enable --now $SERVICE_NAME"
echo " 4. Ver estado y logs:"
echo "      sudo systemctl status $SERVICE_NAME"
echo "      sudo journalctl -u $SERVICE_NAME -f"
echo " 5. Smoke test:"
echo "      bash scripts/smoke.sh"
echo "============================================================"
