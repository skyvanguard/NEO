import { describe, expect, it } from 'vitest'
import { isAppendSurfaceEvent } from '@neo/session'
import type { SessionEvent } from '@neo/session'
import { MESSAGE_TYPES, paginate } from '../src/paginate.ts'

/**
 * Reference implementation: the ORIGINAL paginate logic (copy + filter + filter).
 * The optimized `paginate` must be output-identical to this across every input;
 * this spec is the differential proof of that equivalence.
 */
function referencePaginate(
  events: readonly SessionEvent[],
  beforeSeq: number | undefined,
  maxMessages: number,
): { events: SessionEvent[]; hasMore: boolean } {
  const window = beforeSeq === undefined ? [...events] : events.filter(event => event.seq < beforeSeq)
  let count = 0
  let cut = 0
  for (let i = window.length - 1; i >= 0; i--) {
    const event = window[i] as SessionEvent
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    count++
    const sources = (event as { sourceEventSeqs?: number[] }).sourceEventSeqs
    const groupStart = sources !== undefined && sources.length > 0 ? Math.min(event.seq, ...sources) : event.seq
    if (count >= maxMessages) {
      cut = groupStart
      break
    }
  }
  const page = window.filter(event => event.seq >= cut)
  return { events: page, hasMore: cut > 0 }
}

// Event shapes exercising each predicate branch. 'assistant/message' with
// surfaceOp 'append' is a countable message; the others are excluded.
type Shape = 'msg' | 'msg-replace' | 'chunk' | 'grouped'

function makeEvent(seq: number, shape: Shape): SessionEvent {
  switch (shape) {
    case 'msg':
      return { type: 'assistant/message', seq, surfaceOp: 'append' } as unknown as SessionEvent
    case 'msg-replace':
      return { type: 'assistant/message', seq, surfaceOp: 'replace' } as unknown as SessionEvent
    case 'chunk':
      return { type: 'assistant/chunk', seq, surfaceOp: 'append' } as unknown as SessionEvent
    case 'grouped':
      // A message whose group starts earlier via sourceEventSeqs (never cut mid-message).
      return { type: 'user/message', seq, surfaceOp: 'append', sourceEventSeqs: [seq - 1, seq] } as unknown as SessionEvent
  }
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('paginate (optimized) equals the reference across random and edge inputs', () => {
  it('confirms the test events actually exercise the message path', () => {
    expect(isAppendSurfaceEvent(makeEvent(3, 'msg'))).toBe(true)
    expect(isAppendSurfaceEvent(makeEvent(3, 'msg-replace'))).toBe(false)
    expect(isAppendSurfaceEvent(makeEvent(3, 'chunk'))).toBe(false)
  })

  it('matches the reference on 400 randomized event streams', () => {
    const rng = mulberry32(0x51ff)
    const shapes: Shape[] = ['msg', 'msg-replace', 'chunk', 'grouped']
    for (let trial = 0; trial < 400; trial++) {
      const length = Math.floor(rng() * 40)
      const events: SessionEvent[] = []
      for (let seq = 0; seq < length; seq++) {
        events.push(makeEvent(seq, shapes[Math.floor(rng() * shapes.length)]!))
      }
      const maxMessages = 1 + Math.floor(rng() * 8)
      // undefined tail, and a spread of beforeSeq values including out-of-range.
      const cursors: (number | undefined)[] = [undefined, 0, 1, Math.floor(rng() * (length + 2)), length, length + 5]
      for (const beforeSeq of cursors) {
        const optimized = paginate(events, beforeSeq, maxMessages)
        const reference = referencePaginate(events, beforeSeq, maxMessages)
        const label = `trial=${trial} len=${length} max=${maxMessages} before=${String(beforeSeq)}`
        expect(optimized.hasMore, `hasMore ${label}`).toBe(reference.hasMore)
        expect(optimized.events.map(e => e.seq), `seqs ${label}`).toEqual(reference.events.map(e => e.seq))
      }
    }
  })

  it('handles empty and all-non-message windows', () => {
    expect(paginate([], undefined, 5)).toEqual({ events: [], hasMore: false })
    const noMsgs = [makeEvent(0, 'chunk'), makeEvent(1, 'chunk')]
    const out = paginate(noMsgs, undefined, 1)
    expect(out.hasMore).toBe(false)
    expect(out.events.map(e => e.seq)).toEqual([0, 1])
  })

  it('never cuts mid-message: keeps a group whose start precedes the cut point', () => {
    const events = [makeEvent(0, 'msg'), makeEvent(1, 'grouped'), makeEvent(2, 'grouped')]
    // maxMessages=1 → the oldest kept message is seq 2, whose group starts at seq 1.
    const out = paginate(events, undefined, 1)
    expect(out.events.map(e => e.seq)).toEqual([1, 2])
    expect(out.hasMore).toBe(true)
  })
})
