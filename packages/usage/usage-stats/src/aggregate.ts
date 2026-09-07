/**
 * Cross-session token-usage aggregation. Reads every persisted session log
 * (`$DSH_HOME/sessions/<workspace>/<session>/session.jsonl.zstd`), folds the
 * provider-reported usage with the same per-(turn,step) de-duplication as
 * token-meter, and rolls it up into cumulative totals, per-day, per-workspace,
 * and per-session breakdowns.
 * @module
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { decompressConcatenatedZstd } from './zstd.ts'
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

/** Read, decompress, and JSON-parse every event of one session log. */
export async function readSessionEvents(path: string): Promise<SessionEvent[]> {
  const buffer = await readFile(path)
  const text = decompressConcatenatedZstd(buffer).toString('utf8')
  const events: SessionEvent[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try { events.push(JSON.parse(line) as SessionEvent) } catch { /* skip a torn/partial line */ }
  }
  return events
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
  const perStep = new Map<string, { usage: TokenUsage; time: number }>()
  for (const event of events) {
    const sample = usageOf(event)
    if (sample === undefined) continue
    perStep.set(`${sample.turn}:${sample.step}`, { usage: sample.usage, time: event.time })
  }
  const totals = zero()
  const byDay = new Map<string, MutableTotals>()
  let lastActive = 0
  for (const { usage, time } of perStep.values()) {
    addUsage(totals, usage)
    addInto(byDay, dayOf(time), usage)
    if (time > lastActive) lastActive = time
  }
  return { totals, byDay, lastActive }
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
 * @param sessionsRoot - the `$DSH_HOME/sessions` directory.
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
      let events: SessionEvent[]
      try { events = await readSessionEvents(logPath) } catch { store.delete(logPath); continue }
      const { totals, byDay, lastActive } = foldSessionUsage(events)
      store.set(logPath, { workspace: wsLabel, sessionId: sd.name, totals, byDay, lastActive, mtimeMs, size })
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
