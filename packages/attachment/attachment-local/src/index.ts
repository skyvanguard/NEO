/** Local durable attachment backend rooted below `NEO_HOME`. @module @neo/attachment-local */

import { join, resolve } from 'node:path'
import { Context } from '@neo/cordis'
import z from '@neo/schemastery'
import { AttachmentStore } from '@neo/attachment'
import type {
  FileAttachmentLimits,
  FileAttachmentRef,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveFileAttachment,
  SaveImageAttachment,
  StoredFileAttachment,
  StoredImageAttachment,
} from '@neo/attachment'
import { resolveNeoHome } from '@neo/home-paths'
import { readFileFile, readImageFile, saveFileFile, saveImageFile, validateImageFile } from './store.ts'

export { detectImage } from './image.ts'
export { readFileFile, readImageFile, saveFileFile, saveImageFile, validateImageFile } from './store.ts'

/** Default maximum encoded bytes for one image. */
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** Default maximum images in one prompt. */
export const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20
/** Default maximum aggregate image bytes in one prompt. */
export const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 100 * 1024 * 1024
/** Default maximum intrinsic pixels for one image. */
export const DEFAULT_MAX_IMAGE_PIXELS = 40_000_000
/**
 * Default maximum bytes for one agent-published downloadable file (50 MiB).
 * Provisional and deployment-tunable via `maxFileBytes`: the download endpoint
 * buffers the whole file as base64 in one RPC envelope (no streaming yet), so
 * the default stays conservative until large-file transport is streamed.
 */
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024

/** Local attachment backend configuration. */
export interface Config {
  /** Explicit harness home; omitted follows `NEO_HOME`, then `~/.neo`. */
  neoHome?: string
  /** Maximum encoded bytes accepted for one image. */
  maxImageBytes?: number
  /** Maximum image count accepted in one submitted message. */
  maxImagesPerMessage?: number
  /** Maximum aggregate encoded image bytes accepted in one submitted message. */
  maxMessageImageBytes?: number
  /** Maximum intrinsic width multiplied by height accepted for one image. */
  maxImagePixels?: number
  /** Maximum bytes accepted for one agent-published downloadable file. */
  maxFileBytes?: number
}

/** Persistent content-addressed local attachment store. */
export class LocalAttachmentStore extends AttachmentStore {
  static Config: z<Config> = z.object({
    neoHome: z.string(),
    maxImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
    maxImagesPerMessage: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_MESSAGE),
    maxMessageImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_IMAGE_BYTES),
    maxImagePixels: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_PIXELS),
    maxFileBytes: z.number().step(1).min(1).default(DEFAULT_MAX_FILE_BYTES),
  })

  /** Absolute versioned storage root. */
  readonly root: string
  readonly imageLimits: ImageAttachmentLimits
  readonly fileLimits: FileAttachmentLimits

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.root = resolve(join(resolveNeoHome(config.neoHome), 'attachments', 'v1'))
    this.imageLimits = Object.freeze({
      maxImageBytes: config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      maxImagesPerMessage: config.maxImagesPerMessage ?? DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: config.maxMessageImageBytes ?? DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxImagePixels: config.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS,
      mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
    })
    this.fileLimits = Object.freeze({
      maxFileBytes: config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    })
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    await validateImageFile(input, this.imageLimits)
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return saveImageFile(this.root, input, this.imageLimits)
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    return readImageFile(this.root, ref, signal)
  }

  async saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
    return saveFileFile(this.root, input, this.fileLimits)
  }

  async readFile(ref: FileAttachmentRef, signal?: AbortSignal): Promise<StoredFileAttachment> {
    return readFileFile(this.root, ref, signal)
  }
}

export default LocalAttachmentStore
