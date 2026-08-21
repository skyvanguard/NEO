/**
 * Pure, browser-safe classification for the composer. Decides whether an
 * attached file is an image, an accepted document/data file, or unsupported —
 * WITHOUT any parser library. Accepted non-image files are saved to the session
 * workspace by the host `document-attach` service and the agent processes them
 * with its own tools; this only gates the attach UI and picks the chip label.
 * @module
 */

/** Attachment families this composer accepts (besides images). */
export type DocumentKind = 'text' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'data'

/** Extensions treated as plain text. */
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

/**
 * Binary / data extensions saved to the workspace for the agent to process with
 * its own tools (e.g. tshark/tcpdump for captures, openssl for certs, unzip/tar
 * for archives). No client-side parsing — these are just uploaded and referenced.
 */
const DATA_EXTENSIONS = new Set([
  // packet captures
  'pcapng', 'pcap', 'cap', 'ntar',
  // certificates & keys
  'pem', 'crt', 'cer', 'der', 'key', 'pub', 'p12', 'pfx', 'csr', 'jks', 'keystore',
  // databases
  'db', 'sqlite', 'sqlite3', 'kdbx',
  // binaries & memory/dumps
  'bin', 'exe', 'dll', 'so', 'elf', 'dump', 'dmp', 'raw', 'hex', 'core',
  // scan / recon outputs
  'nmap', 'gnmap', 'nessus',
  // archives
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar',
  // web / mail
  'har', 'eml', 'mbox', 'msg', 'warc',
])

/** Thrown when an attached file is neither an image nor a supported document. */
export class UnsupportedDocumentTypeError extends Error {
  constructor(readonly fileType: string, readonly fileName: string) {
    super(`unsupported document type: ${fileType || fileName || 'unknown'}`)
    this.name = 'UnsupportedDocumentTypeError'
  }
}

/**
 * Lower-cased extension of a file name, without the dot; a leading-dot dotfile
 * (`.env`) is its own extension.
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
 * Classify an attached file into a document kind, or `null` when it is not a
 * document this composer accepts (e.g. an image or an unknown binary).
 * @param file - the attached browser file.
 * @returns the document kind, or `null`.
 */
export function documentKind(file: File): DocumentKind | null {
  const ext = fileExtension(file.name)
  const office = OFFICE_EXTENSIONS[ext]
  if (office !== undefined) return office
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (DATA_EXTENSIONS.has(ext)) return 'data'
  const base = (file.name.split(/[\\/]/).pop() ?? file.name).toLowerCase()
  if (base === 'dockerfile' || base === 'makefile') return 'text'
  if (file.type.startsWith('text/')) return 'text'
  if (file.type === 'application/json' || file.type === 'application/xml') return 'text'
  if (file.type === 'application/pdf') return 'pdf'
  return null
}
