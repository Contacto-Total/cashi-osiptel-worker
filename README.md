# cashi-osiptel-worker

Worker Node.js que consulta el portal `checatuslineas.osiptel.gob.pe` por DNI/CE/Pasaporte/RUC y devuelve la lista de líneas telefónicas asociadas, usando Playwright + 2Captcha.

Es invocado por `web-service-cashi` (paquete `com.cashi.osiptel`) en el modelo NO-ortogonal V17+. Corre dentro de una VM con **VPN de salida peruana** porque las IPs de AWS están bloqueadas por Imperva/portal Osiptel. Ver `docs/VPN-SETUP.md`.

## Estado actual

**Contrato estable.** El worker consulta por documento y devuelve líneas; el matching `phone → lines.phonePrefix` se hace en el cliente Java (`OsiptelClient.matchPhoneAgainstLines`). No es responsabilidad del worker decidir VALIDADO/NO_VALIDADO — eso depende del teléfono del cliente, que es contexto del backend.

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
