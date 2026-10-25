/** Content-addressed, owner-private local attachment storage. */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import {
  AttachmentError,
  AttachmentId,
} from '@neo/attachment'
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
import { detectImage, probeImage } from './image.ts'

const ID_PATTERN = /^sha256:([a-f0-9]{64})$/
const durableHomes = new Set<string>()

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

// Control chars (C0 + DEL) plus the Unicode bidirectional formatting codes:
// LRM/RLM (200e/200f), the embeddings and overrides (202a-202e), and the
// isolates (2066-2069). A model-supplied name is attacker-controllable under
// prompt injection; an RLO (202e) reverses the trailing text so a download
// card can show `invoice<RLO>fdp.exe` as `invoiceexe.pdf` over an executable.
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g

function displayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  // Strip both separator styles by hand: a POSIX host treats `\` as an
  // ordinary character, so path.basename would keep a Windows client's full
  // local path and leak it into the reference and the session log.
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(UNSAFE_NAME_CHARS, '').trim().slice(0, 255)
  return clean === '' ? undefined : clean
}

function objectPath(root: string, sha256: string): string {
  return join(root, 'objects', sha256.slice(0, 2), sha256)
}

function ensureReference(ref: { attachmentId: ImageAttachmentRef['attachmentId'] }): string {
  const match = ID_PATTERN.exec(String(ref.attachmentId))
  if (match?.[1] === undefined) throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
  return match[1]
}

async function inspectMetadata(
  data: Uint8Array,
  declaredMediaType: ImageAttachmentRef['mediaType'],
  maxPixels?: number,
): Promise<Omit<ImageAttachmentRef, 'attachmentId' | 'name'>> {
  if (data.byteLength === 0) throw new AttachmentError('Image is empty.', 'INVALID_IMAGE')
  const detected = await detectImage(data, maxPixels)
  if (detected.mediaType !== declaredMediaType) throw new AttachmentError('Declared image type does not match its bytes.', 'IMAGE_TYPE_MISMATCH')
  return { ...detected, bytes: data.byteLength }
}

/**
 * Run the full admission policy for one image without touching storage.
 * @param input - encoded bytes and declared metadata.
 * @param limits - resolved storage policy.
 * @returns completion after the encoded raster has been fully decoded.
 */
export async function validateImageFile(input: SaveImageAttachment, limits: ImageAttachmentLimits): Promise<void> {
  if (input.data.byteLength > limits.maxImageBytes) {
    throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
  }
  await inspectMetadata(input.data, input.mediaType, limits.maxImagePixels)
}

/**
 * Make a directory's entries durable (fsync on a read-only directory handle).
 * A synced file alone does not survive a crash when its directory entry never
 * reached storage, so the publication directory is synced before a durable
 * reference is reported.
 */
async function syncDirectory(path: string): Promise<void> {
  /* v8 ignore next -- Windows cannot open directory handles; NTFS metadata journaling owns entry durability there. */
  if (process.platform === 'win32') return
  /* v8 ignore start -- Windows cannot exercise directory fsync; POSIX behavior tests enforce this peer. */
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  /* v8 ignore stop */
}

/**
 * Create one private directory tree and persist every ancestor entry up to a
 * caller-vouched durable boundary. The walk deliberately ignores what mkdir
 * reports as newly created: a concurrent first save can create a level this
 * process then merely observes, so "already existed" is not "already durable"
 * — the entry may still be unsynced in the creator, and a crash would drop a
 * directory the session checkpoint already references. Re-syncing a durable
 * entry is harmless; skipping an unsynced one is not.
 * @param path - absolute directory to create.
 * @param boundary - absolute ancestor the caller vouches is already durable.
 */
async function ensureDurableDirectory(path: string, boundary: string): Promise<void> {
  const target = resolve(path)
  const stop = resolve(boundary)
  await mkdir(target, { recursive: true, mode: 0o700 })
  await chmod(target, 0o700)
  let level = target
  while (level !== stop) {
    const parent = dirname(level)
    await syncDirectory(parent)
    /* v8 ignore next -- filesystem-root guard: callers pass a boundary that is an ancestor of path, so the walk reaches it first. */
    if (parent === level) return
    level = parent
  }
}

/**
 * Establish this process's proof that one NEO_HOME entry and every ancestor
 * below the filesystem root are durable. Mere existence is insufficient: a
 * concurrent process may have created the directory but not synced its parent.
 */
async function ensureDurableHome(path: string): Promise<string> {
  const home = resolve(path)
  if (!durableHomes.has(home)) {
    await ensureDurableDirectory(home, parse(home).root)
    durableHomes.add(home)
  }
  return home
}

/**
 * Persist immutable bytes as one content-addressed object below a versioned
 * attachment root, atomically and durably. Content type is irrelevant here:
 * both the image and the file paths share this staging→link→fsync core, so an
 * image and a file with identical bytes settle to the same object (natural
 * dedup by digest).
 * @param root - absolute `NEO_HOME/attachments/v1` root.
 * @param data - the exact bytes to store.
 * @returns the object's sha256 hex digest.
 */
async function persistContentAddressed(root: string, data: Uint8Array): Promise<string> {
  const sha256 = digest(data)
  const bucket = join(root, 'objects', sha256.slice(0, 2))
  const staging = join(root, 'tmp')
  // Establish NEO_HOME itself against the filesystem root once per process.
  // Every process performs that proof independently, so observing a directory
  // another process created can never be mistaken for durable publication.
  const boundary = await ensureDurableHome(dirname(dirname(resolve(root))))
  await ensureDurableDirectory(bucket, boundary)
  await ensureDurableDirectory(staging, boundary)
  const temporary = join(staging, randomUUID())
  const target = objectPath(root, sha256)
  let handle
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    try {
      await link(temporary, target)
    } catch (error) {
      /* v8 ignore next -- Private same-filesystem directories make EEXIST the only recoverable link race. */
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      const existing = new Uint8Array(await readFile(target))
      if (digest(existing) !== sha256) throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
    }
    // Persist the target entry and close a concurrent bucket-creation window
    // before the reference can reach a session checkpoint. The dedup path
    // repeats both syncs because it may observe another writer's link before
    // that writer reaches its own durability boundary.
    await syncDirectory(bucket)
    await syncDirectory(join(root, 'objects'))
    // The object is durably linked and synced by here, so the publish has
    // succeeded: removing the now-redundant staging file is pure cleanup and
    // must never turn a completed publish into a reported failure (otherwise
    // attach_file tells the model the file did not attach when it did).
    /* v8 ignore next -- the catch arm only runs if staging cleanup itself fails */
    await unlink(temporary).catch(() => {})
  } catch (error) {
    /* v8 ignore next -- A descriptor can remain open only when the underlying write/sync/close operation fails. */
    if (handle !== undefined) await handle.close().catch(
      /* v8 ignore next -- Close failure is superseded by the storage operation that entered cleanup. */
      () => {},
    )
    // Best-effort staging cleanup: a failure here must not mask the original
    // error, which carries the real reason the publish did not complete.
    /* v8 ignore next -- the catch arm only runs if staging cleanup itself fails */
    await unlink(temporary).catch(() => {})
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unable to persist attachment.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
  }
  return sha256
}

/**
 * Read one content-addressed object and verify its bytes hash to the reference.
 * @param root - absolute `NEO_HOME/attachments/v1` root.
 * @param sha256 - hex digest parsed from the caller's reference.
 * @param signal - optional cancellation for the filesystem read.
 * @returns the verified bytes.
 */
async function readContentAddressed(root: string, sha256: string, signal?: AbortSignal): Promise<Uint8Array> {
  let data: Uint8Array
  try {
    data = new Uint8Array(await readFile(objectPath(root, sha256), { signal }))
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    throw new AttachmentError('Unable to read attachment.', 'ATTACHMENT_READ_FAILED', { cause: error })
  }
  signal?.throwIfAborted()
  if (digest(data) !== sha256) throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
  return data
}

/**
 * Save and verify immutable image bytes below a versioned attachment root.
 * @param root - absolute `NEO_HOME/attachments/v1` root.
 * @param input - encoded bytes and declared metadata.
 * @param limits - resolved storage policy.
 * @returns durable content-addressed reference.
 */
export async function saveImageFile(root: string, input: SaveImageAttachment, limits: ImageAttachmentLimits): Promise<ImageAttachmentRef> {
  if (input.data.byteLength > limits.maxImageBytes) throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
  const metadata = await inspectMetadata(input.data, input.mediaType, limits.maxImagePixels)
  const sha256 = await persistContentAddressed(root, input.data)
  const name = displayName(input.name)
  return {
    attachmentId: AttachmentId(`sha256:${sha256}`),
    ...metadata,
    ...(name !== undefined ? { name } : {}),
  }
}

/**
 * Read and verify one content-addressed image.
 * @param root - absolute `NEO_HOME/attachments/v1` root.
 * @param ref - reference recorded in the session log.
 * @param signal - optional cancellation for filesystem and verification work.
 * @returns verified bytes and reference.
 * @throws the signal reason when aborted, or an AttachmentError when verification fails.
 */
export async function readImageFile(
  root: string,
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
): Promise<StoredImageAttachment> {
  signal?.throwIfAborted()
  const sha256 = ensureReference(ref)
  const data = await readContentAddressed(root, sha256, signal)
  // The digest proves these are the exact bytes admission fully decoded, so
  // the read path only re-derives the header fields (no raster decode, no
  // per-request pixel amplification on history replay).
  const metadata = await probeImage(data)
  signal?.throwIfAborted()
  if (metadata.mediaType !== ref.mediaType || data.byteLength !== ref.bytes
    || metadata.width !== ref.width || metadata.height !== ref.height) {
    throw new AttachmentError('Stored attachment metadata does not match its reference.', 'ATTACHMENT_CORRUPT')
  }
  return { ref, data }
}

/** Media type stored when a caller supplies none; the store never sniffs bytes. */
const DEFAULT_FILE_MEDIA_TYPE = 'application/octet-stream'

/**
 * Save arbitrary file bytes below a versioned attachment root. Unlike the image
 * path, the bytes are never decoded: only the byte-length policy is enforced and
 * the declared media type is stored verbatim.
 * @param root - absolute `NEO_HOME/attachments/v1` root.
 * @param input - file bytes, optional media type, and optional display name.
 * @param limits - resolved file storage policy.
 * @returns durable content-addressed reference.
 */
export async function saveFileFile(root: string, input: SaveFileAttachment, limits: FileAttachmentLimits): Promise<FileAttachmentRef> {
  if (input.data.byteLength === 0) throw new AttachmentError('File is empty.', 'INVALID_ATTACHMENT')
  if (input.data.byteLength > limits.maxFileBytes) throw new AttachmentError('File exceeds the configured byte limit.', 'ATTACHMENT_TOO_LARGE')
  const sha256 = await persistContentAddressed(root, input.data)
  const name = displayName(input.name)
  return {
    attachmentId: AttachmentId(`sha256:${sha256}`),
    mediaType: input.mediaType ?? DEFAULT_FILE_MEDIA_TYPE,
    bytes: input.data.byteLength,
    ...(name !== undefined ? { name } : {}),
  }
}

/**
 * Read one content-addressed file and verify bytes and length match the ref.
 * @param root - absolute `NEO_HOME/attachments/v1` root.
 * @param ref - reference recorded in the session log.
 * @param signal - optional cancellation for filesystem and verification work.
 * @returns verified bytes and reference.
 * @throws the signal reason when aborted, or an AttachmentError when verification fails.
 */
export async function readFileFile(
  root: string,
  ref: FileAttachmentRef,
  signal?: AbortSignal,
): Promise<StoredFileAttachment> {
  signal?.throwIfAborted()
  const sha256 = ensureReference(ref)
  const data = await readContentAddressed(root, sha256, signal)
  if (data.byteLength !== ref.bytes) {
    throw new AttachmentError('Stored attachment metadata does not match its reference.', 'ATTACHMENT_CORRUPT')
  }
  return { ref, data }
}
