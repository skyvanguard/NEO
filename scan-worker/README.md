# NEO free-scan worker (Fase 3)

Worker que corre en **kryon** y ejecuta las evaluaciones gratuitas que caen en
la cola del sitio (`skyvanguard-web`). Un solo slot, secuencial: reclama un job,
lo resuelve con NEO en modo headless, y devuelve el informe.

```
loop:
  GET  {SCAN_API_BASE}/api/jobs/next        → reclama 1 job (Bearer token)
  dsh --profile headless --patch free-scan  → NEO analiza el dominio
  extrae el bloque ```json del informe
  POST {SCAN_API_BASE}/api/jobs/:id/result  → done | failed
```

Solo hace HTTPS **saliente** hacia Vercel y shell-out a `dsh`. No abre puertos ni
expone kryon. La app envía el correo al cliente al recibir el resultado (Fase 4).

## El agente

NEO se retunea con `free-scan.headless.patch.yml`, que reemplaza la persona del
perfil headless por la de un **analista de superficie externa**: alcance
observacional (OSINT pasivo + probing liviano), sin explotación, orientado a
entregar un informe ejecutivo como bloque JSON. Es intencionalmente *lean* —
no reusa el preset `pentest`, cuya persona metódica y verbosa era justo lo que
enlentecía esas sesiones.

Para probar el agente a mano en la Web GUI existe el preset equivalente en
`apps/cli/config/agent-presets/free-scan/agent.cordis.yml` (seleccionable como
"free-scan" al crear una sesión).

## Configuración (variables de entorno)

Ver `.env.example`. Mínimo indispensable: `SCAN_WORKER_TOKEN` (el mismo que en
Vercel) y `DSH_CMD` (cómo se invoca el CLI de NEO en kryon).

## Ejecutar

```bash
# cargar las variables (por ejemplo con un gestor de procesos / systemd / pm2)
node scan-worker/worker.mjs
```

Requiere Node 18+ (usa `fetch` global). El `dsh` debe estar construido y
disponible en kryon (`pnpm run build` en el repo, luego `DSH_CMD="pnpm dsh"`,
o el binario instalado con `DSH_CMD="dsh"`).

## Verificar el overlay antes de correr

```bash
dsh --profile headless --patch scan-worker/free-scan.headless.patch.yml --dump-config
```

Debe mostrar la persona de free-scan en el row `system-prompt`. Luego una prueba
real de una sola tarea:

```bash
dsh --profile headless --patch scan-worker/free-scan.headless.patch.yml \
  "Analizá la superficie de ataque expuesta a internet del dominio \"ejemplo.com.py\". Idioma del informe: es."
```

El stdout debe terminar en un bloque ```json con el informe.
