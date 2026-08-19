/**
 * Public request/result vocabulary for host-side document extraction. Types
 * only, no Node runtime imports, so the generated Remote client can consume it
 * in the browser without pulling in the host parsers.
 * @module @deepseek-ai/dsh-document-extract/types
 */

/** A document uploaded for host-side extraction. */
export interface DocumentExtractRequest {
  /** Original file name, used to classify the document and label the result. */
  readonly fileName: string
  /** The file's bytes, base64-encoded (no `data:` prefix). */
  readonly dataBase64: string
}

/** A page image rendered from an image-only PDF (base64 PNG, no prefix). */
export interface DocumentExtractedImage {
  readonly mediaType: 'image/png'
  readonly data: string
}

/** The extracted content of one document. */
export interface DocumentExtractResult {
  /** Echoed file name. */
  readonly name: string
  /** The extractor family that handled the file (`text`/`pdf`/`docx`/`xlsx`/`pptx`). */
  readonly kind: string
  /** Extracted plain text; empty when a PDF is image-only. */
  readonly text: string
  /** Rendered page images, only for image-only PDFs (currently always empty; reserved). */
  readonly images: readonly DocumentExtractedImage[]
  /** Whether `text` was truncated at the host-side character cap. */
  readonly truncated: boolean
}
