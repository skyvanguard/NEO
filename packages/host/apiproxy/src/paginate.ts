/**
 * Message-boundary pagination for session history.
 * @module @deepseek-ai/dsh-host-apiproxy/paginate
 */

import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Event types that count as a reader-visible message for paging. */
export const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/**
 * Message-boundary pagination: count `maxMessages` append-origin messages
 * backwards from the window tail. Replacement copies never entered the
 * conversation a reader sees — they restate a shadowed range for the model
 * alone — so they consume no quota; the page stays one contiguous raw range,
 * which keeps a compaction's log-only `compaction/summary` record on the same page as its
 * replacement. The cut is the starting seq of the oldest message group (chunks
 * group via sourceEventSeqs — never cut mid-message). The tail page naturally
 * includes the in-progress partial.
 *
 * `events` is the seq-ascending log (or a seq-ascending prefix of it). The scan
 * is O(page + log n): a binary search bounds the `seq < beforeSeq` prefix, then
 * a single backward walk collects the page — never a full copy/filter of the
 * whole log, so back-pagination over a long session stays linear overall
 * instead of quadratic.
 *
 * @param events - seq-ascending session events.
 * @param beforeSeq - exclusive upper seq bound (a "load older" cursor), or undefined for the tail.
 * @param maxMessages - messages per page.
 * @returns the page events and whether older events precede it.
 */
export function paginate(
  events: readonly SessionEvent[],
  beforeSeq: number | undefined,
  maxMessages: number,
): { events: SessionEvent[]; hasMore: boolean } {
  // Every index below is provably in range; the ?? guards the type only under
  // noUncheckedIndexedAccess and is never taken at runtime.
  /* v8 ignore next -- see above; index is always in [0, length). */
  const seqAt = (index: number): number => events[index]?.seq ?? 0
  // Events are seq-ascending, so "seq < beforeSeq" is the prefix [0, hi).
  let hi = events.length
  if (beforeSeq !== undefined) {
    let lo = 0
    let high = events.length
    while (lo < high) {
      const mid = (lo + high) >>> 1
      if (seqAt(mid) < beforeSeq) lo = mid + 1
      else high = mid
    }
    hi = lo
  }
  // cutSeq is the oldest kept group's starting seq (0 when the page reaches the
  // window start); cutIndex is its position. Both stay 0 when fewer than
  // maxMessages messages exist, yielding the whole window with hasMore=false —
  // identical to filtering `seq >= 0`.
  let cutSeq = 0
  let cutIndex = 0
  let count = 0
  for (let i = hi - 1; i >= 0; i--) {
    const event = events[i]
    /* v8 ignore next -- i is always in [0, hi) ⊂ [0, length). */
    if (event === undefined) continue
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    count++
    if (count >= maxMessages) {
      const sources = (event as { sourceEventSeqs?: number[] }).sourceEventSeqs
      cutSeq = sources !== undefined && sources.length > 0 ? Math.min(event.seq, ...sources) : event.seq
      // Include every earlier window event still in this group (seq >= cutSeq):
      // a contiguous run, since events are seq-ascending.
      cutIndex = i
      while (cutIndex > 0 && seqAt(cutIndex - 1) >= cutSeq) cutIndex--
      break
    }
  }
  return { events: events.slice(cutIndex, hi), hasMore: cutSeq > 0 }
}
