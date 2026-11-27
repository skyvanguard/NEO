/**
 * Usage aggregation under filesystem faults (Node): a workspace directory that
 * cannot be listed and a session log that can no longer be opened. The faults
 * are injected into `node:fs/promises` for chosen paths because neither can be
 * produced portably with real permissions (Windows ignores POSIX modes).
 */

import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aggregateUsage } from '../src/aggregate.ts'
import type { UsageCache } from '../src/aggregate.ts'
import { frameOf, msg, writeSession } from './helpers.ts'

const fsFaults = vi.hoisted(() => ({
  /** Paths whose `readdir` rejects with EACCES. */
  unlistable: new Set<string>(),
  /** Paths whose `open` rejects with EACCES. */
  unopenable: new Set<string>(),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const denied = (syscall: string, path: unknown): NodeJS.ErrnoException =>
    Object.assign(new Error(`EACCES: permission denied, ${syscall} '${String(path)}'`), { code: 'EACCES', syscall })
  return {
    ...actual,
    readdir: (async (path: unknown, ...rest: never[]) => {
      if (fsFaults.unlistable.has(String(path))) throw denied('scandir', path)
      return (actual.readdir as (path: unknown, ...args: never[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.readdir,
    open: (async (path: unknown, ...rest: never[]) => {
      if (fsFaults.unopenable.has(String(path))) throw denied('open', path)
      return (actual.open as (path: unknown, ...args: never[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.open,
  }
})

let root: string

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'usage-faults-')) })
afterEach(() => {
  fsFaults.unlistable.clear()
  fsFaults.unopenable.clear()
  rmSync(root, { recursive: true, force: true })
})

describe('aggregateUsage under filesystem faults', () => {
  it('skips a workspace directory it cannot list and still aggregates the others', async () => {
    writeSession(root, '--home-x-Alpha--', 's-alpha', [msg(0, 0, '2026-08-19T10:00:00Z', { inputTokens: 10, outputTokens: 1 })])
    writeSession(root, '--home-x-Beta--', 's-beta', [msg(0, 0, '2026-08-19T11:00:00Z', { inputTokens: 500, outputTokens: 50 })])
    // Keyed by the exact string aggregate.ts passes: join(sessionsRoot, dirName).
    fsFaults.unlistable.add(join(root, '--home-x-Beta--'))

    const summary = await aggregateUsage(root)

    expect(summary.sessionCount).toBe(1)
    expect(summary.totals.inputTokens).toBe(10)
    expect(summary.byWorkspace.map(bucket => bucket.workspace)).toEqual(['Alpha'])
  })

  it('drops a cached session whose grown log can no longer be opened', async () => {
    writeSession(root, '--home-x-Proj--', 's-healthy', [msg(0, 0, '2026-08-19T10:00:00Z', { inputTokens: 10, outputTokens: 1 })])
    const broken = writeSession(root, '--home-x-Proj--', 's-broken', [msg(0, 0, '2026-08-19T11:00:00Z', { inputTokens: 500, outputTokens: 50 })])
    const cache: UsageCache = new Map()
    expect((await aggregateUsage(root, {}, cache)).sessionCount).toBe(2)

    // The log grows (so its cached fold is stale), then every read of it fails:
    // the tail fold and the full re-fold both throw.
    appendFileSync(broken, frameOf(msg(0, 1, '2026-08-19T11:05:00Z', { inputTokens: 1, outputTokens: 1 })))
    fsFaults.unopenable.add(broken)

    const summary = await aggregateUsage(root, {}, cache)
    expect(summary.sessionCount).toBe(1)
    expect(summary.sessions.map(row => row.sessionId)).toEqual(['s-healthy'])
    expect(summary.totals.inputTokens).toBe(10)
    expect(cache.has(broken)).toBe(false)
  })
})
