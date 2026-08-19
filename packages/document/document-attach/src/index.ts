/**
 * Host-side document attachment, exposed to the browser client over Typert
 * Remote. The client uploads a document's bytes; this service — running in Node
 * — writes the file into the session workspace and returns its path. The agent
 * then processes it with its own tools (pdftotext, grep, unzip), so a large
 * document never floods the model context.
 * @module @deepseek-ai/dsh-document-attach
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { saveAttachment } from './save.ts'
import type { DocumentSaveRequest, DocumentSaveResult } from './types.ts'

export type * from './types.ts'
export { saveAttachment, safeBaseName, InvalidAttachmentError, ATTACHMENTS_DIR } from './save.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    documentAttach: DocumentAttachService
  }
}

/** Cordis Service exposing one Remote method: `documentAttach.save`. */
export class DocumentAttachService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'documentAttach')
  }

  /**
   * Save an uploaded document into the session workspace.
   * @param request - the file name, base64 bytes, and workspace root.
   * @returns where the file was written.
   */
  @Remote('save')
  async save(request: DocumentSaveRequest): Promise<DocumentSaveResult> {
    return saveAttachment(request.workspaceRoot, request.fileName, request.dataBase64)
  }
}

export default DocumentAttachService
