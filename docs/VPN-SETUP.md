# VPN Setup — IP peruana para `cashi-osiptel-worker` (AdGuard VPN, gratis)

El portal `checatuslineas.osiptel.gob.pe` bloquea IPs de datacenters cloud (AWS).
El worker necesita salir por una IP peruana.

**Solución gratuita**: AdGuard VPN tiene plan free (3 GB/mes) **con servidor en
Perú** y un CLI Linux que corre en **modo SOCKS5**. El worker apunta Playwright a
ese proxy SOCKS5 — solo el tráfico del worker sale por la VPN, el resto de la VM
queda intacto (no toca routing ni DNS del sistema).

> Por qué AdGuard y no Windscribe/Proton: ningún free tier "clásico" incluye Perú.
> AdGuard free sí lo incluye. 3 GB/mes alcanza para ~4.000–10.000 validaciones
> (cada una ~300–800 KB). Si se agota, AdGuard VPN Pro o evaluar proxy residencial.

---

## 1. Crear cuenta AdGuard VPN (free)

1. Ir a https://adguard-vpn.com — crear cuenta gratis (email).
2. El plan free da 3 GB/mes y acceso a varias ubicaciones, **Perú incluido**.

## 2. Instalar el CLI en la VM

```bash
curl -fsSL https://raw.githubusercontent.com/AdguardTeam/AdGuardVPNCLI/master/scripts/release/install.sh | sh -s -- -v
```

(Si el comando cambió, ver el repo oficial: https://github.com/AdguardTeam/AdGuardVPNCLI)

Verificar:
```bash
adguardvpn-cli --version
```

## 3. Login

```bash
adguardvpn-cli login
```
Pide el email y password de la cuenta AdGuard.

## 4. Modo SOCKS5 + conectar a Perú

```bash
# Modo SOCKS (levanta un proxy local en vez de TUN del sistema)
adguardvpn-cli set-mode SOCKS

# Confirmar / fijar host y puerto (default 127.0.0.1:1080)
adguardvpn-cli set-socks-host 127.0.0.1
adguardvpn-cli set-socks-port 1080

# Ver el nombre exacto de la ubicacion de Peru
adguardvpn-cli list-locations | grep -i peru

# Conectar (ajustar el nombre/codigo segun list-locations)
adguardvpn-cli connect -l Peru

# Estado
adguardvpn-cli status
```

Tras `connect`, queda un proxy SOCKS5 escuchando en `127.0.0.1:1080`.

## 5. Verificar que el proxy sale por Perú

```bash
curl -s --socks5 127.0.0.1:1080 https://ifconfig.me ; echo
# Debe devolver una IP peruana

curl -s --socks5 127.0.0.1:1080 https://ipinfo.io/country ; echo
# Debe devolver: PE
```

## 6. Apuntar el worker al proxy

Editar el `.env` del worker:
```bash
sudo sed -i 's|^PROXY_LIST=.*|PROXY_LIST=socks5://127.0.0.1:1080|' \
  /home/ubuntu/cashi/cashi-osiptel-worker/.env
sudo systemctl restart cashi-osiptel-worker
```

El worker (`browser-pool.ts`) ya lee `PROXY_LIST` y se lo pasa a Playwright —
no requiere cambios de código. Cada contexto Chromium saldrá por el SOCKS5 de
AdGuard, es decir, por Perú.

## 7. Smoke test

```bash
cd /home/ubuntu/cashi/cashi-osiptel-worker
WORKER_TOKEN=$(sudo grep -oP '(?<=^WORKER_TOKEN=).*' .env) \
DNI=<un-dni-real> bash scripts/smoke.sh
```

`/check` debería devolver `OK` o `NOT_FOUND` (ya no `BANNED`/`form-not-found`).

## 8. Que la VPN sobreviva reboots

El `connect` de AdGuard VPN CLI mantiene la conexión vía su daemon, pero conviene
asegurar la reconexión tras un reinicio de la VM. Unit systemd simple:

```ini
# /etc/systemd/system/adguardvpn-peru.service
[Unit]
Description=AdGuard VPN - SOCKS5 salida Peru para osiptel-worker
After=network-online.target
Wants=network-online.target
Before=cashi-osiptel-worker.service

[Service]
Type=oneshot
RemainAfterExit=true
ExecStart=/usr/local/bin/adguardvpn-cli connect -l Peru
ExecStop=/usr/local/bin/adguardvpn-cli disconnect

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now adguardvpn-peru
```

(Verificar la ruta real del binario con `which adguardvpn-cli`.)

## Monitoreo de cuota

3 GB/mes. Ver consumo en https://adguard-vpn.com (panel de la cuenta) o:
```bash
adguardvpn-cli status
```

Si se agota antes de fin de mes → el worker empezará a recibir `BANNED`/timeouts.
Opciones: AdGuard VPN Pro (sin límite) o proxy residencial PE.

## Troubleshooting

| Síntoma | Causa | Fix |
|---|---|---|
| `/check` devuelve `form-not-found` | Worker no sale por el proxy | Verificar `PROXY_LIST` en `.env` y `adguardvpn-cli status` |
| `curl --socks5` da IP de AWS | AdGuard no está conectado o no en modo SOCKS | `adguardvpn-cli set-mode SOCKS && adguardvpn-cli connect -l Peru` |
| `/check` devuelve `BANNED` | IP de AdGuard PE en blacklist del portal, o score reCAPTCHA bajo | Reconectar (otra IP), o evaluar proxy residencial |
| `CAPTCHA_FAIL` recurrente | Score reCAPTCHA v3 bajo | Ver mitigaciones en `deploy/INSTALL.md` (xvfb, stealth) |
| Cuota 3 GB agotada | Mucho tráfico | AdGuard VPN Pro o proxy residencial |
