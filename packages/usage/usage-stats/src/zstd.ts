/**
 * Minimal, self-contained multi-frame Zstandard reader. The session persistence
 * backend appends one independently-decodable frame per flush, so a session log
 * is a concatenation of frames — and Node's `node:zlib` zstd only decodes the
 * FIRST frame of such a stream. This scans complete frame boundaries (by parsing
 * headers, without decompressing) and decodes each frame, tolerating a torn or
 * partially-written final frame by stopping early. Frame-scan logic mirrors
 * `session-persistence-jsonl`'s reader.
 * @module
 */

import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528

interface FrameRange {
  start: number
  end: number
}

/**
 * Locate complete Zstandard frame byte-ranges without decompressing. Stops at
 * the first torn, incomplete, or invalid frame and returns what precedes it.
 * @param buffer - the raw session-log bytes.
 * @returns complete frame ranges in file order.
 */
export function scanZstdFrames(buffer: Buffer): FrameRange[] {
  const frames: FrameRange[] = []
  let offset = 0
  try {
    while (offset < buffer.length) {
      const start = offset
      if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
      offset += 4
      if (offset >= buffer.length) break
      const descriptor = buffer.readUInt8(offset)
      offset += 1
      const contentSizeFlag = descriptor >>> 6
      const singleSegment = (descriptor & 0x20) !== 0
      const checksum = (descriptor & 0x04) !== 0
      const dictionaryFlag = descriptor & 0x03
      const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
      const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
      const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
      if (buffer.length - offset < remainingHeaderBytes) break
      offset += remainingHeaderBytes
      let torn = false
      for (;;) {
        if (buffer.length - offset < 3) { torn = true; break }
        const blockHeader = buffer.readUIntLE(offset, 3)
        offset += 3
        const lastBlock = (blockHeader & 1) !== 0
        const blockType = (blockHeader >>> 1) & 0x03
        const blockSize = blockHeader >>> 3
        const payloadBytes = blockType === 0x01 ? 1 : blockSize
        if (buffer.length - offset < payloadBytes) { torn = true; break }
        offset += payloadBytes
        if (lastBlock) break
      }
      if (torn) break
      if (checksum) {
        if (buffer.length - offset < 4) break
        offset += 4
      }
      frames.push({ start, end: offset })
    }
  } catch {
    // A malformed header stops the scan; return the frames decoded so far.
  }
  return frames
}

/**
 * Decompress every complete frame of a concatenated-frame Zstandard buffer,
 * reporting how many leading bytes were consumed. `consumedBytes` is the offset
 * just past the last frame that decoded cleanly, so a caller that re-reads from
 * there folds only the bytes appended since — the frames before it are stable
 * (the log is append-only) and never need decoding again.
 * @param buffer - the raw session-log bytes (must start at a frame boundary).
 * @returns the decompressed plaintext and the consumed-byte count.
 */
export function decompressFrames(buffer: Buffer): { text: Buffer; consumedBytes: number } {
  const parts: Buffer[] = []
  let consumedBytes = 0
  for (const frame of scanZstdFrames(buffer)) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
    } catch {
      break
    }
    consumedBytes = frame.end
  }
  return { text: Buffer.concat(parts), consumedBytes }
}

/**
 * Decompress every complete frame of a concatenated-frame Zstandard buffer.
 * @param buffer - the raw session-log bytes.
 * @returns the decompressed plaintext of all complete frames.
 */
export function decompressConcatenatedZstd(buffer: Buffer): Buffer {
  return decompressFrames(buffer).text
}
