/**
 * Host-side (Node) document extraction engine. Turns an uploaded document's
 * bytes into plain text the text+image model can read. Runs in Node, where the
 * parsers (`pdfjs-dist`, `mammoth`, `xlsx`) work natively — unlike the browser
 * client plugin, which cannot bundle these Node-oriented libraries.
 * @module
 */

import { Buffer } from 'node:buffer'
import type { DocumentExtractResult } from './types.ts'

/** Upper bound on extracted text per document, in characters (~30k tokens). */
export const MAX_DOCUMENT_TEXT_CHARS = 120_000

/** Document families this engine can extract. */
export type DocumentKind = 'text' | 'pdf' | 'docx' | 'xlsx' | 'pptx'

/** Extensions read verbatim as UTF-8 text. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'rst', 'adoc', 'org',
  'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'xml', 'html', 'htm', 'svg', 'css', 'scss', 'less',
  'log', 'diff', 'patch', 'sql',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'php', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cc',
  'cs', 'java', 'kt', 'kts', 'swift', 'scala', 'lua', 'pl', 'pm', 'r', 'jl', 'dart', 'ex', 'exs', 'clj',
  'tf', 'hcl', 'dockerfile', 'makefile', 'gradle', 'proto', 'graphql', 'gql',
])

/** Office extensions mapped to their extractor kind. */
const OFFICE_EXTENSIONS: Record<string, DocumentKind> = {
  pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', xlsm: 'xlsx', pptx: 'pptx',
}

/** Thrown when a file is not a document this engine can extract. */
export class UnsupportedDocumentTypeError extends Error {
  constructor(readonly fileName: string) {
    super(`unsupported document type: ${fileName || 'unknown'}`)
    this.name = 'UnsupportedDocumentTypeError'
  }
}

/**
 * Lower-cased extension of a file name, without the dot. A leading-dot dotfile
 * (`.env`) is treated as its own extension.
 * @param name - the file name.
 * @returns the extension, or `''`.
 */
export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  if (base.startsWith('.') && !base.slice(1).includes('.')) return base.slice(1).toLowerCase()
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/**
 * Classify a file name into a document kind, or `null` when unsupported.
 * @param fileName - the file name.
 * @returns the document kind, or `null`.
 */
export function documentKind(fileName: string): DocumentKind | null {
  const ext = fileExtension(fileName)
  const office = OFFICE_EXTENSIONS[ext]
  if (office !== undefined) return office
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  const base = (fileName.split(/[\\/]/).pop() ?? fileName).toLowerCase()
  if (base === 'dockerfile' || base === 'makefile') return 'text'
  return null
}

/**
 * Clamp text to {@link MAX_DOCUMENT_TEXT_CHARS}.
 * @param text - raw extracted text.
 * @returns clamped text and a truncation flag.
 */
export function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DOCUMENT_TEXT_CHARS) return { text, truncated: false }
  return { text: text.slice(0, MAX_DOCUMENT_TEXT_CHARS), truncated: true }
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
}

/**
 * Concatenate the text of every `<tag>…</tag>` run in an XML string (OOXML text
 * runs: `w:t` for DOCX, `a:t` for PPTX), decoding XML entities.
 * @param xml - raw XML.
 * @param tag - the run tag.
 * @returns the joined text.
 */
export function xmlTextRuns(xml: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, 'g')
  const parts: string[] = []
  for (const match of xml.matchAll(pattern)) {
    const decoded = (match[1] ?? '')
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name] ?? `&${name};`)
    if (decoded !== '') parts.push(decoded)
  }
  return parts.join(' ')
}

/** Extract a PDF's text layer page by page (main-thread, no worker/canvas). */
async function extractPdf(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await (pdfjs as {
    getDocument: (args: { data: Uint8Array; useWorkerFetch?: boolean; isEvalSupported?: boolean; useSystemFonts?: boolean })
      => { promise: Promise<PdfDocument> }
  }).getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise
  const pages: string[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    const line = content.items.map(item => ('str' in item ? item.str : '')).join(' ').trim()
    if (line !== '') pages.push(`--- page ${n} ---\n${line}`)
  }
  return pages.join('\n\n')
}

interface PdfDocument {
  numPages: number
  getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str?: string }> }> }>
}

/** Extract a DOCX file's text via `mammoth`. */
async function extractDocx(bytes: Uint8Array): Promise<string> {
  const mammoth = await import('mammoth')
  const api = (mammoth as { default?: MammothApi } & MammothApi)
  const extractRawText = api.extractRawText ?? api.default?.extractRawText
  if (extractRawText === undefined) throw new Error('mammoth.extractRawText unavailable')
  const result = await extractRawText({ buffer: Buffer.from(bytes) })
  return result.value
}

interface MammothApi {
  extractRawText?: (input: { buffer: Buffer }) => Promise<{ value: string }>
}

/** Extract an XLSX workbook as one CSV block per sheet, via `xlsx` (SheetJS). */
async function extractXlsx(bytes: Uint8Array): Promise<string> {
  const XLSX = await import('xlsx')
  const api = (XLSX as { default?: XlsxApi } & XlsxApi)
  const read = api.read ?? api.default?.read
  const utils = api.utils ?? api.default?.utils
  if (read === undefined || utils === undefined) throw new Error('xlsx read/utils unavailable')
  const workbook = read(bytes, { type: 'array' })
  const blocks: string[] = []
  for (const name of workbook.SheetNames) {
    const csv = utils.sheet_to_csv(workbook.Sheets[name]).trim()
    if (csv !== '') blocks.push(`--- sheet: ${name} ---\n${csv}`)
  }
  return blocks.join('\n\n')
}

interface XlsxApi {
  read: (data: Uint8Array, opts: { type: 'array' }) => { SheetNames: string[]; Sheets: Record<string, unknown> }
  utils: { sheet_to_csv: (sheet: unknown) => string }
}

/** Extract a PPTX file's slide text via `fflate` unzip + OOXML `a:t` runs. */
async function extractPptx(bytes: Uint8Array): Promise<string> {
  const { unzipSync } = await import('fflate')
  const decoder = new TextDecoder()
  const zip = unzipSync(bytes)
  const slidePaths = Object.keys(zip)
    .filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) =>
      Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0))
  const slides: string[] = []
  for (const [index, path] of slidePaths.entries()) {
    const entry = zip[path]
    if (entry === undefined) continue
    const text = xmlTextRuns(decoder.decode(entry), 'a:t').trim()
    if (text !== '') slides.push(`--- slide ${index + 1} ---\n${text}`)
  }
  return slides.join('\n\n')
}

/**
 * Extract an uploaded document's bytes into text.
 * @param fileName - original file name (drives classification).
 * @param dataBase64 - the file bytes, base64-encoded.
 * @returns the extracted document.
 * @throws {UnsupportedDocumentTypeError} when the file is not a supported document.
 */
export async function extractDocumentBytes(fileName: string, dataBase64: string): Promise<DocumentExtractResult> {
  const kind = documentKind(fileName)
  if (kind === null) throw new UnsupportedDocumentTypeError(fileName)
  const bytes = new Uint8Array(Buffer.from(dataBase64, 'base64'))

  let rawText = ''
  switch (kind) {
    case 'text': rawText = new TextDecoder().decode(bytes); break
    case 'pdf': rawText = await extractPdf(bytes); break
    case 'docx': rawText = await extractDocx(bytes); break
    case 'xlsx': rawText = await extractXlsx(bytes); break
    case 'pptx': rawText = await extractPptx(bytes); break
  }

  const clamped = truncateText(rawText)
  return { name: fileName, kind, text: clamped.text, images: [], truncated: clamped.truncated }
}
