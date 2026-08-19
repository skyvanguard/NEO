/**
 * Host-side extraction tests. Unlike the browser client, these run in Node, so
 * they exercise the real parsers end-to-end: synthesize an XLSX workbook and a
 * minimal PPTX zip, then extract them through the same path the Remote uses.
 */

import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import * as XLSX from 'xlsx'
import {
  documentKind, extractDocumentBytes, fileExtension, truncateText, UnsupportedDocumentTypeError, xmlTextRuns,
} from '../src/extract.ts'

const toB64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

describe('classification helpers', () => {
  it('classifies by extension and MIME-free name', () => {
    expect(documentKind('a.pdf')).toBe('pdf')
    expect(documentKind('a.docx')).toBe('docx')
    expect(documentKind('a.xlsx')).toBe('xlsx')
    expect(documentKind('a.pptx')).toBe('pptx')
    expect(documentKind('scan.log')).toBe('text')
    expect(documentKind('Dockerfile')).toBe('text')
    expect(documentKind('malware.bin')).toBeNull()
  })

  it('parses extensions and dotfiles', () => {
    expect(fileExtension('Report.PDF')).toBe('pdf')
    expect(fileExtension('.env')).toBe('env')
    expect(fileExtension('Makefile')).toBe('')
  })

  it('extracts OOXML runs with entity decoding', () => {
    expect(xmlTextRuns('<a:t>Hello</a:t><a:t>world</a:t>', 'a:t')).toBe('Hello world')
    expect(xmlTextRuns('<w:t>Tom &amp; Jerry</w:t>', 'w:t')).toBe('Tom & Jerry')
  })

  it('truncates oversize text', () => {
    expect(truncateText('x'.repeat(200_000)).truncated).toBe(true)
  })
})

describe('extractDocumentBytes (real parsers, Node)', () => {
  it('reads plain text verbatim', async () => {
    const result = await extractDocumentBytes('notes.md', toB64(strToU8('# Title\nbody line')))
    expect(result.kind).toBe('text')
    expect(result.text).toContain('# Title')
    expect(result.text).toContain('body line')
  })

  it('extracts an XLSX workbook to CSV via SheetJS', async () => {
    const ws = XLSX.utils.aoa_to_sheet([['host', 'port'], ['10.0.0.1', 22], ['10.0.0.2', 443]])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Targets')
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array
    const result = await extractDocumentBytes('scan.xlsx', toB64(bytes))
    expect(result.kind).toBe('xlsx')
    expect(result.text).toContain('Targets')
    expect(result.text).toContain('10.0.0.1')
    expect(result.text).toContain('443')
  })

  it('extracts PPTX slide text via fflate + OOXML runs', async () => {
    const slide = '<p:sld><a:t>Recon</a:t><a:t>findings</a:t></p:sld>'
    const zip = zipSync({ 'ppt/slides/slide1.xml': strToU8(slide) })
    const result = await extractDocumentBytes('deck.pptx', toB64(zip))
    expect(result.kind).toBe('pptx')
    expect(result.text).toContain('Recon findings')
  })

  it('rejects an unsupported binary', async () => {
    await expect(extractDocumentBytes('x.bin', toB64(strToU8('binary')))).rejects.toThrow(UnsupportedDocumentTypeError)
  })
})
