/**
 * Host-side document save. Writes an uploaded document's bytes into a dedicated
 * attachments directory under the session's workspace, so the agent can process
 * it with its own tools (pdftotext, grep, unzip) instead of the whole document's
 * text flooding the model context.
 * @module
 */

import { Buffer } from 'node:buffer'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import type { DocumentSaveResult } from './types.ts'

/** Workspace-relative directory that holds attached documents. */
export const ATTACHMENTS_DIR = '.neo-attachments'

/** Hard cap on a single attachment (200 MiB), within the RPC body budget. */
export const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024

/** Thrown when an attachment cannot be saved (no workspace, too large, bad name). */
export class InvalidAttachmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAttachmentError'
  }
}

/** Everything outside this safe set becomes an underscore in a saved name. */
const SAFE_NAME_ALLOWED = /[^a-zA-Z0-9._-]/g

/**
 * Reduce a supplied file name to a safe basename: strip any directory parts,
 * keep only `[A-Za-z0-9._-]` (so no separators or control characters survive),
 * drop leading dots (no hidden/`..` names), and bound the length.
 * @param fileName - the client-supplied name.
 * @returns a safe basename, never empty.
 */
export function safeBaseName(fileName: string): string {
  const base = basename(fileName).replace(SAFE_NAME_ALLOWED, '_').replace(/^\.+/, '')
  const bounded = base.slice(0, 200)
  return bounded === '' ? 'attachment' : bounded
}

/**
 * Save an uploaded document under `<workspaceRoot>/.neo-attachments/`.
 * @param workspaceRoot - absolute workspace root (the session cwd).
 * @param fileName - original file name (basename used).
 * @param dataBase64 - the file bytes, base64-encoded.
 * @returns the relative and absolute paths and byte length.
 * @throws {InvalidAttachmentError} on missing workspace, oversize, or path escape.
 */
export async function saveAttachment(
  workspaceRoot: string,
  fileName: string,
  dataBase64: string,
): Promise<DocumentSaveResult> {
  if (workspaceRoot.trim() === '') {
    throw new InvalidAttachmentError('no workspace is open for this session')
  }
  const bytes = Buffer.from(dataBase64, 'base64')
  if (bytes.length === 0) throw new InvalidAttachmentError('attachment is empty')
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new InvalidAttachmentError(`attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`)
  }
  const name = safeBaseName(fileName)
  const dir = resolve(join(workspaceRoot, ATTACHMENTS_DIR))
  const absolutePath = resolve(join(dir, name))
  // Defense-in-depth: the target must stay inside the attachments directory.
  if (absolutePath !== dir && !absolutePath.startsWith(dir + sep)) {
    throw new InvalidAttachmentError('attachment path escapes the workspace')
  }
  await mkdir(dir, { recursive: true })
  await writeFile(absolutePath, bytes)
  return { relativePath: `${ATTACHMENTS_DIR}/${name}`, absolutePath, bytes: bytes.length }
}
