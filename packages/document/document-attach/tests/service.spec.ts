/**
 * DocumentAttachService tests (Node): the Remote surface it publishes and the
 * `save` method writing real files through a mounted Cordis service.
 */

import { Buffer } from 'node:buffer'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@neo/cordis'
import { remoteMethods } from '@neo/typert-protocol'
import DocumentAttachService, { ATTACHMENTS_DIR, InvalidAttachmentError } from '../src/index.ts'

const contexts: Context[] = []
let workspace: string

beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), 'neo-attach-service-')) })
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  rmSync(workspace, { recursive: true, force: true })
})

async function mount(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DocumentAttachService)
  return ctx
}

describe('DocumentAttachService', () => {
  it('publishes save as the one direct Remote method under the documentAttach namespace', async () => {
    const ctx = await mount()

    expect(ctx.documentAttach.typertRemote).toMatchObject({
      serviceKey: 'documentAttach',
      namespace: 'documentAttach',
    })
    expect(remoteMethods(ctx.documentAttach)).toEqual([
      { method: 'save', invocation: { kind: 'direct' } },
    ])
  })

  it('saves the decoded bytes under the workspace attachments dir with a sanitized name', async () => {
    const ctx = await mount()
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0a])

    const result = await ctx.documentAttach.save({
      fileName: '../outside/q3 report.pdf',
      dataBase64: bytes.toString('base64'),
      workspaceRoot: workspace,
    })

    const expectedPath = join(workspace, ATTACHMENTS_DIR, 'q3_report.pdf')
    expect(result).toEqual({
      relativePath: `${ATTACHMENTS_DIR}/q3_report.pdf`,
      absolutePath: expectedPath,
      bytes: bytes.length,
    })
    expect(readFileSync(expectedPath)).toEqual(bytes)
  })

  it('rejects a save without an open workspace and writes nothing', async () => {
    const ctx = await mount()

    await expect(ctx.documentAttach.save({
      fileName: 'a.txt',
      dataBase64: Buffer.from('x').toString('base64'),
      workspaceRoot: '   ',
    })).rejects.toThrow(InvalidAttachmentError)
    expect(existsSync(join(workspace, ATTACHMENTS_DIR))).toBe(false)
  })
})
