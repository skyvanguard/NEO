/**
 * Client-side document extraction. Turns an attached document (plain text,
 * PDF, or Office file) into plain text — and, for image-only PDFs, into
 * rendered page images — that the text+image model can actually consume. The
 * model itself declares only `text` and `image` input modalities, so a
 * "document" is never a new modality: it is extracted here and injected as
 * ordinary text (and, as a last resort, image) content parts.
 *
 * Every heavy parser (`pdfjs-dist`, `mammoth`, `xlsx`) is loaded through a
 * dynamic `import()` inside its wrapper, so none of them enters the main
 * bundle — the cost is paid only the first time a document of that kind is
 * attached. `fflate` (already a frontend dependency) handles the PPTX zip.
 *
 * The pure helpers (`documentKind`, `fileExtension`, `xmlTextRuns`,
 * `truncateText`) carry no browser or library coupling and are unit-tested
 * directly; the `extract*` wrappers own the library integration.
 * @module
 */

/** Upper bound on extracted text per document, in characters (~30k tokens). */
export const MAX_DOCUMENT_TEXT_CHARS = 120_000

/** Cap on rendered PDF page images for an image-only (scanned) PDF. */
export const MAX_PDF_PAGE_IMAGES = 10

/** Document families this module can extract. `image` files keep the existing image path. */
export type DocumentKind = 'text' | 'pdf' | 'docx' | 'xlsx' | 'pptx'

/** Extensions treated as plain text and read verbatim (no library needed). */
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
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  pptx: 'pptx',
}

/** A base64 PNG page image rendered from an image-only PDF. */
export interface ExtractedImage {
  mediaType: 'image/png'
  /** base64 payload, without the `data:` prefix. */
  data: string
}

/** The result of extracting one attached document. */
export interface ExtractedDocument {
  /** Original file name, used to label the injected block. */
  name: string
  /** Extracted plain text; may be empty when a PDF is image-only. */
  text: string
  /** Rendered page images, only populated when a PDF has no text layer. */
  images: ExtractedImage[]
  /** Whether `text` was truncated at {@link MAX_DOCUMENT_TEXT_CHARS}. */
  truncated: boolean
}

/** Thrown when an attached file is neither an image nor a supported document. */
export class UnsupportedDocumentTypeError extends Error {
  constructor(readonly fileType: string, readonly fileName: string) {
    super(`unsupported document type: ${fileType || fileName || 'unknown'}`)
    this.name = 'UnsupportedDocumentTypeError'
  }
}

/**
 * Lower-cased extension of a file name, without the dot. Files with no
 * extension return `''`; a leading-dot name (`.env`) is treated as the
 * extension itself so dotfiles classify as text.
 * @param name - the file name.
 * @returns the extension, lower-cased, or `''`.
 */
export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  if (base.startsWith('.') && !base.slice(1).includes('.')) return base.slice(1).toLowerCase()
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/**
 * Classify an attached file into a document kind, or `null` when it is not a
 * document this module extracts (e.g. an image, or an unknown binary).
 * Classification prefers the extension (authoritative for source and Office
 * files); a `text/*` MIME with an unknown extension still counts as text.
 * @param file - the attached browser file.
 * @returns the document kind, or `null`.
 */
export function documentKind(file: File): DocumentKind | null {
  const ext = fileExtension(file.name)
  const office = OFFICE_EXTENSIONS[ext]
  if (office !== undefined) return office
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (ext === '') {
    // Extensionless: trust a text MIME (or the conventional Dockerfile/Makefile).
    const base = (file.name.split(/[\\/]/).pop() ?? file.name).toLowerCase()
    if (base === 'dockerfile' || base === 'makefile') return 'text'
  }
  if (file.type.startsWith('text/')) return 'text'
  if (file.type === 'application/json' || file.type === 'application/xml' || file.type === 'application/x-yaml') return 'text'
  if (file.type === 'application/pdf') return 'pdf'
  return null
}

/**
 * Clamp text to {@link MAX_DOCUMENT_TEXT_CHARS}, reporting whether it was cut.
 * @param text - the raw extracted text.
 * @returns the clamped text and a truncation flag.
 */
export function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DOCUMENT_TEXT_CHARS) return { text, truncated: false }
  return { text: text.slice(0, MAX_DOCUMENT_TEXT_CHARS), truncated: true }
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
}

/**
 * Extract the concatenated text of every `<tag>…</tag>` run in an XML string.
 * Used for OOXML text runs (`w:t` in DOCX, `a:t` in PPTX) without pulling in a
 * DOM parser. Numeric and named XML entities are decoded; runs are separated by
 * a space so words never fuse across run boundaries.
 * @param xml - the raw XML document text.
 * @param tag - the local run tag (e.g. `w:t`, `a:t`).
 * @returns the joined, entity-decoded text.
 */
export function xmlTextRuns(xml: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, 'g')
  const parts: string[] = []
  for (const match of xml.matchAll(pattern)) {
    const decoded = (match[1] ?? '')
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&(amp|lt|gt|quot|apos);/g, entity => XML_ENTITIES[entity] ?? entity)
    if (decoded !== '') parts.push(decoded)
  }
  return parts.join(' ')
}

/** Read a plain-text file verbatim. */
async function extractText(file: File): Promise<string> {
  return file.text()
}

/**
 * Extract a PDF's text layer, page by page. When the whole document yields no
 * text (a scanned/image-only PDF), the caller renders pages to images instead;
 * this returns an empty string in that case so {@link extractDocument} can
 * decide. Uses `pdfjs-dist`, loaded lazily; the worker is disabled so parsing
 * runs on the main thread (robust across the tsdown→vite two-stage bundle).
 */
async function extractPdfText(file: File): Promise<{ text: string; pageCount: number; doc: unknown }> {
  const pdfjs = await import('pdfjs-dist')
  // Main-thread parsing: avoids shipping/serving a separate worker asset.
  ;(pdfjs as { GlobalWorkerOptions?: { workerSrc: string } }).GlobalWorkerOptions!.workerSrc = ''
  const data = new Uint8Array(await file.arrayBuffer())
  const doc = await (pdfjs as {
    getDocument: (args: { data: Uint8Array; disableWorker?: boolean; isEvalSupported?: boolean }) => { promise: Promise<PdfDocument> }
  }).getDocument({ data, disableWorker: true, isEvalSupported: false }).promise
  const pages: string[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    const line = content.items.map(item => ('str' in item ? item.str : '')).join(' ').trim()
    if (line !== '') pages.push(`--- page ${n} ---\n${line}`)
  }
  return { text: pages.join('\n\n'), pageCount: doc.numPages, doc }
}

/** Minimal structural typings for the pdfjs objects we touch. */
interface PdfDocument {
  numPages: number
  getPage: (n: number) => Promise<PdfPage>
}
interface PdfPage {
  getTextContent: () => Promise<{ items: Array<{ str?: string }> }>
  getViewport: (opts: { scale: number }) => { width: number; height: number }
  render: (ctx: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> }
}

/**
 * Render the first {@link MAX_PDF_PAGE_IMAGES} pages of an image-only PDF to
 * PNG images for the vision path. Requires a DOM canvas; returns `[]` when no
 * canvas is available (e.g. a non-browser test environment).
 */
async function renderPdfPages(doc: PdfDocument): Promise<ExtractedImage[]> {
  if (typeof document === 'undefined') return []
  const images: ExtractedImage[] = []
  const count = Math.min(doc.numPages, MAX_PDF_PAGE_IMAGES)
  for (let n = 1; n <= count; n++) {
    const page = await doc.getPage(n)
    const viewport = page.getViewport({ scale: 1.5 })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const context = canvas.getContext('2d')
    if (context === null) continue
    await page.render({ canvasContext: context, viewport }).promise
    const dataUrl = canvas.toDataURL('image/png')
    images.push({ mediaType: 'image/png', data: dataUrl.slice(dataUrl.indexOf(',') + 1) })
  }
  return images
}

/** Extract a DOCX file's text via `mammoth`. */
async function extractDocx(file: File): Promise<string> {
  const mammoth = await import('mammoth')
  const arrayBuffer = await file.arrayBuffer()
  const result = await (mammoth as {
    extractRawText: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>
  }).extractRawText({ arrayBuffer })
  return result.value
}

/** Extract an XLSX workbook as one CSV block per sheet, via `xlsx` (SheetJS). */
async function extractXlsx(file: File): Promise<string> {
  const XLSX = await import('xlsx')
  const data = new Uint8Array(await file.arrayBuffer())
  const workbook = (XLSX as {
    read: (data: Uint8Array, opts: { type: 'array' }) => { SheetNames: string[]; Sheets: Record<string, unknown> }
  }).read(data, { type: 'array' })
  const sheetToCsv = (XLSX as { utils: { sheet_to_csv: (sheet: unknown) => string } }).utils.sheet_to_csv
  const blocks: string[] = []
  for (const name of workbook.SheetNames) {
    const csv = sheetToCsv(workbook.Sheets[name]).trim()
    if (csv !== '') blocks.push(`--- sheet: ${name} ---\n${csv}`)
  }
  return blocks.join('\n\n')
}

/** Extract a PPTX file's slide text via `fflate` unzip + OOXML `a:t` runs. */
async function extractPptx(file: File): Promise<string> {
  const { unzipSync } = await import('fflate')
  const decoder = new TextDecoder()
  const zip = unzipSync(new Uint8Array(await file.arrayBuffer()))
  const slidePaths = Object.keys(zip)
    .filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0)
      const nb = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0)
      return na - nb
    })
  const slides: string[] = []
  for (const [index, path] of slidePaths.entries()) {
    const text = xmlTextRuns(decoder.decode(zip[path]), 'a:t').trim()
    if (text !== '') slides.push(`--- slide ${index + 1} ---\n${text}`)
  }
  return slides.join('\n\n')
}

/**
 * Extract an attached document into text (and, for image-only PDFs, images).
 * @param file - the attached browser file.
 * @returns the extracted document.
 * @throws {UnsupportedDocumentTypeError} when the file is not a supported document.
 */
export async function extractDocument(file: File): Promise<ExtractedDocument> {
  const kind = documentKind(file)
  if (kind === null) throw new UnsupportedDocumentTypeError(file.type, file.name)

  let rawText = ''
  let images: ExtractedImage[] = []

  switch (kind) {
    case 'text':
      rawText = await extractText(file)
      break
    case 'docx':
      rawText = await extractDocx(file)
      break
    case 'xlsx':
      rawText = await extractXlsx(file)
      break
    case 'pptx':
      rawText = await extractPptx(file)
      break
    case 'pdf': {
      const pdf = await extractPdfText(file)
      rawText = pdf.text
      if (rawText.trim() === '') images = await renderPdfPages(pdf.doc as PdfDocument)
      break
    }
  }

  const clamped = truncateText(rawText)
  return { name: file.name, text: clamped.text, images, truncated: clamped.truncated }
}
