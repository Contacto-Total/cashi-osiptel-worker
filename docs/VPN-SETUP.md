# VPN Setup — IP saliente peruana para `cashi-osiptel-worker`

El portal `checatuslineas.osiptel.gob.pe` está protegido por Imperva/AWS WAF y **bloquea IPs de datacenters AWS** (HTTP 500 / página de bloqueo). El worker necesita salir por una IP peruana para poder hacer scraping.

Este documento describe cómo montar **Windscribe (free tier, 10 GB/mes)** con servidor de salida Lima/Perú en la VM Ubuntu de QAS, configurando que **solo el proceso del worker** use la VPN, sin afectar el resto del tráfico (SSH, gateway, backend, etc.).

> **Si tras el piloto Windscribe corta por límite de banda o el portal sigue bloqueando**, evaluar PrivadoVPN free (también ofrece Lima a veces) o Bright Data residential proxies (~$15/GB, IPs residenciales reales de hogares peruanos).

---

## 1. Cuenta y config WireGuard

1. Crear cuenta en https://windscribe.com (free, requiere email).
2. Ir a https://windscribe.com/getconfig/wireguard
3. Seleccionar **Location: Lima** (si no aparece, intentar "Peru" o el más cercano: "Bogotá" no sirve — necesita ser PE).
4. **Generar config**. Descargar el archivo `.conf`. Ejemplo del contenido:

```
[Interface]
PrivateKey = <key-privada-generada>
Address = 10.64.x.x/16
DNS = 10.255.255.1
MTU = 1420

[Peer]
PublicKey = <pubkey-server>
AllowedIPs = 0.0.0.0/0
Endpoint = <ip-publica-lima>:443
```

5. Copiar a la VM como `/etc/wireguard/wsclient.conf` con permisos restrictivos:

```bash
sudo install -m 600 -o root -g root /tmp/wsclient.conf /etc/wireguard/wsclient.conf
```

---

## 2. Instalación de WireGuard

```bash
sudo apt update
sudo apt install -y wireguard wireguard-tools iptables-persistent
```

---

## 3. Routing selectivo — solo el worker usa la VPN

**Problema**: si levantamos la VPN normal con `wg-quick up wsclient`, TODO el tráfico de la VM sale por Windscribe — gateway, SSH desde nuestra IP, backend, etc. Eso rompe servicios y consume los 10 GB rapidísimo.

**Solución**: usar `cgroup` + `iptables --uid-owner` para que solo el tráfico del usuario que corre el worker salga por la VPN.

### Paso 3.1 — Crear usuario dedicado para el worker

```bash
sudo useradd -r -m -d /var/lib/osiptel-worker -s /bin/bash osiptelworker
sudo chown -R osiptelworker:osiptelworker /home/ubuntu/cashi/cashi-osiptel-worker
```

(o si preferís dejar el repo en ubuntu, basta con cambiar el ExecStart del systemd unit a `User=osiptelworker` y darle permisos read).

### Paso 3.2 — Levantar WireGuard como interfaz sin tomar el default route

Editar `/etc/wireguard/wsclient.conf` y agregar `Table = off` en `[Interface]` y borrar/comentar `AllowedIPs = 0.0.0.0/0` para evitar que tome la default route:

```ini
[Interface]
PrivateKey = ...
Address = 10.64.x.x/16
DNS = 10.255.255.1
MTU = 1420
Table = off                       # <-- NO tomar default route automaticamente

[Peer]
PublicKey = ...
AllowedIPs = 0.0.0.0/0            # se respeta solo via iptables/routing manual
Endpoint = <ip>:443
```

Levantar:
```bash
sudo wg-quick up wsclient
```

### Paso 3.3 — Routing por UID via `ip rule` + tabla custom

```bash
# Crear tabla de routing dedicada
echo "200 osiptelvpn" | sudo tee -a /etc/iproute2/rt_tables

# Default route en esa tabla = la VPN
sudo ip route add default dev wsclient table osiptelvpn

# Regla: paquetes marcados con fwmark 0x200 usan la tabla osiptelvpn
sudo ip rule add fwmark 0x200 table osiptelvpn

# iptables: marcar tráfico del UID del usuario osiptelworker
WORKER_UID=$(id -u osiptelworker)
sudo iptables -t mangle -A OUTPUT -m owner --uid-owner $WORKER_UID -j MARK --set-mark 0x200

# Persistir reglas iptables
sudo netfilter-persistent save
```

### Paso 3.4 — Verificar

```bash
# Como el usuario del worker:
sudo -u osiptelworker curl -s ifconfig.me
# Debe dar: IP peruana (Windscribe Lima)

# Como ubuntu (resto del trafico):
curl -s ifconfig.me
# Debe dar: IP publica AWS de la VM (sin cambio)
```

---

## 4. Auto-start

```bash
sudo systemctl enable wg-quick@wsclient
```

Y si el worker corre via systemd, agregar `User=osiptelworker` al unit file para que herede el routing.

---

## 5. Monitoreo de cuota Windscribe

10 GB/mes. Cada validación Osiptel consume típicamente **300-800 KB** (página + reCAPTCHA + JS + imágenes). Estimado: 12-30 mil validaciones/mes posibles con el plan free. Suficiente para piloto.

Endpoint útil: https://windscribe.com/myaccount muestra GB consumidos del mes.

Si llegamos al 80% del límite antes de fin de mes → migrar a paid (~5 USD/mes) o evaluar Bright Data.

---

## 6. Troubleshooting

| Síntoma | Causa probable | Fix |
|---|---|---|
| `curl ifconfig.me` desde el worker da IP AWS | Las reglas iptables no se aplicaron o el usuario es otro | Verificar `id` del proceso del worker (`ps -ef | grep node`) y comparar con `iptables -t mangle -L OUTPUT -n -v` |
| Worker no puede salir a internet | `Table = off` removió la default route pero las reglas no enrutaron | Re-aplicar paso 3.3 |
| Portal sigue devolviendo blocked page | La IP de Windscribe Lima está en blacklist de Imperva | Reconectar Windscribe (a veces da IP rotada), o probar otro servidor PE, o evaluar residential proxies |
| Latencia >5s antes había <1s | Tráfico ahora sale por Lima | Esperado. Aumentar `cashi.osiptel.worker-timeout-ms` en `web-service-cashi/application.properties` si hace falta |

---

## 7. Alternativa pagada — Bright Data residential PE

Si Windscribe Lima resulta inviable (banlist, banda, etc.):

- Sign up en https://brightdata.com
- Producto: **Residential Proxies** → Country = Peru
- Endpoint: `pe.proxy.brightdata.com:22225`
- Auth con username/password + sticky session ID por validación
- Costo: ~$15/GB. Para 10k validaciones/mes ≈ $50-100/mes
- Integración: configurar Playwright con proxy:
  ```ts
  browser = await chromium.launch({
    proxy: {
      server: 'pe.proxy.brightdata.com:22225',
      username: 'brd-customer-XXX-zone-residential-country-pe',
      password: process.env.BRIGHTDATA_PASSWORD,
    },
  });
  ```
  Si vamos por esa vía, ya no hace falta la VPN del sistema operativo — el proxy va a nivel browser.
