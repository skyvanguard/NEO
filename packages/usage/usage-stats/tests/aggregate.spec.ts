/**
 * Usage aggregation tests (Node): the pure de-dup fold, the workspace label,
 * and a real end-to-end read of a zstd-compressed session log.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { aggregateUsage, foldSessionUsage, workspaceLabel } from '../src/aggregate.ts'

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
