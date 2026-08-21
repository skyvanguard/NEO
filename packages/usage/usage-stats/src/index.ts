/**
 * Cross-session token-usage statistics, exposed to the browser client over
 * Typert Remote. Aggregates provider-reported usage from every persisted
 * session log so the UI can show cumulative consumption (like a usage page),
 * running in Node where it can read and decompress the session store.
 * @module @deepseek-ai/dsh-usage-stats
 */

import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { aggregateUsage } from './aggregate.ts'
import type { UsageSummary, UsageSummaryRequest } from './types.ts'

export type * from './types.ts'
export { aggregateUsage, foldSessionUsage, readSessionEvents, workspaceLabel } from './aggregate.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    usageStats: UsageStatsService
  }
}

/** Cordis Service exposing one Remote method: `usage.summary`. */
export class UsageStatsService extends TypertRemoteService {
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
    return aggregateUsage(dshHomePath('sessions'), request)
  }
}

export default UsageStatsService
