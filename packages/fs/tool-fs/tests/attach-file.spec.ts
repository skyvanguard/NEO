/**
 * The `attach_file` tool over the REAL local filesystem and attachment store:
 * extension→media-type mapping, durable content-addressed commit, file-block
 * rendering (the download-card carrier), and the empty-path guard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@neo/cordis'
import { CodeRuntime } from '@neo/code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@neo/code-runtime'
import { CallId } from '@neo/llm'
import type { ContentBlock, FileBlock } from '@neo/llm'
import SystemPrompt from '@neo/system-prompt'
import ToolRuntime, { RUN_CODE_NAME } from '@neo/tools'
import type { Config as ToolConfig } from '@neo/tools'
import LocalFileSystem from '@neo/fs-local'
import * as FsPolicy from '@neo/fs-observation-policy'
import LocalAttachmentStore from '@neo/attachment-local'
import { AttachmentId, AttachmentStore } from '@neo/attachment'
import type { FileAttachmentRef, ImageAttachmentLimits, SaveFileAttachment } from '@neo/attachment'
import * as ToolFs from '@neo/tool-fs'
import { applyAttachFileTool, expandHomePath, fileMediaTypeForPath } from '../src/attach-file.ts'

const testToolSignal = new AbortController().signal

/** In-process Code Mode seam fake that invokes the real registry bindings. */
class FakeRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fake'
  behavior: (request: CodeRunRequest) => Promise<CodeRunResult> = () => Promise.resolve({ logs: [] })

  run(request: CodeRunRequest): Promise<CodeRunResult> {
    return this.behavior(request)
  }
}

let dir: string
let home: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-attach-file-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-attach-file-home-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

async function setup(options: { attachments?: boolean; maxFileBytes?: number; toolMode?: ToolConfig['mode'] } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: options.toolMode ?? 'native' })
  if (options.toolMode === 'code') await ctx.plugin(FakeRuntime)
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
function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`attach-call-${++callCounter}`),
    name,
    arguments: args,
  })
}
function attachFile(ctx: Context, args: unknown) {
  return call(ctx, 'attach_file', args)
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

  it('names a missing containing directory instead of listing siblings', async () => {
    const ctx = await setup()
    const result = await attachFile(ctx, { file_path: 'nope/report.md' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/not found.*the containing directory ".*nope" does not exist/s)
  })

  it('caps the sibling list and counts the files it leaves out', async () => {
    const names = Array.from({ length: 14 }, (_, index) => `part-${String(index).padStart(2, '0')}.csv`)
    for (const name of names) await writeFile(join(dir, name), 'x')
    const ctx = await setup()
    const out = text(await attachFile(ctx, { file_path: 'part-99.csv' }))
    expect(out).toContain('contains:')
    expect(out).toContain(', … (+2 more)')
    expect(out.slice(out.indexOf('contains:')).match(/part-\d\d\.csv/g)).toHaveLength(12)
  })

  it('keeps the plain not-found error when listing the directory fails', async () => {
    await writeFile(join(dir, 'notes.txt'), 'x')
    const ctx = await setup()
    vi.spyOn(ctx.fs, 'listDir').mockRejectedValue(new Error('EIO: directory listing failed'))
    const result = await attachFile(ctx, { file_path: 'absent.md' })
    expect(result.isError).toBe(true)
    const out = text(result)
    expect(out).toContain('not found')
    expect(out).not.toContain('notes.txt')
    expect(out).not.toContain('EIO')
  })

  it('defensively refuses execution without an attachment service', async () => {
    await writeFile(join(dir, 'INFORME.md'), '# x')
    const ctx = await setup({ attachments: false })
    applyAttachFileTool(ctx)
    const result = await attachFile(ctx, { file_path: 'INFORME.md' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('cannot attach "INFORME.md": no attachment service is mounted')
  })

  it('falls back to the file base name when the store returns a reference without one', async () => {
    /** File store echoing a nameless reference; deployments may strip names entirely. */
    class NamelessStore extends AttachmentStore {
      readonly imageLimits: ImageAttachmentLimits = Object.freeze({
        maxImageBytes: 0,
        maxImagesPerMessage: 0,
        maxMessageImageBytes: 0,
        maxImagePixels: 0,
        mediaTypes: Object.freeze([] as const),
      })

      readonly fileLimits = Object.freeze({ maxFileBytes: 1024 })
      validateImage(): Promise<never> { return Promise.reject(new Error('unused')) }
      saveImage(): Promise<never> { return Promise.reject(new Error('unused')) }
      readImage(): Promise<never> { return Promise.reject(new Error('unused')) }
      readFile(): Promise<never> { return Promise.reject(new Error('unused')) }

      async saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
        if (input.mediaType === undefined) throw new Error('attach_file must declare a media type')
        return { attachmentId: AttachmentId('sha256:feed'), mediaType: input.mediaType, bytes: input.data.length }
      }
    }
    await writeFile(join(dir, 'export.csv'), 'a,b\n')
    const ctx = await setup({ attachments: false })
    await ctx.plugin(NamelessStore)
    const result = await attachFile(ctx, { file_path: 'export.csv', name: 'Exportacion.csv' })
    expect(result.isError).toBe(false)
    expect(fileBlockOf(result)?.attachment).toEqual({ attachmentId: 'sha256:feed', mediaType: 'text/csv', bytes: 4 })
    expect(text(result)).toContain('Published export.csv (text/csv, 4 bytes)')
  })

  it('forwards a nested Code Mode attach through the outer run_code context', async () => {
    await writeFile(join(dir, 'INFORME.md'), '# Informe\n')
    const ctx = await setup({ toolMode: 'code' })
    const runtime = ctx.codeRuntime as FakeRuntime
    runtime.behavior = async (request) => {
      const value = await request.bindings[0]!.functions.attach_file!({ file_path: 'INFORME.md' })
      return { logs: [], value }
    }

    const result = await call(ctx, RUN_CODE_NAME, {
      code: 'return await tools.attach_file({ file_path: "INFORME.md" })',
      description: 'Attach the report through Code Mode',
    })

    expect(result.isError).toBe(false)
    expect(result.content.every(block => block.type === 'text')).toBe(true)
    expect(result.additionalContexts).toHaveLength(1)
    const forwarded = result.additionalContexts?.[0]?.content
    expect(forwarded).toHaveLength(2)
    expect(forwarded?.[0]?.type === 'text' ? forwarded[0].text : '').toContain('Published INFORME.md (text/markdown, 10 bytes)')
    expect(forwarded?.[1]).toMatchObject({
      type: 'file',
      attachment: { mediaType: 'text/markdown', bytes: 10, name: 'INFORME.md' },
    })
  })

  it('declares attach_file parallel-safe and presents a read-family card', async () => {
    const ctx = await setup()
    expect(ctx.tools.executionMode({
      signal: testToolSignal, callId: CallId('attach-parallel'), name: 'attach_file', arguments: { file_path: 'a.md' },
    })).toEqual({ kind: 'parallel' })
    expect(ctx.tools.get('attach_file')?.presentCall?.({ file_path: 'out/informe.md' })).toEqual({
      card: 'generic',
      title: 'Attach out/informe.md',
      kind: 'read',
      locations: [{ path: 'out/informe.md' }],
    })
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
