# Instalación del cashi-osiptel-worker en la VM

Guía completa para dejar el worker corriendo en una VM Ubuntu. Pensada para QAS.

## Prerrequisitos

- VM Ubuntu 22.04+ con acceso a internet.
- **Node 20 LTS**. Si no está instalado:
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
  ```
- `jq` para los smoke tests: `sudo apt install -y jq`

## Paso 1 — Traer el código

```bash
cd /home/ubuntu/cashi
git clone -b qas https://github.com/Contacto-Total/cashi-osiptel-worker.git
# o si ya existe: cd cashi-osiptel-worker && git checkout qas && git pull
cd cashi-osiptel-worker
```

## Paso 2 — Bootstrap (un solo comando)

```bash
sudo bash deploy/bootstrap.sh
```

Esto hace, de forma idempotente:
1. Verifica Node 20+.
2. Crea el usuario de servicio `osiptelworker`.
3. Da permiso de traversal al path del repo.
4. `npm ci` — instala dependencias.
5. Instala Chromium de Playwright en `/opt/ms-playwright` (compartido).
6. `npm run build` — compila TS a `dist/`.
7. Crea `.env` desde `.env.example` si no existe.
8. Genera e instala el unit systemd `/etc/systemd/system/cashi-osiptel-worker.service` con los paths reales.

## Paso 3 — Configurar el `.env`

```bash
sudo nano /home/ubuntu/cashi/cashi-osiptel-worker/.env
```

Lo único obligatorio de cambiar:

| Variable | Valor |
|---|---|
| `WORKER_TOKEN` | Debe ser **igual** a `cashi.osiptel.worker-token` del backend `web-service-cashi`. Hoy es `3a1586fab5cac405e4b1ec0d8195bb50e269c02e7a154d4662deea588d110a0a` |

El resto tiene defaults válidos. **No hay variable de captcha** — el token reCAPTCHA v3 lo genera el navegador (gratis).

## Paso 4 — VPN con IP peruana

El portal Osiptel bloquea IPs de AWS. Seguir **`docs/VPN-SETUP.md`** para montar Windscribe Lima con routing selectivo (solo el worker sale por VPN).

Sin VPN, el worker arranca igual pero `/check` devolverá `BANNED` o `ERROR: form-not-found`.

## Paso 5 — Arrancar el servicio

```bash
sudo systemctl enable --now cashi-osiptel-worker
sudo systemctl status cashi-osiptel-worker
sudo journalctl -u cashi-osiptel-worker -f       # ver logs en vivo
```

## Paso 6 — Smoke test

```bash
cd /home/ubuntu/cashi/cashi-osiptel-worker
# WORKER_TOKEN debe coincidir con el del .env; DNI = un documento real para probar
WORKER_TOKEN=3a1586fab5cac405e4b1ec0d8195bb50e269c02e7a154d4662deea588d110a0a \
DNI=<un-dni-real> \
bash scripts/smoke.sh
```

Interpretación del resultado de `/check`:

| status | Significado | Acción |
|---|---|---|
| `OK` | Portal devolvió líneas | ✅ funciona |
| `NOT_FOUND` | DNI sin líneas registradas | ✅ funciona (respuesta válida) |
| `CAPTCHA_FAIL` | Score reCAPTCHA v3 bajo o `grecaptcha` no cargó | Aplicar mitigaciones de score (abajo) |
| `BANNED` | Portal bloqueó la IP | VPN no activa o IP en blacklist → revisar `docs/VPN-SETUP.md` |
| `ERROR: form-not-found` | El portal sirvió HTML distinto | Casi siempre = sin VPN PE. Ver `/tmp/osiptel-fail.html` |

## Si el score reCAPTCHA v3 sale bajo (`CAPTCHA_FAIL` recurrente)

Mitigaciones, todas gratis, en orden de esfuerzo:

1. **Correr con display virtual** (headless real puntúa peor que headed):
   ```bash
   sudo apt install -y xvfb
   ```
   y en `.env`: `PLAYWRIGHT_HEADLESS=false`, y envolver el `ExecStart` con `xvfb-run`
   (editar el unit: `ExecStart=/usr/bin/xvfb-run -a <node> <repo>/dist/server.js`).

2. **Plugin stealth** — agregar `playwright-extra` + `puppeteer-extra-plugin-stealth`
   (oculta señales de automation). Requiere un cambio menor en `browser-pool.ts`.

3. **Reusar el contexto del navegador** entre checks para acumular reputación
   (subir `WORKER_RECYCLE_AFTER` en `.env`).

## Operación

```bash
# Reiniciar tras un git pull + rebuild
cd /home/ubuntu/cashi/cashi-osiptel-worker && git pull && npm ci && npm run build
sudo systemctl restart cashi-osiptel-worker

# Métricas Prometheus
curl -s localhost:8090/metrics | grep '^osiptel_worker_'

# Detener
sudo systemctl stop cashi-osiptel-worker
```
