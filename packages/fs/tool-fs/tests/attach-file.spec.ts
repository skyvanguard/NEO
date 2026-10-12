/**
 * The `attach_file` tool over the REAL local filesystem and attachment store:
 * extension→media-type mapping, durable content-addressed commit, file-block
 * rendering (the download-card carrier), and the empty-path guard.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@neo/cordis'
import { CallId } from '@neo/llm'
import type { ContentBlock, FileBlock } from '@neo/llm'
import SystemPrompt from '@neo/system-prompt'
import ToolRuntime from '@neo/tools'
import LocalFileSystem from '@neo/fs-local'
import * as FsPolicy from '@neo/fs-observation-policy'
import LocalAttachmentStore from '@neo/attachment-local'
import * as ToolFs from '@neo/tool-fs'
import { expandHomePath, fileMediaTypeForPath } from '../src/attach-file.ts'

const testToolSignal = new AbortController().signal

let dir: string
let home: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-attach-file-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-attach-file-home-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

async function setup(options: { attachments?: boolean; maxFileBytes?: number } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(FsPolicy)
  if (options.attachments !== false) {
    await ctx.plugin(LocalAttachmentStore, {
      neoHome: home,
      ...options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes },
    })
  }
  await ctx.plugin(ToolFs)
  return ctx
}

let callCounter = 0
function attachFile(ctx: Context, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`attach-call-${++callCounter}`),
    name: 'attach_file',
    arguments: args,
  })
}

function fileBlockOf(result: { content: ContentBlock[] }): FileBlock | undefined {
  return result.content.find((b): b is FileBlock => b.type === 'file')
}
function text(result: { content: ContentBlock[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
}

describe('fileMediaTypeForPath', () => {
  it('maps known extensions case-insensitively and defaults to octet-stream', () => {
    expect(fileMediaTypeForPath('informe.md')).toBe('text/markdown')
    expect(fileMediaTypeForPath('a.PDF')).toBe('application/pdf')
    expect(fileMediaTypeForPath('data.csv')).toBe('text/csv')
    expect(fileMediaTypeForPath('archive.zip')).toBe('application/zip')
    expect(fileMediaTypeForPath('unknown.xyz')).toBe('application/octet-stream')
    expect(fileMediaTypeForPath('noext')).toBe('application/octet-stream')
  })
})

describe('attach_file', () => {
  it('publishes a file as a durable download-card block and round-trips its bytes', async () => {
    const body = '# Informe\n\nContenido de gerencia.\n'
    await writeFile(join(dir, 'INFORME.md'), body)
    const ctx = await setup()

    const result = await attachFile(ctx, { file_path: 'INFORME.md' })
    expect(result.isError).toBeFalsy()

    const block = fileBlockOf(result)
    expect(block).toBeDefined()
    expect(block?.attachment.mediaType).toBe('text/markdown')
    expect(block?.attachment.name).toBe('INFORME.md')
    expect(block?.attachment.bytes).toBe(Buffer.byteLength(body))
    expect(String(block?.attachment.attachmentId)).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(text(result)).toContain('downloadable attachment')

    // The reference must resolve to the exact bytes through the store.
    const stored = await ctx.attachments.readFile(block!.attachment)
    expect(Buffer.from(stored.data).toString('utf8')).toBe(body)
  })

  it('honors an explicit display name', async () => {
    await writeFile(join(dir, 'report.bin'), Uint8Array.of(1, 2, 3, 4))
    const ctx = await setup()
    const result = await attachFile(ctx, { file_path: 'report.bin', name: 'Reporte Final.bin' })
    const block = fileBlockOf(result)
    expect(block?.attachment.name).toBe('Reporte Final.bin')
    expect(block?.attachment.mediaType).toBe('application/octet-stream')
  })

  it('rejects an empty path', async () => {
    const ctx = await setup()
    const result = await attachFile(ctx, { file_path: '   ' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('file_path')
  })

  it('is not registered when no attachment service is mounted', async () => {
    const ctx = await setup({ attachments: false })
    // The tool is gated behind ctx.inject(['attachments']): with no store it
    // never registers, so the download capability is absent by construction.
    expect(ctx.tools.get('attach_file')).toBeUndefined()
  })

  it('fails with a bounded read before the file exceeds maxFileBytes', async () => {
    await writeFile(join(dir, 'big.bin'), Uint8Array.from({ length: 64 }, () => 7))
    const ctx = await setup({ maxFileBytes: 16 })
    const result = await attachFile(ctx, { file_path: 'big.bin' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('exceeds')
  })

  it('reports a missing file and a directory target through the fs vocabulary', async () => {
    await mkdir(join(dir, 'folder'))
    const ctx = await setup()
    const missing = await attachFile(ctx, { file_path: 'absent.md' })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('not found')
    const directory = await attachFile(ctx, { file_path: 'folder' })
    expect(directory.isError).toBe(true)
    expect(text(directory)).toContain('not a regular file')
  })

  it('lists sibling files on a not-found so a mistyped name can be corrected', async () => {
    // The deliverable exists, but the model guessed a transposed name — the
    // error must surface the real name instead of dead-ending.
    await writeFile(join(dir, 'DELIVERABLE_Q3.zip'), Uint8Array.from({ length: 8 }, () => 1))
    await writeFile(join(dir, 'notes.txt'), 'x')
    const ctx = await setup()
    const result = await attachFile(ctx, { file_path: 'Q3_DELIVERABLE.zip' })
    expect(result.isError).toBe(true)
    const out = text(result)
    expect(out).toContain('not found')
    expect(out).toContain('contains:')
    expect(out).toContain('DELIVERABLE_Q3.zip') // the real file the model can now name
  })
})

describe('expandHomePath', () => {
  it('expands a leading ~ to the home directory and passes other paths through', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/reports/x.zip')).toBe(join(homedir(), 'reports/x.zip'))
    expect(expandHomePath('/home/alice/reports/x.zip')).toBe('/home/alice/reports/x.zip')
    expect(expandHomePath('.neo-attachments/x.zip')).toBe('.neo-attachments/x.zip')
    expect(expandHomePath('report.md')).toBe('report.md')
    // A ~ that is not a home prefix (e.g. embedded) is left untouched.
    expect(expandHomePath('dir/~backup')).toBe('dir/~backup')
  })
})
