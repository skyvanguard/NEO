/**
 * Public vocabulary for cross-session token-usage aggregation. Types only, no
 * Node imports, so the generated Remote client can consume it in the browser.
 * @module @neo/usage-stats/types
 */

/** Summed token counts (provider-reported), plus the number of requests. */
export interface UsageTotals {
  /** Uncached input (prompt) tokens. */
  readonly inputTokens: number
  /** Generated output tokens. */
  readonly outputTokens: number
  /** Tokens served from the provider prompt cache. */
  readonly cacheReadTokens: number
  /** Tokens written to the provider prompt cache. */
  readonly cacheWriteTokens: number
  /** Reasoning/thinking tokens (subset of output for some providers). */
  readonly reasoningTokens: number
  /** Number of model requests that reported usage. */
  readonly requests: number
}

/** One calendar day's usage (UTC `YYYY-MM-DD`). */
export interface UsageDayBucket {
  readonly day: string
  readonly totals: UsageTotals
}

/** One workspace's usage. */
export interface UsageWorkspaceBucket {
  readonly workspace: string
  readonly totals: UsageTotals
}

/** One session's usage row. */
export interface UsageSessionRow {
  readonly sessionId: string
  readonly workspace: string
  /** Epoch milliseconds of the last request that reported usage. */
  readonly lastActive: number
  readonly totals: UsageTotals
}

/** The cumulative usage summary across every persisted session. */
export interface UsageSummary {
  /** Grand totals across all sessions. */
  readonly totals: UsageTotals
  /** Number of sessions that reported any usage. */
  readonly sessionCount: number
  /** Per-day totals, ascending by day. */
  readonly byDay: readonly UsageDayBucket[]
  /** Per-workspace totals, descending by output tokens. */
  readonly byWorkspace: readonly UsageWorkspaceBucket[]
  /** Per-session rows, descending by last activity (capped). */
  readonly sessions: readonly UsageSessionRow[]
  /** Epoch milliseconds when this summary was computed. */
  readonly generatedAt: number
}

/** Optional filters for a usage summary. */
export interface UsageSummaryRequest {
  /** Only include sessions last active at or after this epoch-ms time. */
  readonly sinceMs?: number
}
