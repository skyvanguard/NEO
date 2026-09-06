/**
 * Public request/result vocabulary for host-side document attachment. Types
 * only, no Node imports, so the generated Remote client can consume it in the
 * browser.
 * @module @neo/dsh-document-attach/types
 */

/** A document uploaded to be saved into the session workspace. */
export interface DocumentSaveRequest {
  /** Original file name (only its basename is used). */
  readonly fileName: string
  /** The file's bytes, base64-encoded (no `data:` prefix). */
  readonly dataBase64: string
  /** Absolute path of the session's workspace root, where the file is saved. */
  readonly workspaceRoot: string
}

/** Where a saved document landed, for referencing it to the agent. */
export interface DocumentSaveResult {
  /** Path relative to the workspace root (e.g. `.neo-attachments/report.pdf`). */
  readonly relativePath: string
  /** Absolute path on the host filesystem. */
  readonly absolutePath: string
  /** Byte length written. */
  readonly bytes: number
}
