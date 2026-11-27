/**
 * Session-log fixtures shared by the usage-stats specs: usage-bearing events
 * and real multi-frame zstd session logs written to disk.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import type { TokenUsage } from '@neo/llm'
import type { SessionEvent } from '@neo/session'

/** Epoch milliseconds of an ISO timestamp. */
export const t = (iso: string): number => Date.parse(iso)

/** A finalized assistant message reporting `usage` for (turn, step). */
export function msg(turn: number, step: number, iso: string, usage: TokenUsage): SessionEvent {
  return { type: 'assistant/message', seq: step, time: t(iso), data: { turn, step, message: {}, usage } } as unknown as SessionEvent
}

/** A streamed usage chunk reporting `usage` for (turn, step). */
export function chunk(turn: number, step: number, iso: string, usage: TokenUsage): SessionEvent {
  return { type: 'assistant/chunk', seq: step, time: t(iso), data: { turn, step, chunk: { type: 'usage', usage } } } as unknown as SessionEvent
}

/** One independently decodable zstd frame holding one JSONL event line. */
export function frameOf(event: SessionEvent): Buffer {
  return zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`))
}

/**
 * Write `<root>/<ws>/<id>/session.jsonl.zstd` as one zstd frame per event — the
 * concatenated-frame layout the persistence backend appends.
 * @returns the session-log path.
 */
export function writeSession(root: string, ws: string, id: string, events: readonly SessionEvent[]): string {
  const dir = join(root, ws, id)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'session.jsonl.zstd')
  writeFileSync(path, Buffer.concat(events.map(frameOf)))
  return path
}
