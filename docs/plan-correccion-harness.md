# Plan de corrección del harness — trabajo local

Origen: `docs/auditoria-harness-neo.html` (commit `aefb07975f`) y `docs/auditoria-llama-server-kryon.html` (`135051e7c8`).

Regla del plan: **todo se hace en la copia local**, en la rama `fix/harness-auditoria`. Kryon no recibe nada hasta aviso explícito. Los cambios del motor (flags de llama-server) y los operativos del servidor quedan en la sección final, diferidos.

Cada commit sigue el mismo ciclo: test que falla → implementación mínima → gates del paquete → commit convencional. Un commit por hallazgo, para que el pull en kryon sea revisable y reversible pieza por pieza.

## Gates por commit

```sh
pnpm vitest run <ruta-del-paquete>          # verde
npx tsx scripts/run-oxlint.ts <ruta>        # sin avisos
npx tsc -b tsconfig.host.json               # sin errores
npx vitest run <ruta> --coverage.enabled --coverage.include='<ruta>/src/**'   # 100% por archivo tocado
```

Antes de dar por cerrada cada fase: `pnpm run test` completo. Antes del pull a kryon: `pnpm run typecheck && pnpm run lint && pnpm run test && pnpm run test:snapshot` (los presets tocan snapshots ACP).

Nota Windows: los tests de `shell/bash-local` y `subprocess-local` necesitan Git Bash en el PATH; si alguno es solo-Linux, se marca y se verifica en kryon al hacer el pull.

---

## Fase 0 — Preparación (sin código)

1. `git switch -c fix/harness-auditoria` desde `master` local.
2. Baseline: correr y guardar la salida de `pnpm vitest run packages/core packages/llm packages/session packages/compaction packages/subprocess` para comparar al final.
3. Estado de kryon a recordar para el pull: su checkout está en `a9f17a744d` con cambios locales sin commitear (`apps/cli/config/agent-presets/free-scan/…`, `packages/api/remotes/…`, `packages/client/…`) más los cuatro archivos del fix del NUL que copié a mano. Antes del pull habrá que commitear o guardar eso ahí.

---

## Fase 1 — Contención: que ninguna sesión vuelva a quedar muda

### Commit 1 · `fix(llm-pi-ai): replayState alineado con los bloques descartados por max-tokens` (C2)

| | |
|---|---|
| Archivos | `packages/llm/llm-pi-ai/src/stream.ts:190` · `packages/llm/llm-pi-ai/src/replay.ts:164` · `packages/llm/llm/src/assembler.ts:136` |
| Cambio | El ensamblador expone qué índices descartó en `max-tokens`; `stream.ts` proyecta `replayState.blocks` sobre el mismo conjunto filtrado. Defensa en profundidad: `replay.ts:164` degrada a `foreignAssistant(message)` con un `logger.warn` en vez de lanzar `INVALID_REPLAY_STATE`. |
| Test primero | `loop.spec.ts`: MockAdapter que emite `replayState` y termina con `max-tokens` a mitad de un tool call → el mensaje persistido y su `replayState` tienen el mismo conteo, y el turno siguiente **no** falla. `replay.spec`: conteo desalineado → asistente foráneo, no excepción. |
| Riesgo | Bajo. El fallback a foráneo pierde fidelidad de firma solo en el caso que hoy directamente mata la sesión. |

### Commit 2 · `fix(session): cerrar tool calls huérfanos en reparación y en el scheduler` (C1)

| | |
|---|---|
| Archivos | `packages/core/session/src/repair.ts:48` · `packages/core/agent-loop/src/tool-calls.ts:231` · `packages/core/session/src/invariant.ts:107` |
| Cambio | (a) `repair.ts`: quitar el `clear()` en `step/end` para que la carga en frío sintetice resultados para los huérfanos de steps cerrados — **es lo único que cura sesiones ya rotas en disco**. (b) `tool-calls.ts`: en el `catch` de `runGroup`, antes de relanzar, appendear un resultado sintético con código `TOOL_SCHEDULER_FAILED` para cada call sin resultado (reutilizar `appendSkippedToolCall`). (c) `invariant.ts`: fallar en `step/end` si `pendingCalls` no está vacío. |
| Test primero | `repair.spec.ts:119` hoy afirma el comportamiento roto: invertirlo. `tool-calls.spec.ts:634` produce el estado (3 `tool/call`, 0 `tool/result`): añadir la aserción de que existen 3 resultados sintéticos. |
| Riesgo | Medio-bajo. El cambio en `repair.ts` afecta la carga de toda sesión: correr la suite completa de `core/session` y `session-persistence`. |

### Commit 3 · `fix(session-persistence): cuarentena de batches fallidos y flush tolerante en pre-step` (C3)

| | |
|---|---|
| Archivos | `packages/session/session-persistence/src/write-behind.ts:139-158` · `packages/session/session-checkpoint-policy/src/index.ts:79` |
| Cambio | Contador de fallos por batch; tras N intentos idénticos (N=3, configurable) el batch pasa a cuarentena, se emite **un** evento/aviso no fatal y el resto sigue. Cota sobre `pending` con spill a disco o drop-oldest con marcador persistido. El `flush` de `pre-step` captura, avisa una vez por sesión y **no** aborta el turno. |
| Test primero | `write-behind.spec.ts`: el mismo batch falla 3 veces → cuarentena, `pending` no crece indefinidamente, los batches posteriores sí se escriben. `session-checkpoint-policy` spec: backend que rechaza → el turno continúa y hay exactamente un aviso. |
| Riesgo | Medio. Se cambia semántica de durabilidad: documentar en el docblock que un batch en cuarentena es pérdida acotada y visible, no silenciosa. |

### Commit 4 · `fix(llm): sanear bytes de control en la ingesta y centralizar sanitizeText` (NUL)

| | |
|---|---|
| Archivos | mover `packages/llm/llm-pi-ai/src/sanitize.ts` → `packages/llm/llm/src/sanitize.ts` (exportado por `dsh-llm`) · usar en `llm-pi-ai/src/context.ts` y en `llm-deepseek/src/serialize.ts` · `packages/subprocess/subprocess-local/src/spawn.ts:213,246` |
| Cambio | Un solo `sanitizeText` en el paquete base. `spawn.ts` lo aplica al decodificar (`readFrom` y `finalOutput`) para que el veneno nunca entre a la sesión; los adaptadores lo mantienen como segunda línea. |
| Test primero | Mover `sanitize.spec.ts`; `serialize.spec` de deepseek con NUL → texto limpio; `spawn` spec: proceso que escribe bytes 0x00/0x07 → el texto capturado no los contiene y `lossy`/`spill` siguen correctos. |
| Riesgo | Bajo. Hay que revisar que ningún consumidor "de confianza" de `stdoutMaxBytes` dependa de bytes crudos (grep de `stdoutMaxBytes` en `packages/`). |

### Commit 5 · `fix(compaction-basic): hacer visible el fallo de compactación automática`

| | |
|---|---|
| Archivos | `packages/compaction/compaction-basic/src/index.ts:150-160` |
| Cambio | Además del `logger.warn`, appendear un evento de sesión (`compaction/failed`, una vez por causa y sesión, reutilizando el patrón de `warnedPressureConfigTargets`) que la UI pueda mostrar. |
| Test primero | Compactación que lanza → existe exactamente un evento `compaction/failed` y el turno continúa. |

**Cierre de fase:** `pnpm run test`. Merge parcial no: todo queda en la rama hasta el pull.

---

## Fase 2 — Que la compactación vuelva a dispararse cuando toca

### Commit 6 · `fix(token-meter): cotizar bloques de imagen por sus dimensiones`

| | |
|---|---|
| Archivos | `packages/llm/token-meter/src/estimate.ts:26-47` |
| Cambio | Caso `'image'` explícito: el `attachment` ya trae `width` y `height`; precio = `ceil(w/32) * ceil(h/32)` (patch 16 con merge 2×2 del proyector Qwen-VL) + `BLOCK_OVERHEAD`, con un mínimo de 64. Constante nombrada `IMAGE_PATCH_PX = 32` y comentario que explica de dónde sale. |
| Test primero | `estimate.spec`: imagen 640×320 → 200 tokens (+overhead); 2340×1080 → ~2.500; sin dimensiones → mínimo. |
| Riesgo | Bajo. Es una estimación mejor, no exacta. |

### Commit 7 · `feat(token-meter): calibrar la medición con el usage real del proveedor`

| | |
|---|---|
| Archivos | `packages/llm/token-meter/src/usage-projection.ts` · `projection.ts` |
| Cambio | Cuando la última respuesta trae `inputTokens` reales, el meter ajusta un factor de corrección (`real / estimado`) acotado a [0,5, 3] y lo aplica a la medición del step siguiente. Con eso la heurística de 4 chars/token deja de gobernar sola el umbral de compactación. |
| Test primero | Secuencia de usages reales → el factor converge y `measure()` refleja la corrección; sin usage → factor 1. |
| Riesgo | Medio: toca la proyección que alimenta la UI de "contexto usado". Verificar que el breakdown siga sumando. |

---

## Fase 3 — Dejar de multiplexar el único slot

### Commit 8 · `fix(presets): subagent y subagent_fork en one-shot; workflow serializado`

| | |
|---|---|
| Archivos | `packages/bundle/base/cordis.patch.yml` (row `tool-subagent`) · `apps/cli/config/agent-presets/{pentest,standard,code,cordis}/agent.cordis.yml` (rows `tool-subagent` y `tool-subagent-fork`) · config de `workflow-worker-thread` en los mismos presets |
| Cambio | `backgroundMode: one-shot` en ambas rows (el fork vuelve a su diseño documentado). `maxConcurrentAgents: 1` en los presets CLI. Revisar el texto de la sección de prompt del subagente: con one-shot ya no se emite la parte que empuja al paralelismo (está guardada por `continuable`), verificar que sea así. |
| Test primero | Snapshot ACP (`pnpm run test:snapshot`) — va a cambiar el system prompt; re-grabar con `test:snapshot:record` **solo** tras revisar el diff a mano. Test de `tool-subagent`: con one-shot, `run_in_background` default `false`. |
| Riesgo | Cambia comportamiento visible del agente: menos paralelismo aparente, más rápido en total. Documentar en el commit por qué. |

### Commit 9 · `fix(compaction-tool-result-pruner): podar solo el rango que se va a compactar`

| | |
|---|---|
| Archivos | `packages/compaction/compaction-tool-result-pruner/src/index.ts:136` · call sites en `compaction-basic/src/index.ts:285,309` |
| Cambio | `pruneSession(session, range?)`; los call sites pasan `shadowedSeqs`. La cola retenida no se toca, así el prefijo no se rompe a media altura. |
| Test primero | Pruner con rango → nodos fuera del rango intactos aunque superen el umbral. |

---

## Fase 4 — Herramientas: menos contexto, menos viajes

Orden por retorno. Cada uno es un commit independiente.

| # | Commit | Archivos | Test primero |
|---|---|---|---|
| 10 | `feat(tool-bash): exponer max_output_bytes y bajar el default` | `packages/shell/tool-bash/src/index.ts` (schema) · `bash-local/src/index.ts:109` (default 24_000) | schema acepta el parámetro; salida mayor se trunca con aviso que incluye bytes totales |
| 11 | `fix(tool-fs-search): glob con exclude y sin node_modules por defecto` | `packages/fs/tool-fs-search/src/glob.ts:38,91-105` · descripción de `grep` sobre `.gitignore` | `glob("**/*.ts")` sobre fixture con `node_modules` no los devuelve; `exclude` funciona |
| 12 | `feat(tool-fs-search): grep con output_mode, context y head_limit` | `grep.ts:112-117,287-291` · `search-core.ts:333` (presupuesto en bytes) | `files_with_matches` devuelve solo rutas; `-C` incluye contexto; corte en frontera de match |
| 13 | `fix(tool-fs): diagnóstico de near-miss en FS_EDIT_NOT_FOUND` | `packages/fs/tool-fs/src/error.ts:286` · `fs-local/src/fsio.ts:773` | `old_string` con indentación distinta → mensaje que señala la línea; con prefijo `N: ` → idem |
| 14 | `fix(subagent): filtrar reasoning y acotar la entrega del hijo` | `packages/subagent/subagent/src/continuation.ts:1406` · `assistant-output.ts:96` | reporte con bloques `reasoning` → solo `text` llega al padre; tope aplicado con aviso |
| 15 | `feat(tool-fs): edits[] atómico por archivo` | `packages/fs/tool-fs/src/…` (schema + apply) | tres ediciones en un archivo → una escritura; una que no matchea → ninguna se aplica |
| 16 | `feat(tool-fs-search): primitiva de listado de directorio` | nuevo tool `list_dir` en `tool-fs-search` | lista entradas con tipo y tamaño; respeta `.gitignore` opcionalmente |

Los commits 15 y 16 son los más grandes (~150 líneas cada uno) y cambian el catálogo de tools → snapshot ACP otra vez.

---

## Fase 5 — Rendimiento (después de medir, no antes)

1. Reproducir en local una sesión grande sintética (no copiar la de kryon: contiene datos del proyecto) y perfilar con `node --inspect` el pipeline de un evento por token (`agent.ts:349` + `structuredClone`/`deepFreeze` + invalidación de `eventsSnapshot`).
2. Con el perfil en la mano, decidir entre: batching de chunks antes del append, snapshot incremental de `session.events`, o ambos.
3. Cliente: orden incremental en `chat-snapshot-builder.ts` en vez de sort completo por actualización.

No se escribe código de esta fase sin el perfil. Es la única fase donde la lectura no alcanzó para atribuir el costo.

---

## Diferido al servidor (cuando avises)

**Motor** (`docker` `llm-server`, requiere reinicio del contenedor):
`--no-context-shift` (urgente por la sesión de 215K) · `--tensor-split 56,44` · `-ub 2048 -b 4096` · `-t 16` · `--metrics` · `--cache-reuse 256`. Verificar tras arrancar que no aparezca `retrying without pipeline parallelism`.

**Harness en kryon:** commitear o guardar los cambios locales de ese checkout, `git pull` de la rama, `systemctl --user restart neo-web` (mata emuladores y jobs hijos: coordinar con lo que esté corriendo).

**Operativo:** paso 2 del runbook de free-scan (usuario `neo-scan`) y allow-list de red para ese preset.

---

## Orden de ejecución propuesto

Fase 1 completa (commits 1–5) → Fase 2 (6–7) → Fase 3 (8–9) → Fase 4 en el orden de la tabla → Fase 5 solo con perfil.

Las fases 1 a 3 suman unas 300 líneas de cambio y cierran todo lo que hoy puede dejar una sesión muerta o reprocesando 200K tokens. La fase 4 es mejora sostenida y se puede intercalar.

---

## Seguimiento de ejecución (2026-09-05, rama `fix/harness-auditoria`, 26 commits)

Cada fase se cerró con la suite completa comparada contra `master` en la misma máquina y una revisión de código independiente; los hallazgos de cada revisión se corrigieron dentro de la fase antes de pasar a la siguiente.

### Línea base preexistente (no atribuible a la rama)

- **89 tests fallan en `master` en esta máquina Windows** y los mismos 89 en la rama: rebranding a "NEO" en el system prompt (los tests esperan "DeepSeek Harness"), `symlink` sin privilegios, `NEO_TELEMETRY_MODE`, especificaciones de CI en `scripts/`. Dos tests son flaky (`settings-file/concurrency`, `oxlint-contract`) y alternan entre corridas.
- **Snapshots ACP (`test:snapshot`) rojos en `master`** por el rebranding; además ahora incluyen el bracket `compaction/start`+`end` de fallo de presión (esperado). Re-grabar tras corregir el rebranding; requiere clave.
- **Tres generadores no corren en `master`** por servicios del fork sin documentar: `gen-cordis-catalog` (`documentAttach`, `usageStats` sin `SERVICE_PAGE`), `gen-config-catalog` (`prompt-section` `Config.sections` sin JSDoc). `PruneOptions` quedó clasificado para cuando se reparen. El catálogo de tools sí se regeneró.
- Los tests de `subprocess-local`, `bash-local` y `tool-bash` están excluidos en Windows por configuración; los cambios ahí se verificaron con `tsx` directo y se corren en Linux al hacer el pull.

### Fase 1 — contención

| Commit | Qué | Desvío respecto al plan |
|---|---|---|
| `fc259c4d42` | replayState alineado en `max-tokens`; desajuste degrada a foráneo | — |
| `f021621b91` | resultados sintéticos del scheduler + `closeDanglingToolCalls` en ambos adaptadores | **No se endureció el invariante de `step/end`** ni se tocó `repair.ts`: si el registro de invariantes se montara, las sesiones ya rotas pasarían de mudas a incargables. La cura de sesiones viejas es en la conversión al proveedor. |
| `694ed493d5` | suspensión de durabilidad tras 5 fallos idénticos del mismo batch | **No se descartan batches sueltos**: los `seq` en disco son contiguos y todo lo posterior quedaría rechazado. Se suspende la sesión de forma visible. |
| `fe11ecbcaa` | saneo en la captura del subprocess; `sanitizeText` en `dsh-llm` para ambos adaptadores | — |
| `079371767d` | fallo de compactación previo al bracket registrado en la sesión | — |
| Revisión | `0ca17536e7` resultados reales detrás de un fallo del scheduler; `340e9d4850` sin bracket sobre un start huérfano; `95ebc0ab74` `DurabilitySuspendedError` (la política de checkpoint sigue con persistencia, el resto recibe el fallo); `acac710dc2` la captura descarta solo NUL (ESC alimenta el render ANSI); `e1d76cb530` docs | |

### Fase 2 — token-meter

| `3c816548ed` | precio de imágenes por cuadrícula (ceil(w/32)·ceil(h/32), 64–16.384) | El commit 7 del plan (calibrar con `usage` real) **no se hizo**: el meter ya ancla en el `usage` del proveedor cuando supera la heurística; el hueco era el delta intra-paso con imágenes. |
| `af495d1401` | test de regresión: el ancla sobrevive a una imagen | |

Dato corregido durante la fase: la compactación **sí** dispara en producción (la serie de `usage` muestra caídas 208K→77K y 243K→93K); lo que hacía era llegar dos pasos tarde, hasta 243K sobre 262K.

### Fase 3 — slot único

| `1656d4032a` | `subagent` y `subagent_fork` en one-shot en base y presets; `maxConcurrentAgents: 1` | — |
| `616c6f9076` | la poda por presión se detiene al bajar del umbral | **No se acotó al rango sombreado**: podar la cola rompe el prefijo solo desde ese nodo y a veces evita una compactación completa. |
| `b00a220677` | `send_message`/`interrupt_agent`/`list_agents` deshabilitadas junto con one-shot | hallazgo de revisión |

### Fase 4 — herramientas

`ebf1ea8a5a` `max_output_bytes` (default 24 KB) · `a50a717bab` `glob exclude` sin `node_modules` · `14ce8bb578` `grep output_mode/context/head_limit` · `66a998f0bc` near-miss en `edit` · `f66016fc49` entrega del subagente sin reasoning y con tope · `618854c507` `edits[]` atómico en el seam `fs` · `4a5dbe3b1a` `list_dir` · `718d42cdb0` catálogo de tools. Revisión: `330c207b64` (`\` en exclude; techo `maxRequestedOutputBytes` 256 KB) y `b4f02970ad` (contexto de grep marcado `Line N-` y no contado; prefijo `N: ` solo si consecutivo en todas las líneas; escaneo acotado).

### Fase 5 — rendimiento (con medición)

- `session.append` cuesta 4–5 µs por token y **no crece** con el log (`packages/core/session/tests/bench-append.mts`).
- El seguidor del token-meter leía `session.events` en cada evento y el getter reconstruye el snapshot completo tras cada append: 70→169 µs por token creciendo con el log. `d3a283895b` añade `Session.eventAt(seq)` (O(1)) y el meter lo usa: 6–8 µs, plano (`packages/llm/token-meter/tests/bench-follow.mts`).
- `b1b8a7ce2c`: el builder del chat extiende el orden cuando el lote solo añade nodos al final, en vez de re-ordenar todo el store por evento; test de equivalencia contra un rebuild completo.
- **Sin cerrar**: la atribución completa del 34 % de CPU del proceso en kryon exige un perfil real (`node --cpu-prof` sobre el servicio); el mecanismo del meter era el único lector del snapshot completo por evento que se encontró estáticamente.

### Para el pull en kryon (cuando avises)

1. En kryon: `cd ~/NEO && git stash` (tiene cambios sin commitear en `free-scan`, `api/remotes`, `client/*` y los cuatro archivos del fix del NUL copiados a mano) → `git fetch && git checkout fix/harness-auditoria` → `pnpm install` → `pnpm vitest run packages/subprocess packages/shell` (los excluidos en Windows).
2. Motor: `--no-context-shift`, `--tensor-split 56,44`, `-ub 2048 -b 4096`, `-t 16`, `--metrics`, `--cache-reuse 256` (ver `docs/auditoria-llama-server-kryon.html`).
3. `systemctl --user restart neo-web` (mata emuladores y jobs hijos: coordinar).
4. Después: perfil de CPU del proceso para cerrar la Fase 5.

### Análisis final (cierre)

- Suite completa contra `master`: 88 fallos en la rama, 89 en `master`, **cero nuevos** (el que desaparece es un flaky).
- `tsc -b` host y client limpios; oxlint limpio en todos los paquetes tocados (los 2 avisos de `ui-conversation/src/client/service.ts` son de `master`).
- Revisión de la rama entera: todos los hallazgos de las revisiones parciales verificados como resueltos; un hallazgo alto nuevo — el marcador de contexto de `grep` no llegaba a `execute()` ni al schema de salida — corregido en `34975e012b` con test de punta a punta. Catálogo de tools regenerado (`7cda1cd89a`).
