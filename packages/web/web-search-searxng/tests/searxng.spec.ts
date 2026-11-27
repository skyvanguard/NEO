import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { Context } from '@neo/cordis'
import WebRuntime, { WebError } from '@neo/web'
import {
  SEARXNG_DEFAULT_BASE_URL,
  SEARXNG_DEFAULT_MAX_RESULTS,
  SEARXNG_DEFAULT_TIMEOUT_MS,
  SEARXNG_PROVIDER_ID,
  SearxngSearchProvider,
  mapSearxngResponse,
} from '@neo/web-search-searxng'
import * as searxngPlugin from '@neo/web-search-searxng'

/** The provider calls the global `fetch(URL, init)`. */
type FetchImpl = (input: URL, init: RequestInit) => Promise<Response>
type SearxngPayload = Parameters<typeof mapSearxngResponse>[0]

const BASE_URL = 'http://searx.test:8888'
const options = { baseURL: BASE_URL, maxResults: 10, timeoutMs: 1000 }

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

/** `count` SearXNG rows carrying only a url: `https://r1.test`, `https://r2.test`, … */
function urlRows(count: number): { url: string }[] {
  return Array.from({ length: count }, (_, index) => ({ url: `https://r${index + 1}.test` }))
}

function stubFetch(impl: FetchImpl): Mock<FetchImpl> {
  const fetchMock = vi.fn<FetchImpl>(impl)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function requestAt(fetchMock: Mock<FetchImpl>, index = 0): [URL, RequestInit] {
  const call = fetchMock.mock.calls[index]
  if (call === undefined) throw new Error(`fetch call ${index} was not made`)
  return call
}

function endpointOf(url: URL): string {
  return `${url.origin}${url.pathname}`
}

function signalOf(init: RequestInit): AbortSignal {
  if (!(init.signal instanceof AbortSignal)) throw new Error('fetch was called without an AbortSignal')
  return init.signal
}

/** Resolve with the WebError a search rejected with; the handler attaches immediately, before any timer advance. */
async function rejectionOf(pending: Promise<unknown>): Promise<WebError> {
  const failure = await pending.then(() => undefined, (error: unknown) => error)
  if (!(failure instanceof WebError)) throw new Error(`expected a WebError rejection, got ${String(failure)}`)
  return failure
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** Settle the way fetch does on cancellation: reject with the request signal's reason once it aborts. */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    // `reason` is typed `any`; fetch rejects with it verbatim (a DOMException AbortError for a bare abort()).
    if (signal.aborted) {
      reject(signal.reason as Error)
      return
    }
    signal.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
  })
}

/**
 * A 200 response that sends a partial JSON chunk and then stalls until the
 * request signal aborts, which errors the body stream as fetch does.
 * `onRead` fires when the provider starts reading the body with `json()`.
 */
function stalledBodyResponse(signal: AbortSignal, onRead: () => void): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"results":['))
      signal.addEventListener('abort', () => { controller.error(signal.reason) }, { once: true })
    },
  })
  class ObservedResponse extends Response {
    override json(): Promise<unknown> {
      onRead()
      return super.json()
    }
  }
  return new ObservedResponse(body, { status: 200, headers: { 'content-type': 'application/json' } })
}

/** A root context running the web seam pinned to this provider id. */
async function webContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { searchProvider: SEARXNG_PROVIDER_ID })
  return ctx
}

/**
 * Start one seam search against a fetch that hangs until aborted, and report
 * whether the request is still live just before and exactly at `timeoutMs`.
 */
async function timeoutWindowOf(ctx: Context, timeoutMs: number): Promise<{ liveBefore: boolean; failure: WebError }> {
  vi.useFakeTimers()
  const fetchMock = stubFetch((_url, init) => rejectOnAbort(signalOf(init)))
  const outcome = rejectionOf(ctx.web.search({ query: 'q' }))
  await vi.advanceTimersByTimeAsync(0)
  const requestSignal = signalOf(requestAt(fetchMock)[1])
  await vi.advanceTimersByTimeAsync(timeoutMs - 1)
  const liveBefore = !requestSignal.aborted
  await vi.advanceTimersByTimeAsync(1)
  return { liveBefore, failure: await outcome }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('mapSearxngResponse', () => {
  it('maps url, title, content and publishedDate to a source', () => {
    expect(mapSearxngResponse({
      results: [{ url: 'https://a.test', title: 'A', content: 'about A', publishedDate: '2026-02-02T00:00:00' }],
    }, 10)).toEqual({
      sources: [{ url: 'https://a.test', title: 'A', snippet: 'about A', publishedAt: '2026-02-02T00:00:00' }],
      truncated: false,
    })
  })

  it('drops rows whose url is missing, empty, or not a string', () => {
    const payload = {
      results: [
        { title: 'no url' },
        { url: '', title: 'empty url' },
        { url: 42, title: 'numeric url' },
        { url: 'https://kept.test' },
      ],
    } as unknown as SearxngPayload
    expect(mapSearxngResponse(payload, 10).sources).toEqual([{ url: 'https://kept.test' }])
  })

  it('omits optional fields that are absent, null, or empty', () => {
    const payload = {
      results: [
        { url: 'https://absent.test' },
        { url: 'https://null.test', title: null, content: null, publishedDate: null },
        { url: 'https://empty.test', title: '', content: '', publishedDate: '' },
      ],
    } as unknown as SearxngPayload
    expect(mapSearxngResponse(payload, 10).sources).toEqual([
      { url: 'https://absent.test' },
      { url: 'https://null.test' },
      { url: 'https://empty.test' },
    ])
  })

  it('treats a response without a results array as no sources', () => {
    expect(mapSearxngResponse({}, 10)).toEqual({ sources: [], truncated: false })
  })

  it('stops at the provider-side limit, counting only kept rows, and leaves truncation to the seam', () => {
    const result = mapSearxngResponse({
      results: [{ url: 'https://r1.test' }, { url: '' }, { url: 'https://r2.test' }, { url: 'https://r3.test' }],
    }, 2)
    expect(result).toEqual({ sources: [{ url: 'https://r1.test' }, { url: 'https://r2.test' }], truncated: false })
  })
})

describe('SearxngSearchProvider availability', () => {
  it('is available with a parseable base URL and a positive integer cap', () => {
    const provider = new SearxngSearchProvider(options)
    expect(provider.id).toBe(SEARXNG_PROVIDER_ID)
    expect(provider.available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(new SearxngSearchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  // `localhost:8888` parses, with the scheme `localhost:`; neither it nor a
  // non-HTTP scheme can serve the JSON API.
  it.each(['localhost:8888', '127.0.0.1:8888', 'ftp://searx.test'])('is misconfigured when the base URL %s is not http(s)', (baseURL) => {
    expect(new SearxngSearchProvider({ ...options, baseURL }).available()).toBe(false)
  })

  it('accepts an https base URL', () => {
    expect(new SearxngSearchProvider({ ...options, baseURL: 'https://searx.test' }).available()).toBe(true)
  })

  it.each([0, -3, 2.5, Number.NaN])('is misconfigured when maxResults is %s', (maxResults) => {
    expect(new SearxngSearchProvider({ ...options, maxResults }).available()).toBe(false)
  })
})

describe('SearxngSearchProvider request', () => {
  it('sends one GET to /search with the query, format=json, a JSON accept header, and redirects refused', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({
      results: [{ url: 'https://a.test', title: 'A', content: 'about A' }],
    }))

    const result = await new SearxngSearchProvider(options).search({ query: 'nmap os detection' })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = requestAt(fetchMock)
    expect(endpointOf(url)).toBe('http://searx.test:8888/search')
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'nmap os detection', format: 'json' })
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.redirect).toBe('error')
    expect(init.headers).toEqual({ accept: 'application/json' })
    expect(result).toEqual({ sources: [{ url: 'https://a.test', title: 'A', snippet: 'about A' }], truncated: false })
  })

  it.each([
    ['http://searx.test:8888/', 'http://searx.test:8888/search'],
    ['https://proxy.test/searxng', 'https://proxy.test/searxng/search'],
    ['https://proxy.test/searxng/', 'https://proxy.test/searxng/search'],
    ['https://proxy.test/tools/searxng//', 'https://proxy.test/tools/searxng/search'],
    // A base that already names the endpoint is not doubled.
    ['http://searx.test:8888/search', 'http://searx.test:8888/search'],
    ['https://proxy.test/searxng/search/', 'https://proxy.test/searxng/search'],
  ])('appends /search to the base URL path %s, keeping a reverse-proxy prefix', async (baseURL, expected) => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    await new SearxngSearchProvider({ ...options, baseURL }).search({ query: 'q' })
    const [url] = requestAt(fetchMock)
    expect(endpointOf(url)).toBe(expected)
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'q', format: 'json' })
  })

  it('rejects a non-http(s) base URL with a provider error before any request', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    const failure = await rejectionOf(new SearxngSearchProvider({ ...options, baseURL: 'localhost:8888' }).search({ query: 'q' }))
    expect(failure).toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'SearXNG baseURL must be an absolute http(s) URL' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps credentials in a rejected base URL out of the error', async () => {
    const failure = await rejectionOf(new SearxngSearchProvider({ ...options, baseURL: 'ftp://operator:hunter2@searx.test' }).search({ query: 'q' }))
    expect(failure.message).not.toContain('hunter2')
  })

  it('caps sources at the configured maxResults when the request omits one', async () => {
    stubFetch(async () => jsonResponse({ results: urlRows(5) }))
    const result = await new SearxngSearchProvider({ ...options, maxResults: 3 }).search({ query: 'q' })
    expect(result.sources.map(source => source.url)).toEqual(['https://r1.test', 'https://r2.test', 'https://r3.test'])
  })

  it('lets the request maxResults replace the configured cap in both directions', async () => {
    stubFetch(async () => jsonResponse({ results: urlRows(5) }))
    const provider = new SearxngSearchProvider({ ...options, maxResults: 3 })
    expect((await provider.search({ query: 'q', maxResults: 4 })).sources).toHaveLength(4)
    expect((await provider.search({ query: 'q', maxResults: 1 })).sources).toEqual([{ url: 'https://r1.test' }])
  })

  it('releases the timeout timer once the search settles', async () => {
    vi.useFakeTimers()
    stubFetch(async () => jsonResponse({ results: [] }))
    await new SearxngSearchProvider(options).search({ query: 'q' })
    expect(vi.getTimerCount()).toBe(0)

    stubFetch(async () => new Response('down', { status: 502 }))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' })).rejects.toThrow('SearXNG returned HTTP 502')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops following the caller signal once the search settles', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    const caller = new AbortController()
    await new SearxngSearchProvider(options).search({ query: 'q' }, caller.signal)
    const requestSignal = signalOf(requestAt(fetchMock)[1])
    expect(requestSignal).not.toBe(caller.signal)

    caller.abort(new Error('late cancel'))
    expect(requestSignal.aborted).toBe(false)
  })
})

describe('SearxngSearchProvider errors', () => {
  it('maps a non-OK HTTP status to WEB_PROVIDER_ERROR', async () => {
    stubFetch(async () => new Response('Service Unavailable', { status: 503 }))
    const failure = await rejectionOf(new SearxngSearchProvider(options).search({ query: 'q' }))
    expect(failure).toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'SearXNG returned HTTP 503' })
  })

  it('maps a network failure to WEB_PROVIDER_ERROR and keeps the failure as the cause', async () => {
    const networkFailure = new TypeError('fetch failed')
    stubFetch(() => Promise.reject(networkFailure))
    const failure = await rejectionOf(new SearxngSearchProvider(options).search({ query: 'q' }))
    expect(failure).toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'SearXNG search request failed: TypeError: fetch failed' })
    expect(failure.cause).toBe(networkFailure)
  })

  it('keeps a network failure a provider error while the caller signal is still live', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')))
    const failure = await rejectionOf(new SearxngSearchProvider(options).search({ query: 'q' }, new AbortController().signal))
    expect(failure.code).toBe('WEB_PROVIDER_ERROR')
  })

  it('maps a non-JSON success body to WEB_PROVIDER_ERROR naming the settings.yml json format switch', async () => {
    stubFetch(async () => new Response('<!doctype html><title>SearXNG</title>', { status: 200, headers: { 'content-type': 'text/html' } }))
    const failure = await rejectionOf(new SearxngSearchProvider(options).search({ query: 'q' }, new AbortController().signal))
    expect(failure).toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'SearXNG returned a non-JSON body; enable the `json` format in the instance settings.yml (search.formats)',
    })
    expect(failure.cause).toBeInstanceOf(SyntaxError)
  })
})

describe('SearxngSearchProvider cancellation', () => {
  it('rejects with WEB_ABORTED carrying the caller reason when the signal is already aborted', async () => {
    const reason = new Error('operator cancelled')
    const caller = new AbortController()
    caller.abort(reason)
    let abortedAtCall: boolean | undefined
    stubFetch((_url, init) => {
      abortedAtCall = signalOf(init).aborted
      return rejectOnAbort(signalOf(init))
    })

    const failure = await rejectionOf(new SearxngSearchProvider(options).search({ query: 'q' }, caller.signal))
    expect(failure).toMatchObject({ code: 'WEB_ABORTED', message: 'SearXNG search aborted' })
    expect(failure.cause).toBe(reason)
    expect(abortedAtCall).toBe(true)
  })

  it('aborts the in-flight request when the caller aborts mid-request', async () => {
    const reason = new Error('operator cancelled')
    const caller = new AbortController()
    const fetchMock = stubFetch((_url, init) => rejectOnAbort(signalOf(init)))

    const outcome = rejectionOf(new SearxngSearchProvider(options).search({ query: 'q' }, caller.signal))
    const requestSignal = signalOf(requestAt(fetchMock)[1])
    expect(requestSignal.aborted).toBe(false)
    caller.abort(reason)

    const failure = await outcome
    expect(failure.code).toBe('WEB_ABORTED')
    expect(failure.cause).toBe(reason)
    expect(requestSignal.aborted).toBe(true)
  })

  it('aborts a stalled body read when the caller aborts mid-body', async () => {
    const reason = new Error('operator cancelled')
    const caller = new AbortController()
    const bodyRead = deferred()
    stubFetch(async (_url, init) => stalledBodyResponse(signalOf(init), bodyRead.resolve))

    const outcome = rejectionOf(new SearxngSearchProvider(options).search({ query: 'q' }, caller.signal))
    await bodyRead.promise
    caller.abort(reason)

    const failure = await outcome
    expect(failure.code).toBe('WEB_ABORTED')
    expect(failure.cause).toBe(reason)
  })

  it('fails with WEB_PROVIDER_ERROR, not WEB_ABORTED, when the wall-clock timeout fires before a response', async () => {
    vi.useFakeTimers()
    const fetchMock = stubFetch((_url, init) => rejectOnAbort(signalOf(init)))
    const caller = new AbortController()

    const outcome = rejectionOf(new SearxngSearchProvider({ ...options, timeoutMs: 1000 }).search({ query: 'q' }, caller.signal))
    const requestSignal = signalOf(requestAt(fetchMock)[1])

    await vi.advanceTimersByTimeAsync(999)
    expect(requestSignal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(requestSignal.aborted).toBe(true)

    const failure = await outcome
    expect(failure).toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'SearXNG search timed out after 1000 ms' })
    expect(failure.cause).toMatchObject({ name: 'AbortError' })
    expect(caller.signal.aborted).toBe(false)
  })

  it('bounds a stalled body read with the wall-clock timeout and names the timeout, not a non-JSON body', async () => {
    vi.useFakeTimers()
    const bodyRead = deferred()
    stubFetch(async (_url, init) => stalledBodyResponse(signalOf(init), bodyRead.resolve))

    const outcome = rejectionOf(new SearxngSearchProvider({ ...options, timeoutMs: 1000 }).search({ query: 'q' }))
    await bodyRead.promise
    await vi.advanceTimersByTimeAsync(1000)

    const failure = await outcome
    expect(failure).toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'SearXNG search timed out after 1000 ms' })
    expect(failure.cause).toMatchObject({ name: 'AbortError' })
  })
})

describe('web-search-searxng plugin', () => {
  it('names itself for loader diagnostics and injects the web seam (namespace plugin, no default export)', () => {
    expect(searxngPlugin.name).toBe('web-search-searxng')
    expect(searxngPlugin.inject).toEqual(['web'])
    expect('default' in searxngPlugin).toBe(false)
  })

  it('fills every Config default from an empty config', () => {
    expect(searxngPlugin.Config({})).toEqual({
      baseURL: SEARXNG_DEFAULT_BASE_URL,
      maxResults: SEARXNG_DEFAULT_MAX_RESULTS,
      timeoutMs: SEARXNG_DEFAULT_TIMEOUT_MS,
    })
    expect([SEARXNG_DEFAULT_BASE_URL, SEARXNG_DEFAULT_MAX_RESULTS, SEARXNG_DEFAULT_TIMEOUT_MS])
      .toEqual(['http://127.0.0.1:8888', 10, 15000])
  })

  it('keeps valid Config overrides', () => {
    expect(searxngPlugin.Config({ baseURL: BASE_URL, maxResults: 3, timeoutMs: 500 }))
      .toEqual({ baseURL: BASE_URL, maxResults: 3, timeoutMs: 500 })
  })

  it.each([
    [{ maxResults: 0 }, 'maxResults'],
    [{ maxResults: 2.5 }, 'maxResults'],
    [{ timeoutMs: 0 }, 'timeoutMs'],
    [{ timeoutMs: 1.5 }, 'timeoutMs'],
    [{ baseURL: 42 }, 'baseURL'],
  ])('rejects the invalid Config %j at its field', (config, field) => {
    expect(() => searxngPlugin.Config(config as never)).toThrow(new RegExp(`^\\$\\.${field} `))
  })

  it('registers the provider into ctx.web with the schema defaults and unregisters it on dispose', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: urlRows(12) }))
    const ctx = await webContext()
    const fiber = await ctx.plugin(searxngPlugin, {})

    const result = await ctx.web.search({ query: 'q' })
    expect(endpointOf(requestAt(fetchMock)[0])).toBe('http://127.0.0.1:8888/search')
    expect(result.sources).toHaveLength(SEARXNG_DEFAULT_MAX_RESULTS)

    await fiber.dispose()
    const failure = await rejectionOf(ctx.web.search({ query: 'q' }))
    expect(failure.code).toBe('WEB_PROVIDER_CONFIGURED_MISSING')
  })

  it('threads baseURL and maxResults config into the registered provider', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: urlRows(5) }))
    const ctx = await webContext()
    await ctx.plugin(searxngPlugin, { baseURL: BASE_URL, maxResults: 2 })

    const result = await ctx.web.search({ query: 'q' })
    expect(endpointOf(requestAt(fetchMock)[0])).toBe('http://searx.test:8888/search')
    expect(result.sources.map(source => source.url)).toEqual(['https://r1.test', 'https://r2.test'])
  })

  it('reports a scheme-less configured baseURL as an unavailable provider, not a raw URL TypeError', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    const ctx = await webContext()
    await ctx.plugin(searxngPlugin, { baseURL: 'localhost:8888' })

    const failure = await rejectionOf(ctx.web.search({ query: 'q' }))
    expect(failure.code).toBe('WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('threads timeoutMs config into the registered provider', async () => {
    const ctx = await webContext()
    await ctx.plugin(searxngPlugin, { baseURL: BASE_URL, timeoutMs: 50 })

    const { liveBefore, failure } = await timeoutWindowOf(ctx, 50)
    expect(liveBefore).toBe(true)
    expect(failure.code).toBe('WEB_PROVIDER_ERROR')
  })

  it('fills the base URL and cap defaults itself when apply is handed an unresolved config', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: urlRows(12) }))
    const ctx = await webContext()
    searxngPlugin.apply(ctx, {})

    const result = await ctx.web.search({ query: 'q' })
    expect(endpointOf(requestAt(fetchMock)[0])).toBe('http://127.0.0.1:8888/search')
    expect(result.sources).toHaveLength(SEARXNG_DEFAULT_MAX_RESULTS)
  })

  it('fills the timeout default itself when apply is handed an unresolved config', async () => {
    const ctx = await webContext()
    searxngPlugin.apply(ctx, {})

    const { liveBefore, failure } = await timeoutWindowOf(ctx, SEARXNG_DEFAULT_TIMEOUT_MS)
    expect(liveBefore).toBe(true)
    expect(failure.code).toBe('WEB_PROVIDER_ERROR')
  })
})
