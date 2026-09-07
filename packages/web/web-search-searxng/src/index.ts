/**
 * Register a SearXNG-backed local search provider in `ctx.web`. It queries a
 * self-hosted SearXNG instance's `format=json` API — no API key and no model
 * turn — so reconnaissance search stays on operator-controlled infrastructure.
 * @module @neo/web-search-searxng
 */

import type { Context } from '@neo/cordis'
import z from '@neo/schemastery'
import type {} from '@neo/web'
import {
  SearxngSearchProvider,
  SEARXNG_DEFAULT_BASE_URL,
  SEARXNG_DEFAULT_MAX_RESULTS,
  SEARXNG_DEFAULT_TIMEOUT_MS,
} from './provider.ts'

export {
  SearxngSearchProvider,
  SEARXNG_DEFAULT_BASE_URL,
  SEARXNG_DEFAULT_MAX_RESULTS,
  SEARXNG_DEFAULT_TIMEOUT_MS,
  SEARXNG_PROVIDER_ID,
  mapSearxngResponse,
} from './provider.ts'
export type { SearxngSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searxng'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills constant defaults). */
export interface Config {
  /** SearXNG instance base URL; `/search` is appended. */
  baseURL?: string
  /** Provider-side result cap; the seam still enforces the request's `maxResults`. */
  maxResults?: number
  /** Per-search wall-clock timeout in milliseconds. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  baseURL: z.string().default(SEARXNG_DEFAULT_BASE_URL),
  maxResults: z.number().step(1).min(1).default(SEARXNG_DEFAULT_MAX_RESULTS),
  timeoutMs: z.number().step(1).min(1).default(SEARXNG_DEFAULT_TIMEOUT_MS),
})

/** Register the SearXNG search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new SearxngSearchProvider({
    baseURL: config.baseURL ?? SEARXNG_DEFAULT_BASE_URL,
    maxResults: config.maxResults ?? SEARXNG_DEFAULT_MAX_RESULTS,
    timeoutMs: config.timeoutMs ?? SEARXNG_DEFAULT_TIMEOUT_MS,
  }))
}
