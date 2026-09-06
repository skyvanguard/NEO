/**
 * The one way a `session/flush` listener may say "I am no longer persisting
 * this session" without pretending the flush succeeded.
 *
 * A durability backend that gave up on a session (its retained batch could
 * not land after repeated attempts, and later seqs must stay contiguous
 * behind it) has two bad options at the next flush: reject with the original
 * I/O error, which makes every request boundary fail forever, or resolve,
 * which lets callers that demand confirmed durability believe they got it.
 * Rejecting with this typed error lets each caller decide: a request
 * checkpoint may proceed non-durably, while a schedule or an export must
 * report the outcome as uncertain.
 *
 * @module @neo/dsh-session/durability
 */

/** Stable code carried by {@link DurabilitySuspendedError}. */
export const DURABILITY_SUSPENDED = 'DURABILITY_SUSPENDED'

/** Rejection of `session/flush` by a backend that stopped persisting the session. */
export class DurabilitySuspendedError extends Error {
  override readonly name = 'DurabilitySuspendedError'
  readonly code = DURABILITY_SUSPENDED

  /**
   * @param sessionId - the session whose durability was suspended.
   * @param cause - the repeated write failure that led to the suspension.
   */
  constructor(sessionId: string, cause?: unknown) {
    super(
      `session "${sessionId}": durability suspended after repeated write failures; `
      + 'events since then are not persisted',
      cause === undefined ? undefined : { cause },
    )
  }
}

/**
 * Whether a flush rejection means "not persisting any more" rather than a
 * transient failure, across package boundaries (the error may cross a
 * serialization seam and arrive as a plain object carrying the code).
 * @param error - the rejection to classify.
 * @returns true when the rejection carries the suspension code.
 */
export function isDurabilitySuspended(error: unknown): boolean {
  return error instanceof DurabilitySuspendedError
    || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === DURABILITY_SUSPENDED)
}
