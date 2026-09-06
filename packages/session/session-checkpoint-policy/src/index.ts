/**
 * Semantic durability checkpoints for model requests, top-level tool dispatch,
 * and completed agent steps.
 * @module @neo/dsh-session-checkpoint-policy
 */

import type { Context } from '@neo/cordis'
import { isDurabilitySuspended } from '@neo/dsh-session'
import type { Session } from '@neo/dsh-session'
import type { StreamChunk } from '@neo/dsh-llm'
import { TOOL_ABORTED_BEFORE_DISPATCH, type ToolExecutionResult } from '@neo/dsh-tools'
import type { PreStepDecision } from '@neo/dsh-agent'
import type {} from '@neo/dsh-session-persistence'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'session-checkpoint-policy'

/** Services whose request, tool, session, and persistence boundaries this policy joins. */
export const inject = ['llm', 'sessionPersistence', 'sessions', 'tools']

/**
 * Delay construction of the downstream model stream until the complete logged
 * request prefix is durable. A checkpoint rejection prevents adapter dispatch.
 *
 * @param checkpoint - the fail-closed-or-proceed session checkpoint.
 * @param session - live session named by the model request.
 * @param next - downstream `llm/stream` chain.
 * @returns a stream that checkpoints before requesting its first chunk.
 */
function afterCheckpoint(
  checkpoint: (session: Session) => Promise<void>,
  session: Session,
  next: () => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncIterable<StreamChunk> {
    await checkpoint(session)
    yield* next()
  })()
}

/** Materialize the canonical result for a call cancelled before tool dispatch. */
function abortedBeforeDispatchResult(): ToolExecutionResult {
  return {
    content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
    isError: true,
    error: {
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    },
  }
}

/**
 * Install semantic checkpoint listeners. Loop-built model calls checkpoint the
 * logged request before adapter dispatch; top-level tool calls checkpoint their
 * recorded call before the tool body; the next request boundary checkpoints
 * the preceding response/result batch. Nested tool dispatches reuse the durable outer call.
 *
 * Checkpoint failures are fail-closed at the model and tool side-effect
 * boundaries: the downstream adapter or tool body is not invoked.
 *
 * @param ctx - plugin context that owns the listeners.
 */
export function apply(ctx: Context): void {
  const checkpoint = (session: Session): Promise<void> => flushOrProceed(ctx, session)

  ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    if (options.sessionId === undefined) return next()
    const session = ctx.sessions.get(options.sessionId)
    return session === undefined ? next() : afterCheckpoint(checkpoint, session, next)
  })

  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    if (exec.agent === undefined || exec.parent !== undefined) return next()
    await checkpoint(exec.agent.session)
    if (exec.signal.aborted) return abortedBeforeDispatchResult()
    return next()
  })

  // Before each request, persist everything committed by the preceding step;
  // the first step's call is an intentional no-op beyond any prompt intake.
  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    await checkpoint(agent.session)
    return next()
  })
}

const warnedSuspended = new WeakSet<Session>()

/**
 * Checkpoint one session, staying fail-closed on transient failures. A backend
 * that suspended the session's durability rejects with a typed error: failing
 * every later boundary would turn one lost batch into a dead session, so the
 * boundary proceeds non-durably and says so once per session.
 * @param ctx - plugin context owning the session store.
 * @param session - the session to checkpoint.
 */
async function flushOrProceed(ctx: Context, session: Session): Promise<void> {
  try {
    await ctx.sessions.flush(session)
  } catch (error: unknown) {
    if (!isDurabilitySuspended(error)) throw error
    if (warnedSuspended.has(session)) return
    warnedSuspended.add(session)
    ctx.logger.warn(`session "${session.id}": durability suspended; continuing without persistence: ${String(error)}`)
  }
}
