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
import { aggregateUsage, loadUsageCache, saveUsageCache } from './aggregate.ts'
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
   * Per-session fold cache, reused across `summary` calls so each request
   * re-reads only the logs that changed since the last one, and PERSISTED to
   * disk ({@link cacheFile}) so it survives a restart — without persistence the
   * first `summary` after every reboot pays a full cold decompress of the whole
   * session history (tens of seconds on a large store).
   */
  private readonly usageCache: UsageCache = new Map()

  /** Set once the on-disk cache has been merged in; guards the one-time load. */
  private cacheLoad: Promise<void> | undefined

  constructor(ctx: Context) {
    super(ctx, 'usage')
  }

  /** Path of the persisted usage cache under the resolved NEO home. */
  private cacheFile(): string {
    return neoHomePath('.usage-cache.json')
  }

  /** Merge the persisted cache into the in-memory one, exactly once. */
  private ensureLoaded(): Promise<void> {
    this.cacheLoad ??= loadUsageCache(this.cacheFile()).then((disk) => {
      for (const [path, entry] of disk) if (!this.usageCache.has(path)) this.usageCache.set(path, entry)
    })
    return this.cacheLoad
  }

  /**
   * Compute cumulative token usage across every persisted session.
   * @param request - optional filters (e.g. a since-time).
   * @returns the cumulative usage summary.
   */
  @Remote('summary')
  async summary(request: UsageSummaryRequest): Promise<UsageSummary> {
    await this.ensureLoaded()
    const summary = await aggregateUsage(neoHomePath('sessions'), request, this.usageCache)
    await saveUsageCache(this.cacheFile(), this.usageCache)
    return summary
  }
}

export default UsageStatsService
