/**
 * Safe HTTP(S) retrieval for `ctx.web`: validates URLs, follows only same-origin redirects,
 * enforces time and size limits, classifies and decodes text, and leaves presentation to
 * `@neo/tool-web`. Requests carry no browser cookies or ambient credentials.
 *
 * SSRF protection: every hop's target is checked against a deny-list of private /
 * loopback / link-local / reserved ranges (see isBlockedAddress). A literal-IP host is
 * refused up front; a DNS name is pinned at connect time by a dedicated undici dispatcher
 * (see guardedLookup) that validates the exact address the socket will use, closing the
 * DNS-rebinding window. The worker's kernel egress filter (scan-worker/harden-deploy.sh),
 * whose deny-list mirrors isBlockedAddress, remains the last line of defense.
 * Set allowPrivateAddresses to opt out (e.g. a loopback test server).
 * @module @neo/web-fetch-http/provider
 */

import { WebError } from '@neo/web'
import type { WebFetchBody, WebFetchProvider, WebFetchRequest, WebFetchResult } from '@neo/web'
import { deadline, timeoutOf } from '@neo/timeout'
import net from 'node:net'
import { lookup } from 'node:dns/promises'
import { lookup as lookupCb } from 'node:dns'
import type { LookupAddress, LookupOptions } from 'node:dns'
import { Agent } from 'undici'
import { classifyContentType, decoderForCharset, isBlockedAddress, isSameOrigin, parseCharset, validateFetchUrl } from './policy.ts'

/** Resolved provider limits (the plugin's schemastery Config supplies defaults). */
export interface HttpFetchLimits {
  /** Maximum accepted request URL length. */
  maxUrlLength: number
  /** Maximum response body size in bytes (read is aborted past this). */
  maxResponseBytes: number
  /** Maximum decoded body length in characters (truncated past this). */
  maxBodyChars: number
  /** Default fetch timeout in milliseconds. */
  timeoutMs: number
  /** Maximum number of (same-origin) redirect hops to follow. */
  maxRedirects: number
  /** `User-Agent` header sent on every request. */
  userAgent: string
  /** When true, skip the private/reserved-address guard (e.g. a loopback test server). */
  allowPrivateAddresses: boolean
}

/** Stable id this provider registers under. */
export const LOCAL_FETCH_PROVIDER_ID = 'http'

/** The anonymous public HTTP(S) fetch provider. */
export class HttpFetchProvider implements WebFetchProvider {
  readonly id = LOCAL_FETCH_PROVIDER_ID

  /**
   * When the private-address guard is active, a dedicated undici dispatcher pins
   * every connection to a validated resolved IP (see {@link guardedLookup}),
   * closing the DNS-rebinding window. Left undefined under `allowPrivateAddresses`
   * so `fetch` uses the default global dispatcher.
   */
  private readonly dispatcher: Agent | undefined

  constructor(private readonly limits: HttpFetchLimits) {
    this.dispatcher = limits.allowPrivateAddresses
      ? undefined
      : new Agent({ connect: { lookup: guardedLookup } })
  }

  /** No credentials to check — an anonymous public fetcher is always usable. */
  available(): boolean {
    return true
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')

    // One signal stops both the request and body read. The deadline's TimeoutReason later
    // distinguishes this provider's timeout from caller or outer-deadline cancellation.
    using d = deadline(signal, this.limits.timeoutMs, 'WEB_FETCH_TIMEOUT')
    return await this.followAndRead(request.url, d.signal)
  }

  /** Follow same-origin redirects up to the hop cap, then read the final response. */
  private async followAndRead(initialUrl: string, signal: AbortSignal): Promise<WebFetchResult> {
    let currentUrl = validateFetchUrl(initialUrl, this.limits.maxUrlLength)
    let redirectsFollowed = 0

    for (;;) {
      await this.assertHostAllowed(currentUrl, signal)
      const response = await this.requestOnce(currentUrl, signal)

      if (isRedirectStatus(response.status)) {
        // Enforce the redirect budget before resolving or validating the next hop.
        if (redirectsFollowed >= this.limits.maxRedirects) {
          await response.body?.cancel()
          throw new WebError(`exceeded the maximum of ${this.limits.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
        }
        const location = response.headers.get('location')
        if (location === null) {
          // A redirect status with no Location is not a usable resource. Cancel
          // the (possibly streaming) body before throwing so no socket leaks.
          await response.body?.cancel()
          throw new WebError(`redirect response (HTTP ${response.status}) without a Location header`, 'WEB_PROVIDER_ERROR')
        }
        const target = resolveRedirect(location, currentUrl)
        // Re-validate the target against the same transport hygiene a direct request gets: a
        // redirect must not be a back door to a credentialed, non-http(s), or over-long URL
        // that validateFetchUrl would reject.
        let validatedTarget: URL
        try {
          validatedTarget = validateFetchUrl(target.toString(), this.limits.maxUrlLength)
          if (!isSameOrigin(validatedTarget, currentUrl)) {
            throw new WebError(
              `cross-origin redirect to ${validatedTarget.origin} is not followed automatically; retry against that URL directly`,
              'WEB_REDIRECT_BLOCKED',
            )
          }
        } catch (error: unknown) {
          await response.body?.cancel()
          throw error
        }
        await response.body?.cancel()
        currentUrl = validatedTarget
        redirectsFollowed++
        continue
      }

      return await this.readBody(response, currentUrl, signal)
    }
  }

  /**
   * Pre-flight refusal of a target that points at an internal/reserved address:
   * a literal-IP host is classified directly (no DNS), and a hostname is resolved
   * and every answer classified, so the common case fails fast with a clear
   * WEB_BLOCKED_URL before any connection. This is not the race-free layer — the
   * pinned dispatcher (guardedLookup) validates the exact connect-time address and
   * closes the rebinding window — but it gives an early, precise error and covers
   * literal IPs, which the connector's lookup never sees. Opted out by
   * `allowPrivateAddresses`.
   */
  private async assertHostAllowed(url: URL, signal: AbortSignal): Promise<void> {
    if (this.limits.allowPrivateAddresses) return
    // URL hostnames keep IPv6 in brackets; strip them for classification/lookup.
    const host = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname
    if (net.isIP(host) !== 0) {
      if (isBlockedAddress(host)) {
        throw new WebError(`refusing to fetch a private or reserved address: ${host}`, 'WEB_BLOCKED_URL')
      }
      return
    }
    signal.throwIfAborted()
    let addresses: { address: string }[]
    try {
      addresses = await lookup(host, { all: true })
    } catch (error: unknown) {
      /* v8 ignore next -- a lookup rejection racing an already-aborted signal; the resolve-failure path is tested. */
      if (signal.aborted) throw translateAbortOrNetwork(error, signal)
      throw new WebError(`could not resolve host "${host}"`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    for (const { address } of addresses) {
      if (isBlockedAddress(address)) {
        throw new WebError(`host "${host}" resolves to a private or reserved address (${address})`, 'WEB_BLOCKED_URL')
      }
    }
  }

  private async requestOnce(url: URL, signal: AbortSignal): Promise<Response> {
    try {
      return await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': this.limits.userAgent, 'accept': 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8' },
        signal,
        ...this.dispatcher === undefined ? {} : { dispatcher: this.dispatcher },
      })
    } catch (error: unknown) {
      // A blocked address rejects the connection with our WebError on the cause
      // chain (undici wraps the connector's lookup error): surface it verbatim
      // so the guard reads as WEB_BLOCKED_URL, not a generic network failure.
      const blocked = webErrorCause(error)
      if (blocked !== undefined) throw blocked
      throw translateAbortOrNetwork(error, signal)
    }
  }

  /** Read, byte-cap, classify, and decode the final response body. */
  private async readBody(response: Response, finalUrl: URL, signal: AbortSignal): Promise<WebFetchResult> {
    const contentType = response.headers.get('content-type')
    const kind = classifyContentType(contentType)
    if (kind === undefined) {
      await response.body?.cancel()
      throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }

    // Resolve the decoder BEFORE reading the body so an unsupported charset
    // fails without consuming the stream — but cancel the body on that failure
    // so the socket does not leak (matching the unsupported-content-type path).
    let decoder: TextDecoder
    try {
      decoder = decoderForCharset(parseCharset(contentType))
    } catch (error: unknown) {
      await response.body?.cancel()
      throw error
    }
    const { bytes, truncatedByBytes } = await this.readCapped(response, signal)
    const decoded = decoder.decode(bytes)
    const truncatedByChars = decoded.length > this.limits.maxBodyChars
    const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded
    const body: WebFetchBody = kind === 'html' ? { kind: 'html', content } : { kind: 'text', content }

    return {
      url: finalUrl.toString(),
      statusCode: response.status,
      body,
      truncated: truncatedByBytes || truncatedByChars,
    }
  }

  /**
   * Read the response stream up to `maxResponseBytes`. A `Content-Length` over
   * the cap rejects immediately with `WEB_FETCH_TOO_LARGE`; a stream that grows
   * past the cap is cut short (`truncatedByBytes`) rather than rejected, so a
   * server that under-reports still yields a bounded usable body.
   */
  private async readCapped(response: Response, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncatedByBytes: boolean }> {
    const declared = response.headers.get('content-length')
    if (declared !== null) {
      const length = Number(declared)
      if (Number.isFinite(length) && length > this.limits.maxResponseBytes) {
        await response.body?.cancel()
        throw new WebError(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
      }
    }

    /* v8 ignore next -- a 2xx Response from fetch always exposes a body stream; the null guard is defensive. */
    if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false }

    const chunks: Uint8Array[] = []
    let total = 0
    let truncatedByBytes = false
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const remaining = this.limits.maxResponseBytes - total
        // Only DROPPED bytes count as truncation: a chunk that exactly fills the
        // remaining capacity keeps all its bytes and we read on to observe EOF,
        // so an exactly-at-cap body is not falsely flagged truncated.
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining))
          total += remaining
          truncatedByBytes = true
          break
        }
        chunks.push(value)
        total += value.byteLength
      }
    } catch (error: unknown) {
      /* v8 ignore next -- mid-stream read fault needs a network drop after headers; translate path covered by request-phase tests. */
      throw translateAbortOrNetwork(error, signal)
    } finally {
      /* v8 ignore next 4 -- cancel() after a completed/broken read settles without rejecting; unobserved best-effort cleanup. */
      await reader.cancel().catch(() => {
        // Cancel after a successful read (or after we broke past the cap) is
        // best-effort cleanup; the bytes we need are already collected.
      })
    }

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, truncatedByBytes }
  }
}

/**
 * A DNS lookup for the fetch connector that pins the connection to a validated
 * address: it resolves EVERY answer and refuses (via the callback error) if any
 * is a private/reserved address (see {@link isBlockedAddress}). Because undici
 * connects to exactly the address this lookup returns, there is no gap between
 * validation and connect — this closes the DNS-rebinding window the standalone
 * pre-flight check cannot. A WebError `WEB_BLOCKED_URL` surfaces on the fetch
 * rejection's `cause`, recovered by {@link webErrorCause}.
 *
 * @param hostname - the host undici is about to connect to.
 * @param options - node lookup options supplied by the connector.
 * @param callback - node lookup callback; called with the validated addresses
 *   or a blocking error.
 */
export function guardedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: string | LookupAddress[], family?: number) => void,
): void {
  lookupCb(hostname, { ...options, all: true }, (error, addresses) => {
    if (error !== null) {
      callback(error, [])
      return
    }
    const blocked = addresses.find(entry => isBlockedAddress(entry.address))
    if (blocked !== undefined) {
      callback(
        new WebError(`host "${hostname}" resolves to a private or reserved address (${blocked.address})`, 'WEB_BLOCKED_URL'),
        [],
      )
      return
    }
    callback(null, addresses)
  })
}

/** Walk an error's `cause` chain for a WebError (undici wraps a lookup rejection). */
function webErrorCause(error: unknown): WebError | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current instanceof WebError) return current
    current = current.cause
  }
  return undefined
}

/** HTTP redirect status codes that carry a `Location`. */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** Resolve a (possibly relative) `Location` against the current URL. */
function resolveRedirect(location: string, base: URL): URL {
  try {
    return new URL(location, base)
  } catch (error: unknown) {
    /* v8 ignore next 2 -- URL resolution against a valid absolute base effectively never throws; defensive guard. */
    throw new WebError(`invalid redirect Location "${location}"`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

/**
 * Translate a thrown fetch/stream error into a `WebError`, classified by the
 * deadline signal rather than the thrown value (which differs by phase: the
 * request-phase `fetch` rejects with the abort reason, while the read-phase
 * reader surfaces a bare `AbortError`). `timeoutOf(signal, 'WEB_FETCH_TIMEOUT')`
 * recovering OUR reason means our timeout fired (`WEB_FETCH_TIMEOUT`); any other
 * abort — an upstream cancel, or a foreign/outer deadline's timeout under
 * nesting — is `WEB_ABORTED`; a throw with the signal NOT aborted is a
 * transport/network failure (`WEB_PROVIDER_ERROR`).
 */
function translateAbortOrNetwork(error: unknown, signal: AbortSignal): WebError {
  const timeout = timeoutOf(signal, 'WEB_FETCH_TIMEOUT')
  if (timeout !== undefined) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: timeout })
  if (signal.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  return new WebError(`web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}
