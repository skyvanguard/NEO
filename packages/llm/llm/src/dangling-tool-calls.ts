/**
 * Provider-side reconciliation of tool calls that never received a result.
 *
 * A crash, a scheduler failure or an older harness version can leave an
 * assistant tool call in the durable history with no matching tool result.
 * Providers reject such a transcript on every request, so the session stays
 * dead for good — and the durable log cannot be edited in place. Closing the
 * gap at conversion time keeps the log untouched while every request stays
 * valid; the synthetic result tells the model plainly that the outcome is
 * unknown.
 *
 * @module @neo/dsh-llm/dangling-tool-calls
 */

import type { CallId } from './brand.ts'
import { createToolResultMessage } from './message.ts'
import type { Message } from './types.ts'

/** Marker text every synthetic result carries, so consumers can recognise it. */
export const TOOL_RESULT_MISSING = 'No result was recorded for this tool call.'

const MISSING_RESULT_TEXT = `${TOOL_RESULT_MISSING} Its outcome is unknown: retry it only if the operation is read-only or idempotent; otherwise verify external state first.`

/** Tool call ids carried by one assistant message, in model order. */
function toolCallIds(message: Message): CallId[] {
  return message.content.flatMap(block => block.type === 'tool-call' ? [block.id] : [])
}

/** Call ids answered by one user message's tool-result blocks. */
function answeredCallIds(message: Message): CallId[] {
  return message.content.flatMap(block => block.type === 'tool-result' ? [block.toolCallId] : [])
}

/**
 * Insert an error tool result for every assistant tool call that no later
 * message answers before the next assistant message. Returns the input array
 * itself when nothing is missing, so callers can keep identity checks cheap.
 * @param messages - derived model-visible history, in transcript order.
 * @returns the same history with synthetic results placed right after the assistant message that opened each unanswered call.
 */
export function closeDanglingToolCalls(messages: readonly Message[]): readonly Message[] {
  const closed: Message[] = []
  let changed = false
  for (let index = 0; index < messages.length; index++) {
    // Loop bound guarantees the index; the assertion is spelled out for the linter.
    const message = messages[index] as Message
    closed.push(message)
    if (message.role !== 'assistant') continue
    const open = new Set(toolCallIds(message))
    if (open.size === 0) continue
    for (let next = index + 1; next < messages.length && open.size > 0; next++) {
      const later = messages[next] as Message
      if (later.role === 'assistant') break
      for (const callId of answeredCallIds(later)) open.delete(callId)
    }
    for (const callId of open) {
      changed = true
      closed.push(createToolResultMessage({
        callId,
        content: [{ type: 'text', text: MISSING_RESULT_TEXT }],
        isError: true,
      }))
    }
  }
  return changed ? closed : messages
}
