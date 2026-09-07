# Plan: eliminar los identificadores `deepseek` residuales (`dsh`/`DSH_*`, SDK Python)

Continuación del rebrand. Ya hecho y desplegado: scope npm `@deepseek-ai/`→`@neo/`, branding visible, User-Agent/headers/ACP → NEO, traducción es. Falta la marca **DeepSeek Harness** residual: el prefijo de paquete `dsh-`, el bin `dsh`, las env `DSH_*`, el home `~/.dsh`, y el SDK Python `deepseek_harness`.

## Fuera de alcance (NO tocar)
Proveedor DeepSeek **real**: `@neo/dsh-llm-deepseek`, `web-search-deepseek`, provider `deepseek-official`, env `DEEPSEEK_*`. Es integración de modelo, no marca del harness.

## Etapas (orden por riesgo)

### Etapa 1 — Prefijo de paquete `@neo/dsh-*` → `@neo/*` (mecánico, bajo riesgo)
226 paquetes, 7.631 imports. **Cero colisiones** al dropear `dsh-` (verificado por el censo). Codemod atómico estilo el del scope: `@neo/dsh-` → `@neo/` en fuentes trackeadas (excl. `lib/`, `.agents/notes/`), + `pnpm install` + rebuild.
- Excepción: el CLI `@neo/dsh` (sin guion) → `@neo/cli`.
- Gates a editar (hardcodean `@neo/dsh-`): `check-workspace-constraints.ts:300`, `package-invariants.ts:98-121` (`@neo/dsh-invariants`→`@neo/invariants`), `verify-dsh-package-licenses.ts`.
- Verificación: pnpm install, typecheck, build:lib, verify-built-package-invariants, lint.

### Etapa 2 — Bin `dsh` → `neo` (superficie alta, riesgo técnico bajo)
`apps/cli/package.json` bin `dsh`→`neo`. Actualizar invocaciones en docs/CI/tests/snapshots. En kryon: systemd `neo-web` ExecStart `pnpm dsh`→`pnpm neo`; worker default `process.env.DSH_CMD ?? "dsh"`→`"neo"`.

### Etapa 3 — Env `DSH_*` → `NEO_*` + home `~/.dsh` → `~/.neo` (ALTO riesgo, CON COMPAT)
- `home-paths`: `DSH_HOME_DIR_NAME='.dsh'`→`'.neo'`, `DSH_HOME_ENV`→`'NEO_HOME'`. **Compat:** `resolveDshHome` lee `NEO_HOME`→`DSH_HOME`, y si `~/.neo` no existe pero `~/.dsh` sí, usa `~/.dsh` (no rompe datos hasta migrar).
- `DSH_ENV_PREFIX='DSH_'`→`'NEO_'` (subprocess/types.ts). Cambia el contrato del bash del agente (`DSH_SESSION_ID`→`NEO_SESSION_ID`); riesgo: skills/hooks que lean el prefijo viejo.
- Env literales: `DSH_TELEMETRY_DISABLED`, `DSH_AGENTS_HOME` (default `~/.agents`, NO migra), `DSH_CORDIS_CONFIG`, `DSH_CWD`, `DSH_WEB_URL`, etc.
- worker: `DSH_CMD`→`NEO_CMD`; worker.env en kryon.
- **Migración de datos (kryon + local):** parar servicios → `mv ~/.dsh ~/.neo` (atómico, misma FS, reversible) → actualizar systemd env + worker.env + `room-expiry-monitor.sh` → arrancar. Con la compat, el deploy funciona aun antes del `mv`.

### Etapa 4 — Identificadores de código `Dsh*` / `dshHomePath` / `resolveDshHome`
Renombrar a `Neo*`/`neoHomePath`/`resolveNeoHome`. **Excluir Win32/COM** (`DshDialog*`, `DshComRelease`, `DshItemGetDisplayName` — APIs nativas). Actualizar los 2 hardcodes de boot (`gen-cordis-catalog.ts:135`, `cordis-catalog.spec.ts:60`).

### Etapa 5 — SDK Python `deepseek_harness*` → `neo_harness*` (o `neo_sdk`) (interno)
Cero consumidores en repo; publicado solo a PyPI privado GitLab. Renombrar módulos/carpetas (`deepseek_harness`, `deepseek_harness_runtime`), clases (`DeepSeekHarness*`), dist pip (`deepseek-harness-sdk`→`neo-sdk`), y la cadena release (`build-python-release.py`, `.gitlab-ci.yml`, READMEs, dependabot, uv.lock). Riesgo: rompe reinstalaciones internas por nombre pip (no pypi.org).

### Etapa 6 — Wire residual + cosméticos
`serverInfo.name='deepseek-harness-sdk-runtime'` (TS + `test_bundled_runtime.py` en lockstep), `clientInfo` Codex (`wire.ts:135`), User-Agents web-search, OTel `service.name`, fixtures, THIRD_PARTY_NOTICES (regenerar). Regenerar catálogos + snapshots.

### Etapa 7 — Deploy a kryon
Merge → push → pull+install+build en kryon → migración `mv ~/.dsh ~/.neo` + configs → restart → verificar boot + HTTP 200 + UI español + worker activo + que las sesiones históricas siguen visibles.

## Rollback
Cada etapa en commits separados. Migración de datos reversible (`mv ~/.neo ~/.dsh` + revertir configs). La compat en `resolveDshHome` evita pérdida de datos aun con deploy a medias.

## Notas
- `.agents/notes/` (430 archivos, bitácora histórica) NO se tocan (inmutables por hook, y es historia).
- URLs del org GitHub `deepseek-ai` + su gate negativo (`verify-public-repository-links.spec.ts`): decisión de branding aparte.
