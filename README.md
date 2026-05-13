# cashi-osiptel-worker

Worker Node.js que valida titularidad telefónica contra el portal de Osiptel mediante Playwright + 2Captcha. Hace parte del sistema Cashi (Fase 1 standalone).

## Estado actual

**Scaffold con stub.** La lógica de Playwright + parsing del portal + 2Captcha se implementa en el hito B5 del plan. El stub permite levantar el servidor, validar el contrato HTTP con el backend Java, y correr smoke tests.

## Quickstart (dev local)

```bash
npm install
cp .env.example .env
# Editar .env: PORT, WORKER_TOKEN, TWO_CAPTCHA_KEY
npm run dev
```

Smoke test:

```bash
curl -X POST http://localhost:8090/check \
  -H "Content-Type: application/json" \
  -H "X-Worker-Token: change-me-shared-secret" \
  -d '{"requestId":"smoke-1","phone":"987654321","dni":"12345678"}'
```

Respuesta esperada (stub): `status=ERROR, error=stub:not-implemented`. El contrato es correcto pero la lógica todavía no consulta Osiptel.

## Endpoints

| Verbo | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/check` | X-Worker-Token | Valida 1 número, ≤90s síncrono |
| GET | `/healthz` | público | Liveness |
| GET | `/readyz` | público | Readiness (devuelve 503 si no hubo check exitoso en 5min) |
| GET | `/metrics` | público | Prometheus |

## Privacidad (Ley 29733)

- El worker **NUNCA** retorna el nombre del titular. Solo `operator` (público) y `dniMatch` boolean.
- El DNI input se usa para calcular el match contra lo que devuelve el portal, y se descarta antes de responder.
- Logs enmascaran el `phone` (solo últimos 3 dígitos) y nunca incluyen DNI.

## Docker

```bash
docker build -t cashi-osiptel-worker:0.1 .
docker run --rm -p 8090:8090 --env-file .env cashi-osiptel-worker:0.1
```

## Variables de entorno

Ver `.env.example`. Las más importantes:

- `WORKER_TOKEN`: shared secret con el backend Java.
- `TWO_CAPTCHA_KEY`: API key de 2Captcha (cuando se implemente B5).
- `PROXY_LIST`: lista CSV de proxies residenciales (recomendado en piloto).
- `BAN_THRESHOLD` / `BAN_COOLDOWN_MS`: circuit breaker ante detección de bot.
