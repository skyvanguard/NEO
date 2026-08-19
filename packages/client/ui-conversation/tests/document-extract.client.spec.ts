/**
 * Unit tests for the pure helpers of client-side document extraction: file
 * classification, extension parsing, OOXML text-run extraction, and the text
 * truncation guard. The library-backed extractors (PDF/DOCX/XLSX) are exercised
 * through the composer integration, not here.
 */

import { describe, expect, it } from 'vitest'
import {
  documentKind,
  fileExtension,
  MAX_DOCUMENT_TEXT_CHARS,
  truncateText,
  UnsupportedDocumentTypeError,
  xmlTextRuns,
} from '../src/client/document-extract.ts'

/** Build a browser File with a name and MIME type (content is irrelevant to classification). */
function fakeFile(name: string, type = ''): File {
  return new File([new Uint8Array(0)], name, { type })
}

describe('fileExtension', () => {
  it('returns the lower-cased extension', () => {
    expect(fileExtension('Report.PDF')).toBe('pdf')
    expect(fileExtension('scan-results.JSON')).toBe('json')
  })

  it('treats a leading-dot dotfile as its own extension', () => {
    expect(fileExtension('.env')).toBe('env')
  })

  it('returns empty string when there is no extension', () => {
    expect(fileExtension('Dockerfile')).toBe('')
    expect(fileExtension('Makefile')).toBe('')
  })

  it('uses the final segment and ignores directory separators', () => {
    expect(fileExtension('loot/creds.txt')).toBe('txt')
  })
})

describe('documentKind', () => {
  it('classifies office documents by extension', () => {
    expect(documentKind(fakeFile('a.pdf'))).toBe('pdf')
    expect(documentKind(fakeFile('a.docx'))).toBe('docx')
    expect(documentKind(fakeFile('a.xlsx'))).toBe('xlsx')
    expect(documentKind(fakeFile('a.xlsm'))).toBe('xlsx')
    expect(documentKind(fakeFile('a.pptx'))).toBe('pptx')
  })

  it('classifies text and source files by extension', () => {
    expect(documentKind(fakeFile('notes.md'))).toBe('text')
    expect(documentKind(fakeFile('scan.log'))).toBe('text')
    expect(documentKind(fakeFile('exploit.py'))).toBe('text')
    expect(documentKind(fakeFile('config.yaml'))).toBe('text')
  })

  it('falls back to a text MIME when the extension is unknown', () => {
    expect(documentKind(fakeFile('payload', 'text/plain'))).toBe('text')
    expect(documentKind(fakeFile('report', 'application/pdf'))).toBe('pdf')
  })

  it('classifies conventional extensionless files as text', () => {
    expect(documentKind(fakeFile('Dockerfile'))).toBe('text')
    expect(documentKind(fakeFile('Makefile'))).toBe('text')
  })

  it('returns null for unsupported binaries', () => {
    expect(documentKind(fakeFile('capture.pcap', 'application/vnd.tcpdump.pcap'))).toBeNull()
    expect(documentKind(fakeFile('malware.bin', 'application/octet-stream'))).toBeNull()
  })
})

describe('truncateText', () => {
  it('leaves short text unchanged', () => {
    const text = 'short document body'
    expect(truncateText(text)).toEqual({ text, truncated: false })
  })

  it('clamps oversize text and flags truncation', () => {
    const oversize = 'x'.repeat(MAX_DOCUMENT_TEXT_CHARS + 500)
    const result = truncateText(oversize)
    expect(result.truncated).toBe(true)
    expect(result.text).toHaveLength(MAX_DOCUMENT_TEXT_CHARS)
  })
})

describe('xmlTextRuns', () => {
  it('extracts and joins text runs for a given tag', () => {
    const xml = '<a:p><a:r><a:t>Hello</a:t></a:r><a:r><a:t>world</a:t></a:r></a:p>'
    expect(xmlTextRuns(xml, 'a:t')).toBe('Hello world')
  })

  it('decodes named and numeric XML entities', () => {
    const xml = '<w:t>Tom &amp; Jerry</w:t><w:t>&#65;&#x42;</w:t>'
    expect(xmlTextRuns(xml, 'w:t')).toBe('Tom & Jerry AB')
  })

  it('handles run tags that carry attributes', () => {
    const xml = '<w:t xml:space="preserve">spaced </w:t><w:t>text</w:t>'
    expect(xmlTextRuns(xml, 'w:t')).toBe('spaced  text')
  })

  it('returns empty string when no runs are present', () => {
    expect(xmlTextRuns('<a:p></a:p>', 'a:t')).toBe('')
  })
})

describe('UnsupportedDocumentTypeError', () => {
  it('carries the file type and name', () => {
    const error = new UnsupportedDocumentTypeError('application/octet-stream', 'x.bin')
    expect(error).toBeInstanceOf(Error)
    expect(error.fileType).toBe('application/octet-stream')
    expect(error.fileName).toBe('x.bin')
  })
})
