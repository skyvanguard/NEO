/**
 * OutputCollector spill-failure reporting. Kept apart from spawn.spec.ts (which
 * needs a POSIX shell and is excluded on Windows) because the collector only
 * touches the filesystem, so these run on every platform.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OutputCollector } from '../src/spawn.ts'

const { failNextWrite } = vi.hoisted(() => {
  const next: { thrown: unknown } = { thrown: undefined }
  return { failNextWrite: next }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeSync(...args: Parameters<typeof actual.writeSync>): number {
      if (failNextWrite.thrown !== undefined) {
        const thrown = failNextWrite.thrown
        failNextWrite.thrown = undefined
        throw thrown
      }
      return actual.writeSync(...args)
    },
  }
})

let spillDir: string
let warnings: Error[]
const onWarning = (warning: Error): void => { warnings.push(warning) }

beforeEach(() => {
  spillDir = mkdtempSync(join(tmpdir(), 'neo-output-collector-'))
  warnings = []
  process.on('warning', onWarning)
})

afterEach(() => {
  process.off('warning', onWarning)
  failNextWrite.thrown = undefined
  rmSync(spillDir, { recursive: true, force: true })
})

/** process.emitWarning delivers on the next tick. */
async function flushWarnings(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

describe('OutputCollector spill failures', () => {
  it('warns exactly once, naming the stream and the cause, and keeps the in-memory tail', async () => {
    const collector = new OutputCollector(4, 100, 'stdout-once', join(spillDir, 'removed-by-a-cleaner'))
    collector.push(Buffer.from('0123456789')) // overflows: the lazy spill open fails (ENOENT)
    collector.push(Buffer.from('abcdef')) // spilling is now disabled: no second attempt, no second warning
    const out = collector.finalize()
    await flushWarnings()

    expect(out.text).toBe('cdef')
    expect(out.spillPath).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.name).toBe('SubprocessSpillWarning')
    expect(warnings[0]?.message).toMatch(/^subprocess stdout-once spill disabled: .*ENOENT/)
  })

  it('reports a non-Error failure from the filesystem layer readably', async () => {
    failNextWrite.thrown = 'disk quota exceeded'
    const collector = new OutputCollector(4, 100, 'stderr-raw', spillDir)
    expect(() => { collector.push(Buffer.from('0123456789')) }).not.toThrow()
    const out = collector.finalize()
    await flushWarnings()

    expect(out.spillPath).toBeUndefined()
    expect(warnings.map(warning => warning.message)).toEqual(['subprocess stderr-raw spill disabled: disk quota exceeded'])
  })
})
