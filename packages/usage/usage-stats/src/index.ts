/**
 * Cross-session token-usage statistics, exposed to the browser client over
 * Typert Remote. Aggregates provider-reported usage from every persisted
 * session log so the UI can show cumulative consumption (like a usage page),
 * running in Node where it can read and decompress the session store.
 * @module @neo/usage-stats
 */

import type { Context } from '@neo/cordis'
import { neoHomePath } from '@neo/home-paths'
import { TypertRemoteService, Remote } from '@neo/typert-protocol'
import { aggregateUsage } from './aggregate.ts'
import type { UsageCache } from './aggregate.ts'
import type { UsageSummary, UsageSummaryRequest } from './types.ts'

export type * from './types.ts'
export { aggregateUsage, foldSessionUsage, readSessionEvents, workspaceLabel } from './aggregate.ts'
export type { UsageCache } from './aggregate.ts'

declare module '@neo/cordis' {
  interface Context {
    usageStats: UsageStatsService
  }
}

/** Cordis Service exposing one Remote method: `usage.summary`. */
export class UsageStatsService extends TypertRemoteService {
  /**
   * Per-session fold cache, persisted across `summary` calls so each request
   * re-reads only the logs that changed since the last one — the usage view's
   * recurring open cost drops from "decompress the whole history" to
   * "re-fold the active session(s)".
   */
  private readonly usageCache: UsageCache = new Map()

  constructor(ctx: Context) {
    super(ctx, 'usage')
  }

  /**
   * Compute cumulative token usage across every persisted session.
   * @param request - optional filters (e.g. a since-time).
   * @returns the cumulative usage summary.
   */
  @Remote('summary')
  async summary(request: UsageSummaryRequest): Promise<UsageSummary> {
    return aggregateUsage(neoHomePath('sessions'), request, this.usageCache)
  }
}

export default UsageStatsService
