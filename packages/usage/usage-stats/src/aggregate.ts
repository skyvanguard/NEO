/**
 * Cross-session token-usage aggregation. Reads every persisted session log
 * (`$NEO_HOME/sessions/<workspace>/<session>/session.jsonl.zstd`), folds the
 * provider-reported usage with the same per-(turn,step) de-duplication as
 * token-meter, and rolls it up into cumulative totals, per-day, per-workspace,
 * and per-session breakdowns.
 * @module
 */

import { open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decompressConcatenatedZstd, decompressFrames } from './zstd.ts'
import type { TokenUsage } from '@neo/llm'
import type { SessionEvent } from '@neo/session'
import type {
  UsageDayBucket, UsageSessionRow, UsageSummary, UsageSummaryRequest, UsageTotals, UsageWorkspaceBucket,
} from './types.ts'

/** The persisted-session log file name inside each session directory. */
const SESSION_LOG = 'session.jsonl.zstd'
/** Cap on the per-session rows returned (most recent first). */
const MAX_SESSION_ROWS = 300

type MutableTotals = { -readonly [K in keyof UsageTotals]: UsageTotals[K] }

function zero(): MutableTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 0 }
}

function addUsage(t: MutableTotals, u: TokenUsage): void {
  t.inputTokens += u.inputTokens
  t.outputTokens += u.outputTokens
  t.cacheReadTokens += u.cacheReadTokens ?? 0
  t.cacheWriteTokens += u.cacheWriteTokens ?? 0
  t.reasoningTokens += u.reasoningTokens ?? 0
  t.requests += 1
}

function addInto(map: Map<string, MutableTotals>, key: string, u: TokenUsage): void {
  let t = map.get(key)
  if (t === undefined) { t = zero(); map.set(key, t) }
  addUsage(t, u)
}

function addTotals(target: MutableTotals, src: UsageTotals): void {
  target.inputTokens += src.inputTokens
  target.outputTokens += src.outputTokens
  target.cacheReadTokens += src.cacheReadTokens
  target.cacheWriteTokens += src.cacheWriteTokens
  target.reasoningTokens += src.reasoningTokens
  target.requests += src.requests
}

/** UTC day (`YYYY-MM-DD`) of an epoch-ms time. */
function dayOf(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 10)
}

/** Human-readable workspace label from an encoded session-root subdirectory. */
export function workspaceLabel(dirName: string): string {
  const path = dirName.replace(/^-+|-+$/g, '')
  const base = path.split('-').filter(Boolean).pop()
  return base ?? dirName
}

/** The usage a chunk or finalized message reports for its (turn, step), if any. */
function usageOf(event: SessionEvent): { turn: number; step: number; usage: TokenUsage } | undefined {
  const data = event.data as { turn?: number; step?: number; usage?: TokenUsage; chunk?: { type?: string; usage?: TokenUsage } }
  if (event.type === 'assistant/chunk' && data.chunk?.type === 'usage' && data.chunk.usage !== undefined) {
    return { turn: data.turn ?? 0, step: data.step ?? 0, usage: data.chunk.usage }
  }
  if (event.type === 'assistant/message' && data.usage !== undefined) {
    return { turn: data.turn ?? 0, step: data.step ?? 0, usage: data.usage }
  }
  return undefined
}

/** Per-(turn,step) dedup state: the last usage sample seen for each step. */
type StepMap = Map<string, { usage: TokenUsage; time: number }>

/** Split decompressed session-log text into events, skipping torn lines. */
function parseEvents(text: string): SessionEvent[] {
  const events: SessionEvent[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try { events.push(JSON.parse(line) as SessionEvent) } catch { /* skip a torn/partial line */ }
  }
  return events
}

/** Read, decompress, and JSON-parse every event of one session log. */
export async function readSessionEvents(path: string): Promise<SessionEvent[]> {
  const buffer = await readFile(path)
  return parseEvents(decompressConcatenatedZstd(buffer).toString('utf8'))
}

/**
 * Read a session log starting at a byte offset (which must be a frame boundary,
 * e.g. `0` or a prior {@link readSessionTail} `foldedBytes`), decoding only the
 * bytes from there on. A session log is a concatenation of independent,
 * append-only frames, so re-reading from the last folded offset decodes only
 * what was appended since.
 * @param path - the session-log path.
 * @param fromByte - the frame-aligned offset to resume from.
 * @returns the newly decoded events and the absolute offset through which
 *   complete frames were decoded (the next resume point).
 */
async function readSessionTail(path: string, fromByte: number): Promise<{ events: SessionEvent[]; foldedBytes: number }> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    if (size <= fromByte) return { events: [], foldedBytes: fromByte }
    const buffer = Buffer.alloc(size - fromByte)
    await handle.read(buffer, 0, buffer.length, fromByte)
    const { text, consumedBytes } = decompressFrames(buffer)
    return { events: parseEvents(text.toString('utf8')), foldedBytes: fromByte + consumedBytes }
  } finally {
    await handle.close()
  }
}

/**
 * Merge new events into a copy of the step-dedup state. A (turn, step) reported
 * by both a usage chunk and its finalized message counts once — the last value
 * wins — matching token-meter's replacement rule. The input map is never
 * mutated, so a cached fold stays intact if this throws.
 * @param steps - the prior dedup state (empty for a fresh fold).
 * @param events - the events to fold in.
 * @returns a new dedup map with the events applied.
 */
function mergeEventsIntoSteps(steps: StepMap, events: readonly SessionEvent[]): StepMap {
  const next: StepMap = new Map(steps)
  for (const event of events) {
    const sample = usageOf(event)
    if (sample === undefined) continue
    next.set(`${sample.turn}:${sample.step}`, { usage: sample.usage, time: event.time })
  }
  return next
}

/** Roll de-duplicated step usage up into totals, per-day buckets, and last-active time. */
function summarizeSteps(steps: StepMap): { totals: UsageTotals; byDay: Map<string, UsageTotals>; lastActive: number } {
  const totals = zero()
  const byDay = new Map<string, MutableTotals>()
  let lastActive = 0
  for (const { usage, time } of steps.values()) {
    addUsage(totals, usage)
    addInto(byDay, dayOf(time), usage)
    if (time > lastActive) lastActive = time
  }
  return { totals, byDay, lastActive }
}

/**
 * Fold one session's events into de-duplicated usage. A (turn, step) reported
 * by both a usage chunk and its finalized message counts once — the last value
 * wins — matching token-meter's replacement rule.
 * @param events - the session's ordered events.
 * @returns the session totals, per-day contributions, and last-active time.
 */
export function foldSessionUsage(events: readonly SessionEvent[]): {
  totals: UsageTotals
  byDay: Map<string, UsageTotals>
  lastActive: number
} {
  return summarizeSteps(mergeEventsIntoSteps(new Map(), events))
}

/** One session's folded usage plus the file-identity it was folded from. */
interface CachedSessionUsage {
  readonly workspace: string
  readonly sessionId: string
  readonly totals: UsageTotals
  readonly byDay: Map<string, UsageTotals>
  readonly lastActive: number
  /** File `mtimeMs` + `size` at fold time; a change in either invalidates the entry. */
  readonly mtimeMs: number
  readonly size: number
  /**
   * Per-(turn,step) dedup state, kept so an appended (active) log folds only the
   * bytes added since the last pass rather than re-decoding the whole file —
   * the cost the usage view paid on every open for a large live session.
   * Absent on entries loaded from a persisted cache, which forces one full
   * re-fold the first time such a session grows.
   */
  readonly steps?: StepMap
  /** Absolute byte offset through which complete frames are folded into {@link steps}. */
  readonly foldedBytes?: number
}

/**
 * Per-session usage cache, keyed by absolute session-log path. Hand the same
 * instance to successive {@link aggregateUsage} calls so each request re-reads
 * and re-folds only the logs whose bytes changed (by `mtimeMs`/`size`) since the
 * last pass, reusing the folded totals for every unchanged session. A session
 * log is append-only and every write bumps `mtimeMs`, so a hit is never stale.
 */
export type UsageCache = Map<string, CachedSessionUsage>

/**
 * Aggregate cumulative usage across every session under a sessions root.
 *
 * Without a `cache`, every call re-reads, decompresses, and re-folds every
 * session log — O(total bytes) work that grows with history. Passing a
 * persistent {@link UsageCache} turns steady-state calls into O(number of
 * sessions) map reads plus a re-fold of only the sessions whose log changed:
 * the recurring cost the usage view was paying on every open.
 * @param sessionsRoot - the `$NEO_HOME/sessions` directory.
 * @param request - optional filters.
 * @param cache - optional per-session cache reused across calls; a fresh one is
 *   used when omitted (same result, no cross-call reuse).
 * @returns the cumulative summary.
 */
export async function aggregateUsage(
  sessionsRoot: string,
  request: UsageSummaryRequest = {},
  cache?: UsageCache,
): Promise<UsageSummary> {
  const store: UsageCache = cache ?? new Map()

  let workspaceDirs: Array<{ name: string; isDirectory(): boolean }>
  try {
    workspaceDirs = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return { totals: zero(), sessionCount: 0, byDay: [], byWorkspace: [], sessions: [], generatedAt: Date.now() }
  }

  // Pass 1 — refresh the cache: stat each log, re-fold only what changed.
  const seen = new Set<string>()
  for (const wd of workspaceDirs) {
    if (!wd.isDirectory()) continue
    const wsPath = join(sessionsRoot, wd.name)
    const wsLabel = workspaceLabel(wd.name)
    let sessionDirs: Array<{ name: string; isDirectory(): boolean }>
    try { sessionDirs = await readdir(wsPath, { withFileTypes: true }) } catch { continue }
    for (const sd of sessionDirs) {
      if (!sd.isDirectory()) continue
      const logPath = join(wsPath, sd.name, SESSION_LOG)
      let mtimeMs: number
      let size: number
      try { ({ mtimeMs, size } = await stat(logPath)) } catch { continue }
      seen.add(logPath)
      const hit = store.get(logPath)
      if (hit !== undefined && hit.mtimeMs === mtimeMs && hit.size === size) continue

      // Incremental path: an append-only log that only grew folds just its new
      // tail, reusing the prior step-dedup state. Any failure falls through to a
      // full re-fold below.
      if (hit?.steps !== undefined && hit.foldedBytes !== undefined && size > hit.size && hit.foldedBytes <= size) {
        try {
          const { events, foldedBytes } = await readSessionTail(logPath, hit.foldedBytes)
          const steps = mergeEventsIntoSteps(hit.steps, events)
          const { totals, byDay, lastActive } = summarizeSteps(steps)
          const { workspace, sessionId } = hit
          store.set(logPath, { workspace, sessionId, totals, byDay, lastActive, mtimeMs, size, steps, foldedBytes })
          continue
        } catch { /* fall through to a full re-fold */ }
      }

      // Full (re)fold: first sighting, a rewritten/shrunk log, or a cache entry
      // without prior step state (e.g. loaded from disk).
      try {
        const { events, foldedBytes } = await readSessionTail(logPath, 0)
        const steps = mergeEventsIntoSteps(new Map(), events)
        const { totals, byDay, lastActive } = summarizeSteps(steps)
        store.set(logPath, { workspace: wsLabel, sessionId: sd.name, totals, byDay, lastActive, mtimeMs, size, steps, foldedBytes })
      } catch { store.delete(logPath); continue }
    }
  }
  // Drop entries for sessions that vanished so the cache stays bounded to what exists.
  for (const key of store.keys()) if (!seen.has(key)) store.delete(key)

  // Pass 2 — recompose the summary from the cached per-session folds (cheap).
  const grand = zero()
  const byDay = new Map<string, MutableTotals>()
  const byWorkspace = new Map<string, MutableTotals>()
  const sessions: UsageSessionRow[] = []
  let sessionCount = 0
  for (const entry of store.values()) {
    if (entry.totals.requests === 0) continue
    if (request.sinceMs !== undefined && entry.lastActive < request.sinceMs) continue
    sessionCount += 1
    addTotals(grand, entry.totals)
    let ws = byWorkspace.get(entry.workspace)
    if (ws === undefined) { ws = zero(); byWorkspace.set(entry.workspace, ws) }
    addTotals(ws, entry.totals)
    for (const [day, dayTotals] of entry.byDay) {
      let d = byDay.get(day)
      if (d === undefined) { d = zero(); byDay.set(day, d) }
      addTotals(d, dayTotals)
    }
    sessions.push({ sessionId: entry.sessionId, workspace: entry.workspace, lastActive: entry.lastActive, totals: entry.totals })
  }

  sessions.sort((a, b) => b.lastActive - a.lastActive)
  const byDayRows: UsageDayBucket[] = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, totals]) => ({ day, totals }))
  const byWorkspaceRows: UsageWorkspaceBucket[] = [...byWorkspace.entries()]
    .sort((a, b) => b[1].outputTokens - a[1].outputTokens)
    .map(([workspace, totals]) => ({ workspace, totals }))

  return {
    totals: grand,
    sessionCount,
    byDay: byDayRows,
    byWorkspace: byWorkspaceRows,
    sessions: sessions.slice(0, MAX_SESSION_ROWS),
    generatedAt: Date.now(),
  }
}

/** On-disk shape of one cached session fold (`byDay`/`steps` Maps flattened to entries). */
interface SerializedEntry {
  readonly workspace: string
  readonly sessionId: string
  readonly totals: UsageTotals
  readonly byDay: ReadonlyArray<readonly [string, UsageTotals]>
  readonly lastActive: number
  readonly mtimeMs: number
  readonly size: number
  /** Persisted so a restart keeps the incremental tail — only present on folded entries. */
  readonly foldedBytes?: number
  readonly steps?: ReadonlyArray<readonly [string, { usage: TokenUsage; time: number }]>
}

/**
 * Current on-disk cache format version; a mismatch is treated as absent. The
 * `steps`/`foldedBytes` tail fields are an additive, optional extension, so the
 * version stays 1: an older cache (no tail) still warm-starts every frozen
 * session, and only the entries that grew re-fold.
 */
const USAGE_CACHE_VERSION = 1

/**
 * Serialize a {@link UsageCache} to JSON. The per-session `byDay` Map is
 * flattened to `[day, totals]` entries so the cache round-trips through a file.
 * @param cache - the cache to serialize.
 * @returns the JSON text.
 */
export function serializeUsageCache(cache: UsageCache): string {
  const entries: Array<readonly [string, SerializedEntry]> = [...cache.entries()].map(([path, e]) => {
    const base = {
      workspace: e.workspace, sessionId: e.sessionId, totals: e.totals,
      byDay: [...e.byDay.entries()], lastActive: e.lastActive, mtimeMs: e.mtimeMs, size: e.size,
    }
    // Persist the dedup tail only as a complete pair, so a loaded entry either
    // tails cleanly or re-folds — never from a half-written offset.
    if (e.steps === undefined || e.foldedBytes === undefined) return [path, base]
    return [path, { ...base, foldedBytes: e.foldedBytes, steps: [...e.steps.entries()] }]
  })
  return JSON.stringify({ version: USAGE_CACHE_VERSION, entries })
}

/**
 * Rebuild a {@link UsageCache} from {@link serializeUsageCache} output. A
 * missing, malformed, or version-mismatched payload yields an empty cache (the
 * next aggregate simply refolds), so a corrupt file can never crash the read.
 * @param json - the JSON text.
 * @returns the reconstructed cache (empty when the payload is unusable).
 */
export function deserializeUsageCache(json: string): UsageCache {
  const cache: UsageCache = new Map()
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch { return cache }
  if (typeof parsed !== 'object' || parsed === null) return cache
  const record = parsed as { version?: unknown; entries?: unknown }
  if (record.version !== USAGE_CACHE_VERSION || !Array.isArray(record.entries)) return cache
  for (const pair of record.entries) {
    if (!Array.isArray(pair) || pair.length !== 2) continue
    const [path, raw] = pair as [unknown, unknown]
    if (typeof path !== 'string' || typeof raw !== 'object' || raw === null) continue
    const byDay = (raw as { byDay?: unknown }).byDay
    if (!Array.isArray(byDay)) continue
    const e = raw as SerializedEntry
    const entry: CachedSessionUsage = {
      workspace: e.workspace, sessionId: e.sessionId, totals: e.totals,
      byDay: new Map(byDay), lastActive: e.lastActive, mtimeMs: e.mtimeMs, size: e.size,
    }
    // Keep the dedup tail only when fully present, so a truncated/partial entry
    // forces a clean full re-fold rather than tailing from a bogus offset.
    if (Array.isArray(e.steps) && typeof e.foldedBytes === 'number') {
      cache.set(path, { ...entry, steps: new Map(e.steps), foldedBytes: e.foldedBytes })
    } else {
      cache.set(path, entry)
    }
  }
  return cache
}

/**
 * Load a persisted usage cache from `file`. A missing file (or any read/parse
 * failure) yields an empty cache — the persisted cache is an optimization, never
 * a correctness dependency.
 * @param file - the cache file path.
 * @returns the loaded cache, or an empty one when the file is absent/unusable.
 */
export async function loadUsageCache(file: string): Promise<UsageCache> {
  let json: string
  try { json = await readFile(file, 'utf8') } catch { return new Map() }
  return deserializeUsageCache(json)
}

/**
 * Persist a usage cache to `file` atomically (write a sibling temp file, then
 * rename over the target). A write failure is swallowed: losing the cache only
 * costs the next call a cold refold, never correctness.
 * @param file - the cache file path.
 * @param cache - the cache to persist.
 */
export async function saveUsageCache(file: string, cache: UsageCache): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await writeFile(tmp, serializeUsageCache(cache), 'utf8')
    await rename(tmp, file)
  } catch {
    /* best-effort: a persistence failure must not break the summary. */
  }
}
