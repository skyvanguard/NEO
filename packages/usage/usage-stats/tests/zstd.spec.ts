/**
 * Multi-frame Zstandard reader tests (Node): frame-boundary scanning across
 * every frame-header layout, early stops on torn or invalid input, and
 * decoding that halts at the first frame that fails to decompress. Frames are
 * either produced by Node's own encoder or assembled byte by byte; each
 * assembled frame is a valid frame that Node's decoder accepts.
 */

import { Buffer } from 'node:buffer'
import { constants, zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decompressConcatenatedZstd, decompressFrames, scanZstdFrames } from '../src/zstd.ts'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const RAW_BLOCK = 0
const RLE_BLOCK = 1

/** A 3-byte little-endian block header: last-block bit, block type, block size. */
function blockHeader(last: boolean, type: number, size: number): Buffer {
  const value = (size << 3) | (type << 1) | (last ? 1 : 0)
  return Buffer.from([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff])
}

function rawBlock(text: string, last = true): Buffer {
  return Buffer.concat([blockHeader(last, RAW_BLOCK, Buffer.byteLength(text)), Buffer.from(text)])
}

function rleBlock(char: string, count: number): Buffer {
  return Buffer.concat([blockHeader(true, RLE_BLOCK, count), Buffer.from(char)])
}

/** A frame from its magic number, header bytes (descriptor first), and blocks. */
function frame(header: readonly number[], ...blocks: Buffer[]): Buffer {
  return Buffer.concat([MAGIC, Buffer.from(header), ...blocks])
}

function compress(text: string, params?: Record<number, number>): Buffer {
  return zstdCompressSync(Buffer.from(text), params === undefined ? undefined : { params })
}

const withChecksum = { [constants.ZSTD_c_checksumFlag]: 1 }

describe('scanZstdFrames', () => {
  // [layout, frame, its frame-header descriptor byte, its plaintext]
  it.each([
    ['a single segment with a 1-byte content size', compress('hello\n'), 0x20, 'hello\n'],
    ['a window descriptor and no content size',
      compress('hello\n', { [constants.ZSTD_c_contentSizeFlag]: 0 }), 0x00, 'hello\n'],
    ['a 2-byte content size', compress('x'.repeat(1000)), 0x60, 'x'.repeat(1000)],
    ['a 4-byte content size', frame([0xa0, 3, 0, 0, 0], rawBlock('xyz')), 0xa0, 'xyz'],
    ['an 8-byte content size', frame([0xe0, 3, 0, 0, 0, 0, 0, 0, 0], rawBlock('xyz')), 0xe0, 'xyz'],
    ['a 1-byte dictionary id', frame([0x21, 0, 3], rawBlock('abc')), 0x21, 'abc'],
    ['a 2-byte dictionary id', frame([0x22, 0, 0, 3], rawBlock('abc')), 0x22, 'abc'],
    ['a 4-byte dictionary id', frame([0x23, 0, 0, 0, 0, 3], rawBlock('abc')), 0x23, 'abc'],
    ['a content checksum', compress('hello\n', withChecksum), 0x24, 'hello\n'],
    ['a raw block followed by a last RLE block', frame([0x00, 0x00], rawBlock('ab', false), rleBlock('c', 3)), 0x00, 'abccc'],
  ] as const)('measures a frame with %s so the next frame starts right after it', (_layout, first, descriptor, plaintext) => {
    expect(first[4]).toBe(descriptor)
    const follower = compress('tail\n')
    const buffer = Buffer.concat([first, follower])

    expect(scanZstdFrames(buffer)).toEqual([
      { start: 0, end: first.length },
      { start: first.length, end: buffer.length },
    ])
    const decoded = decompressFrames(buffer)
    expect(decoded.text.toString()).toBe(`${plaintext}tail\n`)
    expect(decoded.consumedBytes).toBe(buffer.length)
  })

  it.each([
    ['fewer bytes than a magic number', Buffer.from([0x28, 0xb5])],
    ['bytes that are not a magic number', Buffer.from('JUNK')],
    ['a magic number without a frame header', MAGIC],
    ['a frame header cut short', frame([0xe0, 3, 0])],
    ['a block header cut short', frame([0x20, 3], Buffer.from([0x19, 0x00]))],
    ['a block payload cut short', frame([0x20, 10], blockHeader(true, RAW_BLOCK, 10), Buffer.from('abc'))],
    ['a content checksum cut short', compress('lost\n', withChecksum).subarray(0, -2)],
  ] as const)('stops at %s and keeps the complete frame before it', (_tail, tail) => {
    const first = compress('kept\n')
    const buffer = Buffer.concat([first, tail])

    expect(scanZstdFrames(buffer)).toEqual([{ start: 0, end: first.length }])
    const decoded = decompressFrames(buffer)
    expect(decoded.text.toString()).toBe('kept\n')
    expect(decoded.consumedBytes).toBe(first.length)
  })

  it('finds no frame in an empty buffer or in bytes that are not zstd', () => {
    expect(scanZstdFrames(Buffer.alloc(0))).toEqual([])
    expect(scanZstdFrames(Buffer.from('{"type":"plain"}\n'))).toEqual([])
  })
})

describe('decompressFrames', () => {
  it('stops at a frame whose content fails to decode and reports only the bytes before it', () => {
    const good = compress('one\n')
    const corrupt = Buffer.from(compress('two\n', withChecksum))
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 0xff
    const after = compress('three\n')
    const buffer = Buffer.concat([good, corrupt, after])

    // The scan measures all three frames; only decoding detects the checksum mismatch.
    expect(scanZstdFrames(buffer)).toHaveLength(3)
    const decoded = decompressFrames(buffer)
    expect(decoded.text.toString()).toBe('one\n')
    expect(decoded.consumedBytes).toBe(good.length)
  })
})

describe('decompressConcatenatedZstd', () => {
  it('returns the plaintext of every complete frame and ignores a torn final frame', () => {
    const buffer = Buffer.concat([compress('a\n'), compress('b\n'), compress('c\n').subarray(0, -3)])

    expect(decompressConcatenatedZstd(buffer).toString()).toBe('a\nb\n')
  })
})
