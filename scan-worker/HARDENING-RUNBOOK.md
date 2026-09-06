# Runbook — blindaje del free-scan worker (#3 del threat model)

> Corresponde a A3/A4/B2 de
> `websky/skyvanguard-web/docs/security/pipeline-scan-threat-model.md`.
> Script: `harden-deploy.sh` (idempotente, por pasos). **No correr con NEO en un
> trabajo activo** — reinicia el worker.

## Por qué las tres partes van juntas

Instalar bubblewrap **solo** no basta. bwrap confina el filesystem (todo
read-only salvo el workspace), pero el proceso sigue siendo el usuario
`skyvanguard`, que está en el grupo **`docker`** → el socket de Docker es una vía
a root que el confinamiento de filesystem no cierra. Por eso el paso 2 (usuario
`neo-scan` sin sudo ni docker) es parte del mismo blindaje, no un extra.

Resultado con los tres pasos: aunque una inyección de prompt logre ejecutar un
comando, corre (a) confinado por bwrap, (b) como un usuario sin sudo ni docker,
(c) con el token del worker fuera de su alcance de escritura y en un archivo 600.

## Pre-requisitos

- `sudo` en kryon (pide contraseña — lo corrés vos).
- **NEO sin job activo.** Verificar antes:
  ```
  XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user status neo-scan-worker
  # y que no haya un `node ... bin.js --profile headless` corriendo un scan
  ps -ef | grep -E 'bin.js --profile headless' | grep -v grep
  ```
- Kernel con Landlock o AppArmor que permita user-namespaces de bwrap. Ubuntu
  24.04 trae perfil AppArmor para bwrap; el probe del paso 1 lo confirma.

## Secuencia

```bash
cd ~/NEO/scan-worker
git pull                                   # traer harden-deploy.sh

# Paso 1 — sandbox. Desbloquea el shell de NEO. Bajo riesgo, reversible.
sudo bash -c 'source harden-deploy.sh; step_bwrap'

# (opcional) validar que NEO ya ejecuta shell confinado, sin migrar el usuario:
cd ~/neo-scans && node ~/NEO/apps/cli/lib/bin.js --profile headless \
  'Ejecutá bash: id; y bash: cat /etc/hostname. Reportá la salida exacta.'

# Paso 2 — usuario sin privilegios.
sudo bash -c 'source harden-deploy.sh; step_user'

# Paso 3 — secretos 600 + servicio como neo-scan.
#   Antes: rotar SCAN_WORKER_TOKEN en Vercel y en /etc/neo-scan/worker.env.
sudo bash -c 'source harden-deploy.sh; step_secrets_and_service'

# Cambio de servicio (el viejo es user-unit; el nuevo es system-unit):
XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user disable --now neo-scan-worker
sudo systemctl enable --now neo-scan-worker

# Verificación
sudo bash -c 'source harden-deploy.sh; verify'
```

## Rollback

```bash
sudo systemctl disable --now neo-scan-worker            # nuevo (system)
XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user enable --now neo-scan-worker  # viejo (user)
```
El paso 1 (bubblewrap) no necesita rollback: es solo un paquete y mejora todo.

## Después de esto

- Sincronizar la persona: ahora el shell SÍ funciona, así que el "shell local
  primario (dig/curl/openssl)" de la persona pasa a ser real. Verificar con un
  scan manual que NEO usa el shell y no solo `web_fetch`.
- Confirmar que el harness eligió bwrap: en el output del scan, el resultado del
  tool bash reporta el modo de sandbox usado.
