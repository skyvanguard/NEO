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
