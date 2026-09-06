#!/usr/bin/env bash
#
# Hardening del free-scan worker en kryon (hallazgos A3/A4/B2 del threat model:
# websky/skyvanguard-web/docs/security/pipeline-scan-threat-model.md).
#
# QUÉ HACE:
#   1. Instala bubblewrap  -> el harness detecta el sandbox y deja de fallar
#      cerrado; NEO recupera el shell local (dig/curl/openssl) en modo
#      workspace-write (fs read-only salvo el workspace del scan).
#   2. Crea el usuario de servicio `neo-scan` SIN sudo y SIN docker, dueño del
#      workspace  -> aunque una inyección de prompt logre ejecutar, no hay
#      camino a root por el grupo docker ni por sudo.
#   3. Mueve los secretos del worker a un EnvironmentFile 600 (deja de estar en
#      un .sh ejecutable legible) y corre el worker como `neo-scan`.
#
# NO se ejecuta solo. Es idempotente y está pensado para correr POR PARTES,
# revisando cada bloque. Requiere sudo. NO correr mientras NEO tiene un trabajo
# activo: reinicia el worker.
#
# Uso sugerido, bloque por bloque (NO ejecutar entero a ciegas):
#   sudo bash -c 'source harden-deploy.sh; step_bwrap'
#   sudo bash -c 'source harden-deploy.sh; step_user'
#   sudo bash -c 'source harden-deploy.sh; step_secrets_and_service'
#   sudo bash -c 'source harden-deploy.sh; verify'
set -euo pipefail

NEO_HOME="/home/skyvanguard/NEO"
SCAN_USER="neo-scan"
SCAN_HOME="/home/${SCAN_USER}"
WORKSPACE="${SCAN_HOME}/neo-scans"
ENV_FILE="/etc/neo-scan/worker.env"
SERVICE="/etc/systemd/system/neo-scan-worker.service"

# --- Paso 1: sandbox real -----------------------------------------------------
step_bwrap() {
  echo ">> instalando bubblewrap"
  apt-get update -y
  apt-get install -y bubblewrap
  echo ">> probe funcional (debe imprimir OK):"
  # El mismo probe que hace el harness. Si falla acá, el harness seguirá
  # fallando cerrado (seguro) — revisar apparmor_restrict_unprivileged_userns.
  bwrap --ro-bind / / --dev /dev --proc /proc --die-with-parent -- \
    bash -c 'echo OK' || {
      echo "!! bwrap no pudo crear el perfil. Revisar:"
      echo "   cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns  (=1 restringe)"
      echo "   Ubuntu 24.04 trae un perfil AppArmor para bwrap; si falta, instalarlo."
      return 1
    }
}

# --- Paso 2: usuario de servicio sin privilegios ------------------------------
step_user() {
  echo ">> creando usuario ${SCAN_USER} (sin sudo, sin docker)"
  if ! id "${SCAN_USER}" >/dev/null 2>&1; then
    useradd --create-home --shell /usr/sbin/nologin "${SCAN_USER}"
  fi
  # Verificación dura: que NO esté en grupos peligrosos.
  if id -nG "${SCAN_USER}" | tr ' ' '\n' | grep -qE '^(sudo|docker|adm)$'; then
    echo "!! ${SCAN_USER} está en un grupo peligroso — abortar y revisar"; return 1
  fi
  mkdir -p "${WORKSPACE}"
  chown -R "${SCAN_USER}:${SCAN_USER}" "${WORKSPACE}"
  echo ">> ${SCAN_USER} groups: $(id -nG ${SCAN_USER})"
}

# --- Paso 3: secretos fuera del .sh + servicio como neo-scan ------------------
step_secrets_and_service() {
  echo ">> migrando secretos a ${ENV_FILE} (600)"
  install -d -m 700 /etc/neo-scan
  # Portar los valores desde el script viejo si el EnvironmentFile aún no existe.
  # Editar a mano si hace falta rotar el token (recomendado: rotar en Vercel).
  if [[ ! -f "${ENV_FILE}" ]]; then
    cat > "${ENV_FILE}" <<'ENV'
SCAN_API_BASE=https://www.skyvanguard.com.py
SCAN_WORKER_TOKEN=REEMPLAZAR_POR_TOKEN_ROTADO
DSH_CMD=node /home/skyvanguard/NEO/apps/cli/lib/bin.js
FREE_SCAN_PATCH=/home/skyvanguard/NEO/scan-worker/free-scan.headless.patch.yml
SCAN_WORKSPACE=/home/neo-scan/neo-scans
SCAN_WORKER_ID=neo-kryon-1
ENV
    chmod 600 "${ENV_FILE}"
    echo "!! editá ${ENV_FILE} y poné el token (ideal: rotarlo antes en Vercel)"
  fi

  echo ">> escribiendo unit de sistema ${SERVICE}"
  cat > "${SERVICE}" <<UNIT
[Unit]
Description=NEO free-scan worker (hardened)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SCAN_USER}
Group=${SCAN_USER}
WorkingDirectory=${WORKSPACE}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node ${NEO_HOME}/scan-worker/worker.mjs
Restart=always
RestartSec=10
# Endurecimiento de systemd (defensa en profundidad, además del sandbox del harness)
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${WORKSPACE}
ProtectControlGroups=true
ProtectKernelModules=true
RestrictSUIDSGID=true
# Egress filtering: cierra el SSRF del free-scan a nivel de kernel. El scanner
# necesita alcanzar IPs publicas arbitrarias (cualquier dominio de cliente),
# pero NUNCA la red interna. Un dominio del atacante cuyo DNS/CT resuelva a
# loopback o a la red docker de kryon queda bloqueado aca, cubriendo por igual
# curl/openssl del bash del agente y web_fetch.
# Si el API de resultados (SCAN_API_BASE) vive en una IP privada, agregala como
# IPAddressAllow=<ip> ANTES del deny (la regla mas especifica gana).
IPAddressAllow=any
IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 127.0.0.0/8 ::1/128 fc00::/7 fe80::/10
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
UNIT

  echo ">> el harness debe ser legible por ${SCAN_USER} (solo lectura del checkout)"
  echo "   revisá permisos de ${NEO_HOME} si el arranque falla por EACCES"
  systemctl daemon-reload
  echo ">> para activar (cuando NEO NO esté en un job):"
  echo "   systemctl --user -M skyvanguard@ stop neo-scan-worker  # apagar el viejo (user unit)"
  echo "   systemctl enable --now neo-scan-worker                 # el nuevo (system unit)"
}

verify() {
  echo "== bubblewrap =="; command -v bwrap && bwrap --version || echo "FALTA"
  echo "== usuario =="; id "${SCAN_USER}" 2>/dev/null || echo "FALTA"
  echo "== env file =="; ls -l "${ENV_FILE}" 2>/dev/null || echo "FALTA"
  echo "== service =="; systemctl is-enabled neo-scan-worker 2>/dev/null || echo "no habilitado"
  echo "== prueba de shell confinado (como neo-scan) =="
  sudo -u "${SCAN_USER}" bash -lc "cd ${WORKSPACE} && node ${NEO_HOME}/apps/cli/lib/bin.js --profile headless 'Ejecutá bash: id; y bash: cat /etc/hostname. Reportá la salida exacta.'" 2>&1 | tail -8
}

echo "harden-deploy.sh cargado. Funciones: step_bwrap, step_user, step_secrets_and_service, verify"
echo "NO correr con NEO en un job activo (reinicia el worker)."
