/**
 * Usage aggregation tests (Node): the pure de-dup fold, the workspace label,
 * and a real end-to-end read of a zstd-compressed session log.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { aggregateUsage, foldSessionUsage, workspaceLabel } from '../src/aggregate.ts'
import type { UsageCache } from '../src/aggregate.ts'

const t = (iso: string): number => Date.parse(iso)

function msg(turn: number, step: number, iso: string, usage: TokenUsage): SessionEvent {
  return { type: 'assistant/message', seq: step, time: t(iso), data: { turn, step, message: {}, usage } } as unknown as SessionEvent
}
function chunk(turn: number, step: number, iso: string, usage: TokenUsage): SessionEvent {
  return { type: 'assistant/chunk', seq: step, time: t(iso), data: { turn, step, chunk: { type: 'usage', usage } } } as unknown as SessionEvent
}

describe('workspaceLabel', () => {
  it('extracts a readable name from an encoded session-root dir', () => {
    expect(workspaceLabel('--home-skyvanguard-Kryon--')).toBe('Kryon')
    expect(workspaceLabel('--home-skyvanguard-NEO--')).toBe('NEO')
  })

  it('falls back to the raw dir name when there is no segment to extract', () => {
    expect(workspaceLabel('---')).toBe('---')
  })
})

describe('foldSessionUsage', () => {
  it('sums usage and de-dups a (turn,step) reported by chunk then message', () => {
    const events = [
      chunk(0, 0, '2026-08-19T10:00:00Z', { inputTokens: 100, outputTokens: 10 }),
      msg(0, 0, '2026-08-19T10:00:05Z', { inputTokens: 100, outputTokens: 20, reasoningTokens: 15 }),
      msg(0, 1, '2026-08-19T10:01:00Z', { inputTokens: 200, outputTokens: 30, cacheReadTokens: 50 }),
    ]
    const { totals, byDay, lastActive } = foldSessionUsage(events)
    expect(totals.requests).toBe(2)
    expect(totals.inputTokens).toBe(300)
    expect(totals.outputTokens).toBe(50)
    expect(totals.reasoningTokens).toBe(15)
    expect(totals.cacheReadTokens).toBe(50)
    expect(byDay.get('2026-08-19')?.requests).toBe(2)
    expect(lastActive).toBe(t('2026-08-19T10:01:00Z'))
  })

  it('buckets usage across days', () => {
    const events = [
      msg(0, 0, '2026-08-18T23:00:00Z', { inputTokens: 10, outputTokens: 5 }),
      msg(1, 0, '2026-08-19T01:00:00Z', { inputTokens: 20, outputTokens: 8 }),
    ]
    const { byDay } = foldSessionUsage(events)
    expect(byDay.get('2026-08-18')?.inputTokens).toBe(10)
    expect(byDay.get('2026-08-19')?.inputTokens).toBe(20)
  })

  it('defaults a missing turn/step to 0 and never lowers lastActive on an out-of-order event', () => {
    const usage = { inputTokens: 2, outputTokens: 2 }
    // No turn/step on either the chunk or the message → both map to key "0:0".
    const chunkNoTS = { type: 'assistant/chunk', seq: 0, time: t('2026-08-19T10:01:00Z'), data: { chunk: { type: 'usage', usage } } } as unknown as SessionEvent
    const msgNoTS = { type: 'assistant/message', seq: 1, time: t('2026-08-19T10:02:00Z'), data: { usage } } as unknown as SessionEvent
    // A later-iterated event whose time precedes the current max must not lower lastActive.
    const earlier = msg(5, 5, '2026-08-19T09:00:00Z', { inputTokens: 3, outputTokens: 3 })
    const { totals, lastActive } = foldSessionUsage([chunkNoTS, msgNoTS, earlier])
    expect(totals.requests).toBe(2) // (0:0) de-duped to one, plus (5:5)
    expect(lastActive).toBe(t('2026-08-19T10:02:00Z'))
  })
})

describe('aggregateUsage (real zstd log)', () => {
  it('reads a compressed session log and rolls it up', async () => {
    const root = mkdtempSync(join(tmpdir(), 'usage-'))
    try {
      const sDir = join(root, '--home-x-Proj--', 'session-abc')
      mkdirSync(sDir, { recursive: true })
      const events = [
        msg(0, 0, '2026-08-19T10:00:00Z', { inputTokens: 100, outputTokens: 20, reasoningTokens: 12 }),
        msg(0, 1, '2026-08-19T10:05:00Z', { inputTokens: 300, outputTokens: 40 }),
      ]
      // One frame per event, concatenated — the multi-frame shape the persistence
      // backend appends, which Node's plain zstd decode does NOT handle on its own.
      const frames = events.map(e => zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n')))
      writeFileSync(join(sDir, 'session.jsonl.zstd'), Buffer.concat(frames))

      const summary = await aggregateUsage(root)
      expect(summary.sessionCount).toBe(1)
      expect(summary.totals.inputTokens).toBe(400)
      expect(summary.totals.outputTokens).toBe(60)
      expect(summary.totals.reasoningTokens).toBe(12)
      expect(summary.totals.requests).toBe(2)
      expect(summary.byWorkspace[0]?.workspace).toBe('Proj')
      expect(summary.sessions[0]?.sessionId).toBe('session-abc')
      expect(summary.byDay[0]?.day).toBe('2026-08-19')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns an empty summary for a missing root', async () => {
    const summary = await aggregateUsage(join(tmpdir(), 'does-not-exist-xyz'))
    expect(summary.sessionCount).toBe(0)
    expect(summary.totals.requests).toBe(0)
  })
})

describe('aggregateUsage incremental cache', () => {
  const zeros = { cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

  /** Write a session log (one zstd frame per event) and return its path. */
  function writeSession(root: string, ws: string, id: string, events: SessionEvent[]): string {
    const dir = join(root, ws, id)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'session.jsonl.zstd')
    writeFileSync(path, Buffer.concat(events.map(e => zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n')))))
    return path
  }

  it('reuses a cached fold for an unchanged log instead of re-reading it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'usage-cache-'))
    try {
      const path = writeSession(root, '--home-x-Proj--', 'session-1',
        [msg(0, 0, '2026-08-19T10:00:00Z', { inputTokens: 100, outputTokens: 20 })])
      const { mtimeMs, size } = statSync(path)
      // Seed a bogus fold whose file-identity matches the real log. If the summary
      // returns the bogus numbers, the pass reused the cache and never re-read.
      const bogus = { inputTokens: 999, outputTokens: 888, requests: 7, ...zeros }
      const cache: UsageCache = new Map()
      cache.set(path, {
        workspace: 'Proj', sessionId: 'session-1', totals: bogus,
        byDay: new Map([['2026-08-19', bogus]]), lastActive: t('2026-08-19T10:00:00Z'), mtimeMs, size,
      })
      const summary = await aggregateUsage(root, {}, cache)
      expect(summary.totals.inputTokens).toBe(999)
      expect(summary.totals.requests).toBe(7)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('re-folds a log whose bytes changed and prunes vanished sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'usage-cache-'))
    try {
      const path = writeSession(root, '--home-x-Proj--', 'session-1',
        [msg(0, 0, '2026-08-19T10:00:00Z', { inputTokens: 100, outputTokens: 20 })])
      const other = writeSession(root, '--home-x-Proj--', 'session-2',
        [msg(0, 0, '2026-08-19T11:00:00Z', { inputTokens: 5, outputTokens: 1 })])
      const cache: UsageCache = new Map()
      const first = await aggregateUsage(root, {}, cache)
      expect(first.totals.inputTokens).toBe(105)
      expect(cache.size).toBe(2)
      // Append a new (turn,step) usage frame — size changes, so the entry invalidates.
      appendFileSync(path, zstdCompressSync(Buffer.from(
        JSON.stringify(msg(0, 1, '2026-08-19T10:05:00Z', { inputTokens: 300, outputTokens: 40 })) + '\n')))
      rmSync(join(root, '--home-x-Proj--', 'session-2'), { recursive: true, force: true })
      const second = await aggregateUsage(root, {}, cache)
      expect(second.totals.inputTokens).toBe(400) // 100 + 300; session-2 pruned
      expect(cache.has(other)).toBe(false)
      expect(cache.size).toBe(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('drops an unreadable log and excludes non-directory, zero-usage, and pre-sinceMs entries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'usage-cache-'))
    try {
      // A log that is a directory: stat succeeds, the read throws → the entry is dropped.
      mkdirSync(join(root, '--home-x-Proj--', 'session-torn', 'session.jsonl.zstd'), { recursive: true })
      // A session dir with no log at all: the stat fails and the entry is skipped.
      mkdirSync(join(root, '--home-x-Proj--', 'session-nolog'), { recursive: true })
      // Stray files at the root and inside a workspace are skipped (not directories).
      writeFileSync(join(root, 'stray.txt'), 'x')
      writeFileSync(join(root, '--home-x-Proj--', 'stray.txt'), 'x')
      // Events but no usage (requests === 0): excluded from the rollup.
      writeSession(root, '--home-x-Proj--', 'session-nousage',
        [{ type: 'user/message', seq: 0, time: t('2026-08-19T09:00:00Z'), data: {} } as unknown as SessionEvent])
      // A real session, filtered out only by sinceMs.
      writeSession(root, '--home-x-Proj--', 'session-old',
        [msg(0, 0, '2026-08-19T10:00:00Z', { inputTokens: 100, outputTokens: 20 })])
      const cache: UsageCache = new Map()
      const filtered = await aggregateUsage(root, { sinceMs: t('2027-01-01T00:00:00Z') }, cache)
      expect(filtered.sessionCount).toBe(0)
      const all = await aggregateUsage(root, {}, cache)
      expect(all.sessionCount).toBe(1)
      expect(all.sessions[0]?.sessionId).toBe('session-old')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('sorts days ascending and workspaces by output tokens across multiple entries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'usage-sort-'))
    try {
      writeSession(root, '--home-x-Alpha--', 's1', [
        msg(0, 0, '2026-08-19T10:00:00Z', { inputTokens: 20, outputTokens: 50 }),
        msg(0, 1, '2026-08-17T10:00:00Z', { inputTokens: 10, outputTokens: 30 }),
      ])
      writeSession(root, '--home-x-Beta--', 's2',
        [msg(0, 0, '2026-08-18T10:00:00Z', { inputTokens: 5, outputTokens: 1 })])
      const summary = await aggregateUsage(root)
      expect(summary.byDay.map(d => d.day)).toEqual(['2026-08-17', '2026-08-18', '2026-08-19'])
      expect(summary.byWorkspace.map(w => w.workspace)).toEqual(['Alpha', 'Beta'])
      expect(summary.sessionCount).toBe(2)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
