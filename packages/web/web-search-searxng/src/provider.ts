/**
 * SearXNG-backed local search: one GET to a self-hosted instance's `format=json`
 * API. No API key and no model turn — a metasearch call against infrastructure
 * the operator controls, so reconnaissance queries never leave for a cloud
 * search vendor under the operator's identity.
 * @module @neo/web-search-searxng/provider
 */

import { WebError } from '@neo/web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@neo/web'

/** Stable id this provider registers under. */
export const SEARXNG_PROVIDER_ID = 'searxng'

/** Default endpoint: a SearXNG instance on loopback. `/search` is appended. */
export const SEARXNG_DEFAULT_BASE_URL = 'http://127.0.0.1:8888'

/** Default upper bound on returned sources when the request omits one. */
export const SEARXNG_DEFAULT_MAX_RESULTS = 10

/** Default per-search wall-clock timeout in milliseconds. */
export const SEARXNG_DEFAULT_TIMEOUT_MS = 15000

/** Resolved provider options (the plugin's `apply` supplies constant defaults). */
export interface SearxngSearchProviderOptions {
  /** Instance base URL; `/search` is appended. */
  readonly baseURL: string
  /** Provider-side result cap; the seam still enforces the request's `maxResults`. */
  readonly maxResults: number
  /** Per-search wall-clock timeout in milliseconds. */
  readonly timeoutMs: number
}

/** One row of SearXNG's `format=json` `results[]`. */
interface SearxngResultRow {
  readonly url?: string
  readonly title?: string
  readonly content?: string
  readonly publishedDate?: string
}

/** The subset of SearXNG's JSON response this provider reads. */
interface SearxngResponse {
  readonly results?: readonly SearxngResultRow[]
}

/**
 * Map a SearXNG JSON response to normalized sources. Rows without a usable URL
 * are dropped; `content` becomes the snippet and `publishedDate` the timestamp.
 * The seam owns the final `maxResults` truncation, so `truncated` is always
 * false; `limit` here is only the provider-side cap.
 * @param payload - the parsed SearXNG response.
 * @param limit - provider-side cap applied before the seam's own truncation.
 * @returns the normalized result.
 */
export function mapSearxngResponse(payload: SearxngResponse, limit: number): WebSearchResult {
  const sources: WebSearchSource[] = []
  for (const row of payload.results ?? []) {
    if (typeof row.url !== 'string' || row.url.length === 0) continue
    sources.push({
      url: row.url,
      ...row.title != null && row.title.length > 0 ? { title: row.title } : {},
      ...row.content != null && row.content.length > 0 ? { snippet: row.content } : {},
      ...row.publishedDate != null && row.publishedDate.length > 0 ? { publishedAt: row.publishedDate } : {},
    })
    if (sources.length >= limit) break
  }
  return { sources, truncated: false }
}

/** The SearXNG-backed local search provider. */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  constructor(private readonly options: SearxngSearchProviderOptions) {}

  available(): boolean {
    // Cheap local check per contract (no network call): a parseable base URL.
    return URL.canParse(this.options.baseURL) && isPositiveInteger(this.options.maxResults)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const limit = request.maxResults ?? this.options.maxResults
    const endpoint = new URL('/search', this.options.baseURL)
    endpoint.searchParams.set('q', request.query)
    endpoint.searchParams.set('format', 'json')

    // Compose caller cancellation with a wall-clock timeout on one controller.
    // The controller, timer, and listener stay live through the body read
    // (`response.json`), so a slow/hung body or a mid-read cancel is bounded
    // rather than an indefinite hang — the cleanup runs only in the outer finally.
    const controller = new AbortController()
    const onAbort = (): void => { controller.abort() }
    if (signal !== undefined) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = setTimeout(() => { controller.abort() }, this.options.timeoutMs)

    try {
      let response: Response
      try {
        response = await fetch(endpoint, {
          redirect: 'error',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        })
      } catch (error: unknown) {
        if (signal?.aborted === true) throw searchAborted(signal, error)
        throw new WebError(`SearXNG search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
      }

      if (!response.ok) {
        throw new WebError(`SearXNG returned HTTP ${response.status}`, 'WEB_PROVIDER_ERROR')
      }
      try {
        const payload = await response.json() as SearxngResponse
        return mapSearxngResponse(payload, limit)
      } catch (error: unknown) {
        if (signal?.aborted === true) throw searchAborted(signal, error)
        throw new WebError(
          'SearXNG returned a non-JSON body; enable the `json` format in the instance settings.yml (search.formats)',
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }
    } finally {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('SearXNG search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a positive integer bound. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
