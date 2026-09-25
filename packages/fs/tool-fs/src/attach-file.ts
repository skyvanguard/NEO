/**
 * The model-facing `attach_file` tool: reads any workspace file, durably commits
 * its bytes through the attachment service (the same content-addressed lifecycle
 * as an image), and returns a `file` block so the client renders a download card
 * in the conversation. Unlike `read_image`, the bytes are never sent to the
 * model — the block is a UI-only artifact — so there is no model-capability gate.
 * @module @neo/tool-fs/src/attach-file
 */

import { basename, extname } from 'node:path'
import type { Context } from '@neo/cordis'
import { AttachmentId } from '@neo/attachment'
import type { FileAttachmentRef } from '@neo/attachment'
import { createUserMessage } from '@neo/llm'
import type { ContentBlock } from '@neo/llm'
import { defineTool } from '@neo/tools'
import type { GenericCallView } from '@neo/tools'
import type {} from '@neo/fs'
import { resolveRegularReadTarget } from './read-target.ts'

/** Best-effort media types by extension; the download card falls back to octet-stream. */
const FILE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/** Default media type stored when the extension is unknown. */
const DEFAULT_FILE_MEDIA_TYPE = 'application/octet-stream'

/** The canonical outcome declared by the `attach_file` output schema. */
export interface FileAttachValue {
  path: string
  file: {
    attachmentId: string
    mediaType: string
    bytes: number
    name?: string
  }
}

/**
 * Map a path to its declared download media type by extension.
 * @param filePath - the raw `file_path` argument (not yet resolved).
 * @returns a known media type, or the octet-stream default.
 */
export function fileMediaTypeForPath(filePath: string): string {
  return FILE_MEDIA_TYPES[extname(filePath).toLowerCase()] ?? DEFAULT_FILE_MEDIA_TYPE
}

/**
 * Re-brand a canonical attach outcome into the durable reference a `FileBlock` carries.
 * @param file - the canonical file metadata from the output schema.
 * @returns the branded attachment reference.
 */
export function fileRefFromValue(file: FileAttachValue['file']): FileAttachmentRef {
  return {
    attachmentId: AttachmentId(file.attachmentId),
    mediaType: file.mediaType,
    bytes: file.bytes,
    ...file.name === undefined ? {} : { name: file.name },
  }
}

/**
 * Format an attach as the model-facing envelope beside its file block.
 * @param displayPath - the backend-resolved path rendered in the envelope's `<path>` element.
 * @param file - the canonical file metadata to summarize.
 * @returns the model-facing envelope; the download card rides the adjacent file block.
 */
export function formatFileAttachOutput(displayPath: string, file: FileAttachValue['file']): string {
  return `<path>${displayPath}</path>
<type>file</type>
<content>
Published ${file.name ?? basename(displayPath)} (${file.mediaType}, ${file.bytes} bytes) as a downloadable attachment in the chat.
</content>`
}

/**
 * Project one canonical attach into its model-facing envelope and file block.
 * @param value - the canonical attach outcome.
 * @returns the two content blocks used by native and nested dispatches.
 */
function fileAttachContent(value: FileAttachValue): ContentBlock[] {
  return [
    { type: 'text', text: formatFileAttachOutput(value.path, value.file) },
    { type: 'file', attachment: fileRefFromValue(value.file) },
  ]
}

/**
 * Register the `attach_file` tool into the given context. The composing plugin
 * owns the attachments gate: `src/index.ts` calls this inside
 * `ctx.inject(['attachments'], …)` so the tool exists only while a durable
 * store is mounted. Execution re-checks `ctx.get('attachments')` for direct callers.
 * @param ctx - the registration scope; execution uses its `fs` service plus the
 *   mounted `attachments` service.
 */
export function applyAttachFileTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'attach_file',
    description: 'Publish a workspace file as a downloadable attachment (a download card) in the chat. Use after generating a deliverable (report, export, archive) the user should be able to download.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the file to publish, resolved by the filesystem backend.' },
      name: { type: 'string', description: 'Optional display/download name; defaults to the file base name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          file: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => fileAttachContent(value),
    },
    // Content-addressed attachment writes are idempotent, so concurrent attaches
    // of the same file cannot conflict.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')

      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error(`cannot attach "${args.file_path}": no attachment service is mounted`)
      }
      const { target, info } = await resolveRegularReadTarget(ctx, exec, args.file_path)

      const byteCap = attachments.fileLimits.maxFileBytes
      const data = await ctx.fs.readBytes(target, exec.signal, byteCap)
      const mediaType = fileMediaTypeForPath(target.displayPath)
      const name = args.name !== undefined && args.name.trim().length > 0 ? args.name : basename(target.displayPath)
      // Persist before returning: the file block must reference a durably
      // committed object by the time the tool/result event is appended.
      const ref = await attachments.saveFile({ data, mediaType, name })
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      const value: FileAttachValue = {
        path: target.displayPath,
        file: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          ...ref.name === undefined ? {} : { name: ref.name },
        },
      }
      if (exec.parent !== undefined) {
        exec.deferContext(createUserMessage({
          content: fileAttachContent(value),
          source: { kind: 'plugin', plugin: 'tool-fs' },
        }))
      }
      return value
    },
    // Pure display: a generic card in the read family with a follow-along
    // location on the attached file.
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Attach ${args.file_path}`,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
  }))
}
