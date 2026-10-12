/** Durable attachment vocabulary. @module @neo/attachment/types */

import type { AttachmentId } from './brand.ts'

export type { AttachmentId } from './brand.ts'

/** Raster image formats accepted by the version-one attachment path. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Durable, serializable metadata for one immutable image object. */
export interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Optional display name stripped of local path information. */
  name?: string
}

/** Deployment-resolved limits used by upload admission and request buffering. */
export interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  mediaTypes: readonly ImageMediaType[]
}

/** Request to validate and durably commit one image. */
export interface SaveImageAttachment {
  data: Uint8Array
  /** Caller-declared media type, checked against fully decoded bytes. */
  mediaType: ImageMediaType
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string
}

/** Stored image bytes returned after reference and digest verification. */
export interface StoredImageAttachment {
  ref: ImageAttachmentRef
  data: Uint8Array
}

/**
 * Durable, serializable metadata for one immutable non-image file object.
 * Unlike an image, a file carries no intrinsic dimensions and its media type
 * is a free-form string (the store never decodes the bytes), so a download
 * card can label it without the raster admission path that images require.
 */
export interface FileAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Caller-declared media type, stored verbatim (defaults to octet-stream). */
  mediaType: string
  /** Exact stored byte length. */
  bytes: number
  /** Optional display/download name stripped of local path information. */
  name?: string
}

/** Deployment-resolved limits used by file admission and request buffering. */
export interface FileAttachmentLimits {
  maxFileBytes: number
}

/** Request to durably commit one arbitrary file. */
export interface SaveFileAttachment {
  data: Uint8Array
  /** Caller-declared media type, stored verbatim; never interpreted. */
  mediaType?: string
  /** Optional display name; it is never interpreted as a path. */
  name?: string
}

/** Stored file bytes returned after reference and digest verification. */
export interface StoredFileAttachment {
  ref: FileAttachmentRef
  data: Uint8Array
}
