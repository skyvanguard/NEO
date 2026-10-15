/**
 * Browser-safe background-job domain contract. The registry's live records
 * never cross the wire; a view is the subset a human list needs, minted fresh
 * per push.
 */

import type { JobId } from '@neo/jobs/brand'
import type { SessionId } from '@neo/session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/**
 * One background job as the client sees it.
 *
 * Three registry fields are deliberately absent. `ownerSession` is redundant
 * beside the frame's own `sessionId`; `reported` is an internal notice-delivery
 * bit with no user meaning; `outputLimitBytes` is producer-owned model
 * presentation policy that never reaches a human surface.
 */
export interface JobView {
  /** Registry-issued `<kind>-N` identity, stable for the task's whole life. */
  id: JobId
  /**
   * Producer kind (`bash`, `pwsh`, `pty-send`, `subagent`, …). Kept as a bare
   * string because producer plugins extend the kind map by declaration merging,
   * so no client build can enumerate the closed set.
   */
  kind: string
  /** Producer-supplied one-line label: the command, or the delegation description. */
  label: string
  /** Current lifecycle state. */
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  /** Kind-specific status detail ('exit code: 3'), present once the producer supplied one. */
  detail?: string
  /** Epoch ms when the task was registered. */
  startedAt: number
  /** Epoch ms when the task settled; absent while live. */
  finishedAt?: number
}

/** Outcome of a kill request: live work was asked to stop, or it had already finished. */
export type JobKillOutcome = 'requested' | 'already-finished'

/**
 * Background-job RPC surface. The read side stays a `session/jobs` push view;
 * the only verb is a user-initiated stop.
 */
export interface JobsApi {
  /**
   * Stop a running job the requesting session owns. Unlike the model's own
   * `job_kill`, a user stop delivers a completion notice to the model so it
   * learns the job was cancelled rather than still running. Foreign or unknown
   * jobs are refused.
   */
  kill(
    request: RpcRequest<{ sessionId: SessionId; jobId: JobId; reason?: string }>,
  ): Promise<RpcResponse<{ outcome: JobKillOutcome }>>
}
