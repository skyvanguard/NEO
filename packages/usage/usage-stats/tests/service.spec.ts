/**
 * UsageStatsService tests (Node): the Remote surface it publishes, and
 * `summary` folding the session logs under a temp `$NEO_HOME` while loading and
 * persisting the per-session fold cache beside them.
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@neo/cordis'
import type { SessionEvent } from '@neo/session'
import { remoteMethods } from '@neo/typert-protocol'
import UsageStatsService from '../src/index.ts'
import { loadUsageCache, saveUsageCache } from '../src/aggregate.ts'
import type { UsageCache } from '../src/aggregate.ts'
import { msg, writeSession } from './helpers.ts'

const WORKSPACE_DIR = '--home-x-Proj--'
const contexts: Context[] = []
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'neo-usage-home-'))
  vi.stubEnv('NEO_HOME', home)
})
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

async function mount(): Promise<UsageStatsService> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(UsageStatsService)
  // The service registers under its Remote namespace key, `usage`.
  return ctx.get('usage') as UsageStatsService
}

/** Write one session log under `$NEO_HOME/sessions` and return its path. */
function writeHomeSession(id: string, events: readonly SessionEvent[]): string {
  return writeSession(join(home, 'sessions'), WORKSPACE_DIR, id, events)
}

/** A cache holding one fabricated fold whose file identity matches the real log at `path`. */
function fabricatedCache(path: string, sessionId: string): UsageCache {
  const { mtimeMs, size } = statSync(path)
  const totals = { inputTokens: 999, outputTokens: 888, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 7 }
  return new Map([[path, {
    workspace: 'Proj', sessionId, totals, byDay: new Map([['2026-08-19', totals]]),
    lastActive: Date.parse('2026-08-19T10:00:00Z'), mtimeMs, size,
  }]])
}

const cacheFile = (): string => join(home, '.usage-cache.json')

describe('UsageStatsService', () => {
  it('publishes summary as the one direct Remote method under the usage namespace', async () => {
    const service = await mount()

    expect(service.typertRemote).toMatchObject({ serviceKey: 'usage', namespace: 'usage' })
    expect(remoteMethods(service)).toEqual([
      { method: 'summary', invocation: { kind: 'direct' } },
    ])
  })

  it('summarizes every session under $NEO_HOME/sessions and persists the fold cache in $NEO_HOME', async () => {
    const path = writeHomeSession('session-1', [
      msg(0, 0, '2026-08-19T10:00:00Z', { inputTokens: 100, outputTokens: 20 }),
      msg(0, 1, '2026-08-19T10:05:00Z', { inputTokens: 300, outputTokens: 40 }),
    ])
    const service = await mount()

    const summary = await service.summary({})

    expect(summary.sessionCount).toBe(1)
    expect(summary.totals).toMatchObject({ inputTokens: 400, outputTokens: 60, requests: 2 })
    expect(summary.sessions.map(row => row.sessionId)).toEqual(['session-1'])
    const persisted = await loadUsageCache(cacheFile())
    expect([...persisted.keys()]).toEqual([path])
    expect(persisted.get(path)?.totals.inputTokens).toBe(400)
  })

  it('applies the request filter to the summary', async () => {
    writeHomeSession('session-1', [msg(0, 0, '2026-08-19T10:00:00Z', { inputTokens: 100, outputTokens: 20 })])
    const service = await mount()

    const summary = await service.summary({ sinceMs: Date.parse('2026-08-20T00:00:00Z') })

    expect(summary.sessionCount).toBe(0)
    expect(summary.totals.requests).toBe(0)
  })

  it('warm-starts from the persisted cache instead of re-reading an unchanged log', async () => {
    const path = writeHomeSession('session-1', [msg(0, 0, '2026-08-19T10:00:00Z', { inputTokens: 100, outputTokens: 20 })])
    await saveUsageCache(cacheFile(), fabricatedCache(path, 'session-1'))
    const service = await mount()

    const summary = await service.summary({})

    // The fabricated numbers can only come from the persisted cache.
    expect(summary.totals).toMatchObject({ inputTokens: 999, outputTokens: 888, requests: 7 })
  })

  it('reads the persisted cache only on its first summary', async () => {
    writeHomeSession('session-1', [msg(0, 0, '2026-08-19T10:00:00Z', { inputTokens: 100, outputTokens: 20 })])
    const service = await mount()
    expect((await service.summary({})).totals.inputTokens).toBe(100)

    // A new session appears, and the cache file now claims a fabricated fold for it.
    const second = writeHomeSession('session-2', [msg(0, 0, '2026-08-19T11:00:00Z', { inputTokens: 5, outputTokens: 1 })])
    await saveUsageCache(cacheFile(), fabricatedCache(second, 'session-2'))

    const summary = await service.summary({})
    // session-2 is folded from its log, not taken from the rewritten file.
    expect(summary.totals.inputTokens).toBe(105)
    expect(summary.totals.requests).toBe(2)
  })
})
