import { describe, expect, it } from 'vitest'
import { sanitizeText } from '../src/sanitize.ts'

const NUL = String.fromCharCode(0)
const BEL = String.fromCharCode(7)
const VT = String.fromCharCode(11)
const ESC = String.fromCharCode(27)

describe('outgoing text sanitisation', () => {
  it('drops the C0 controls that truncate a multimodal prompt', () => {
    expect(sanitizeText(`peer${NUL}slot`)).toBe('peerslot')
    expect(sanitizeText(`${BEL}${VT}${ESC}`)).toBe('')
  })

  it('keeps tab, line feed and carriage return', () => {
    expect(sanitizeText('a\tb\nc\r\nd')).toBe('a\tb\nc\r\nd')
  })

  it('returns clean text unchanged', () => {
    expect(sanitizeText('plain output')).toBe('plain output')
    expect(sanitizeText('')).toBe('')
  })
})
