/**
 * Host-side document extraction, exposed to the browser client over Typert
 * Remote. The client uploads a document's bytes; this service — running in Node,
 * where the parsers work natively — returns extracted plain text the model can
 * read. Keeping the heavy PDF/Office parsers on the host is deliberate: the
 * browser client plugin loader cannot bundle these Node-oriented libraries.
 * @module @deepseek-ai/dsh-document-extract
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { extractDocumentBytes } from './extract.ts'
import type { DocumentExtractRequest, DocumentExtractResult } from './types.ts'

export type * from './types.ts'
export { extractDocumentBytes, documentKind, fileExtension, UnsupportedDocumentTypeError } from './extract.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    documentExtract: DocumentExtractService
  }
}

/** Cordis Service exposing one Remote method: `documentExtract.extract`. */
export class DocumentExtractService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'documentExtract')
  }

  /**
   * Extract an uploaded document to plain text.
   * @param request - the file name and base64 bytes.
   * @returns the extracted text (and metadata).
   */
  @Remote('extract')
  async extract(request: DocumentExtractRequest): Promise<DocumentExtractResult> {
    return extractDocumentBytes(request.fileName, request.dataBase64)
  }
}

export default DocumentExtractService
