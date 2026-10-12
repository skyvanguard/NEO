/**
 * Host-side save tests (Node): write real files into a temp workspace and check
 * the paths, sanitization, and guard rails.
 */

import { Buffer } from 'node:buffer'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATTACHMENTS_DIR, InvalidAttachmentError, safeBaseName, saveAttachment } from '../src/save.ts'

let workspace: string
beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), 'neo-attach-')) })
afterEach(() => { rmSync(workspace, { recursive: true, force: true }) })

const b64 = (text: string): string => Buffer.from(text).toString('base64')

describe('safeBaseName', () => {
  it('keeps a normal name and its extension', () => {
    expect(safeBaseName('report.pdf')).toBe('report.pdf')
    expect(safeBaseName('scan-results_v2.xlsx')).toBe('scan-results_v2.xlsx')
  })

  it('strips directory parts and traversal', () => {
    expect(safeBaseName('../../etc/passwd')).toBe('passwd')
    expect(safeBaseName('/abs/loot.txt')).toBe('loot.txt')
    expect(safeBaseName('a\\b\\c.docx')).toBe('c.docx')
  })

  it('drops leading dots and replaces unsafe characters', () => {
    expect(safeBaseName('...hidden')).toBe('hidden')
    expect(safeBaseName('weird name!@#.pdf')).toBe('weird_name___.pdf')
  })

  it('never returns empty', () => {
    expect(safeBaseName('')).toBe('attachment')
    expect(safeBaseName('///')).toBe('attachment')
  })
})

describe('saveAttachment', () => {
  it('writes the bytes into the workspace attachments dir and reports paths', async () => {
    const result = await saveAttachment(workspace, 'report.pdf', b64('%PDF-1.4 fake'))
    expect(result.relativePath).toBe(`${ATTACHMENTS_DIR}/report.pdf`)
    expect(result.bytes).toBe(Buffer.from('%PDF-1.4 fake').length)
    expect(readFileSync(join(workspace, result.relativePath), 'utf8')).toBe('%PDF-1.4 fake')
  })

  it('sanitizes a traversal file name into the attachments dir', async () => {
    const result = await saveAttachment(workspace, '../../escape.txt', b64('x'))
    expect(result.relativePath).toBe(`${ATTACHMENTS_DIR}/escape.txt`)
    expect(readFileSync(join(workspace, ATTACHMENTS_DIR, 'escape.txt'), 'utf8')).toBe('x')
  })

  it('rejects a missing workspace', async () => {
    await expect(saveAttachment('', 'a.txt', b64('x'))).rejects.toThrow(InvalidAttachmentError)
  })

  it('rejects an empty attachment', async () => {
    await expect(saveAttachment(workspace, 'a.txt', '')).rejects.toThrow(InvalidAttachmentError)
  })
})
