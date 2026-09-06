import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lookup } from 'node:dns/promises'
import { lookup as lookupCb } from 'node:dns'
import { guardedLookup } from '../src/provider.ts'

// Typed handle over the mocked node:dns callback lookup (undici's pinned connector uses it).
type DnsCb = (err: Error | null, addrs: { address: string; family: number }[]) => void
const dnsCbMock = vi.mocked(lookupCb as unknown as (host: string, opts: object, cb: DnsCb) => void)

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
vi.mock('node:dns', () => ({ lookup: vi.fn() }))
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { Context } from '@neo/cordis'
import WebRuntime from '@neo/dsh-web'
import { HttpFetchProvider, LOCAL_FETCH_PROVIDER_ID } from '@neo/dsh-web-fetch-http'
import type { HttpFetchLimits } from '@neo/dsh-web-fetch-http'
import * as fetchPlugin from '@neo/dsh-web-fetch-http'
import { classifyContentType, decoderForCharset, isBlockedAddress, isSameOrigin, parseCharset, validateFetchUrl } from '../src/policy.ts'

const limits: HttpFetchLimits = {
  maxUrlLength: 2048,
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 5_000,
  maxRedirects: 5,
  userAgent: 'test-agent/1.0',
  // The test server lives on 127.0.0.1; the harness opts in so the guard does
  // not block it. Production defaults to allowPrivateAddresses:false.
  allowPrivateAddresses: true,
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void

let server: Server
let base: string
let handler: Handler

beforeEach(async () => {
  handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('default') }
  server = createServer((req, res) => { handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await new Promise<void>(resolve => server.close(() => { resolve() }))
})

function provider(overrides: Partial<HttpFetchLimits> = {}): HttpFetchProvider {
  return new HttpFetchProvider({ ...limits, ...overrides })
}

describe('policy helpers', () => {
  it('validates scheme, credentials, and length', () => {
    expect(validateFetchUrl('https://example.com/x', 2048).hostname).toBe('example.com')
    expect(() => validateFetchUrl('ftp://example.com', 2048)).toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    expect(() => validateFetchUrl('not a url', 2048)).toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    expect(() => validateFetchUrl('https://user:pass@example.com', 2048)).toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    expect(() => validateFetchUrl(`https://example.com/${'a'.repeat(3000)}`, 2048)).toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
  })

  it('classifies content types', () => {
    expect(classifyContentType('text/html; charset=utf-8')).toBe('html')
    expect(classifyContentType('application/xhtml+xml')).toBe('html')
    expect(classifyContentType('text/plain')).toBe('text')
    expect(classifyContentType('application/json')).toBe('text')
    expect(classifyContentType('image/png')).toBeUndefined()
    expect(classifyContentType(null)).toBeUndefined()
  })

  it('compares origins', () => {
    expect(isSameOrigin(new URL('https://a.com/x'), new URL('https://a.com/y'))).toBe(true)
    expect(isSameOrigin(new URL('https://a.com'), new URL('https://b.com'))).toBe(false)
    expect(isSameOrigin(new URL('http://a.com'), new URL('https://a.com'))).toBe(false)
  })

  it('parses the charset parameter', () => {
    expect(parseCharset('text/html; charset=UTF-8')).toBe('utf-8')
    expect(parseCharset('text/plain; charset="iso-8859-1"')).toBe('iso-8859-1')
    expect(parseCharset('text/plain')).toBeUndefined()
    expect(parseCharset(null)).toBeUndefined()
  })

  it('builds a decoder for a charset and defaults to UTF-8', () => {
    expect(decoderForCharset(undefined).encoding).toBe('utf-8')
    expect(decoderForCharset('iso-8859-1').encoding).toBe('windows-1252')
    expect(() => decoderForCharset('not-a-charset')).toThrow(expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }))
  })

  it('flags private, loopback, link-local, and reserved IPv4 literals', () => {
    for (const blocked of [
      '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
      '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.168.1.1', '198.18.0.1',
      '224.0.0.1', '240.0.0.1', '255.255.255.255',
    ]) expect(isBlockedAddress(blocked), blocked).toBe(true)
  })

  it('allows public IPv4 literals', () => {
    for (const ok of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '199.36.158.100', '223.255.255.255']) {
      expect(isBlockedAddress(ok), ok).toBe(false)
    }
  })

  it('flags internal IPv6 literals including embedded IPv4', () => {
    for (const blocked of [
      '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '64:ff9b::127.0.0.1', '::7f00:1',
      '2002:7f00:0001::1', '2002:c0a8:0101::1', '0:0:0:0:0:0:0:1',
      'fe80::1%eth0',
    ]) expect(isBlockedAddress(blocked), blocked).toBe(true)
  })

  it('allows public IPv6 literals and returns false for hostnames', () => {
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false)
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false)
    expect(isBlockedAddress('2002:0808:0808::1')).toBe(false)
    expect(isBlockedAddress('::808:808')).toBe(false)
    expect(isBlockedAddress('example.com')).toBe(false)
    expect(isBlockedAddress('not-an-ip')).toBe(false)
    expect(isBlockedAddress('256.256.256.256')).toBe(false)
  })
})

describe('HttpFetchProvider success', () => {
  it('fetches a text body', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello world') }
    const result = await provider().fetch({ url: base })
    expect(provider().available()).toBe(true)
    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual({ kind: 'text', content: 'hello world' })
    expect(result.truncated).toBe(false)
  })

  it('fetches an html body and classifies it as html', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>hi</h1>') }
    const result = await provider().fetch({ url: base })
    expect(result.body).toEqual({ kind: 'html', content: '<h1>hi</h1>' })
  })

  it('sends the configured user agent', async () => {
    let seen: string | undefined
    handler = (req, res) => { seen = req.headers['user-agent']; res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok') }
    await provider().fetch({ url: base })
    expect(seen).toBe('test-agent/1.0')
  })

  it('returns a non-2xx response as a result, not an error', async () => {
    handler = (_req, res) => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope') }
    const result = await provider().fetch({ url: base })
    expect(result.statusCode).toBe(404)
    expect(result.body).toEqual({ kind: 'text', content: 'nope' })
  })
})

describe('HttpFetchProvider caps', () => {
  it('rejects an over-cap Content-Length with WEB_FETCH_TOO_LARGE', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '999999' }); res.end('x'.repeat(999999)) }
    await expect(provider({ maxResponseBytes: 10 }).fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_FETCH_TOO_LARGE' }))
  })

  it('truncates a stream that grows past the byte cap', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('abcdefghij') }
    const result = await provider({ maxResponseBytes: 4 }).fetch({ url: base })
    expect(result.body.content).toBe('abcd')
    expect(result.truncated).toBe(true)
  })

  it('does not flag a body that exactly fills the byte cap as truncated', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('abcd') }
    const result = await provider({ maxResponseBytes: 4 }).fetch({ url: base })
    expect(result.body.content).toBe('abcd')
    expect(result.truncated).toBe(false)
  })

  it('truncates a decoded body past the character cap', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('abcdefghij') }
    const result = await provider({ maxBodyChars: 3 }).fetch({ url: base })
    expect(result.body.content).toBe('abc')
    expect(result.truncated).toBe(true)
  })

  it('rejects an unsupported content type', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end('binary') }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }))
  })

  it('rejects a response with no content type at all', async () => {
    handler = (_req, res) => { res.writeHead(200); res.end('no type') }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }))
  })

  it('accepts a declared content-length within the cap', async () => {
    handler = (_req, res) => { const body = 'sized'; res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(body.length) }); res.end(body) }
    const result = await provider().fetch({ url: base })
    expect(result.body.content).toBe('sized')
  })

  it('decodes a non-UTF-8 declared charset', async () => {
    // 0xE9 is "é" in ISO-8859-1; decoded as UTF-8 it would be a replacement char.
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain; charset=iso-8859-1' }); res.end(Buffer.from([0x63, 0x61, 0x66, 0xE9])) }
    const result = await provider().fetch({ url: base })
    expect(result.body.content).toBe('café')
  })

  it('rejects an unsupported declared charset', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain; charset=not-a-charset' }); res.end('x') }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }))
  })
})

describe('HttpFetchProvider redirects', () => {
  it('follows a same-origin redirect and reports the final URL', async () => {
    handler = (req, res) => {
      if (req.url === '/start') { res.writeHead(302, { location: '/end' }); res.end() }
      else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('arrived') }
    }
    const result = await provider().fetch({ url: `${base}/start` })
    expect(result.body.content).toBe('arrived')
    expect(result.url).toBe(`${base}/end`)
  })

  it('blocks a cross-origin redirect with WEB_REDIRECT_BLOCKED', async () => {
    handler = (_req, res) => { res.writeHead(302, { location: 'https://example.com/' }); res.end() }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
  })

  it('re-validates a redirect target, rejecting same-origin credentials in the Location', async () => {
    const { port } = server.address() as AddressInfo
    handler = (_req, res) => { res.writeHead(302, { location: `http://user:pass@127.0.0.1:${port}/` }); res.end() }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('rejects exceeding the redirect hop cap', async () => {
    handler = (req, res) => {
      const n = Number(new URL(req.url ?? '/', base).searchParams.get('n') ?? '0')
      res.writeHead(302, { location: `/?n=${n + 1}` })
      res.end()
    }
    await expect(provider({ maxRedirects: 2 }).fetch({ url: `${base}/?n=0` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
  })

  it('follows exactly maxRedirects hops: a chain landing on the Nth redirect succeeds', async () => {
    // maxRedirects: 2 → /?n=0 → /?n=1 → /?n=2(200). Exactly 2 redirects + 1
    // final = 3 requests; the cap is inclusive of the landing request.
    let requests = 0
    handler = (req, res) => {
      requests++
      const n = Number(new URL(req.url ?? '/', base).searchParams.get('n') ?? '0')
      if (n >= 2) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('landed') }
      else { res.writeHead(302, { location: `/?n=${n + 1}` }); res.end() }
    }
    const result = await provider({ maxRedirects: 2 }).fetch({ url: `${base}/?n=0` })
    expect(result.body.content).toBe('landed')
    expect(requests).toBe(3)
  })

  it('makes exactly maxRedirects+1 requests before blocking an over-long chain', async () => {
    // maxRedirects: 2 on an infinite chain: requests at n=0,1,2 (the 3rd is the
    // over-limit redirect, refused before its Location is followed) = 3 total.
    let requests = 0
    handler = (req, res) => {
      requests++
      const n = Number(new URL(req.url ?? '/', base).searchParams.get('n') ?? '0')
      res.writeHead(302, { location: `/?n=${n + 1}` })
      res.end()
    }
    await expect(provider({ maxRedirects: 2 }).fetch({ url: `${base}/?n=0` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED', message: 'exceeded the maximum of 2 redirects' }))
    expect(requests).toBe(3)
  })

  it('reports an over-limit redirect as "exceeded", not cross-origin, even when the over-limit hop points cross-origin', async () => {
    // The redirect budget is checked BEFORE the over-limit hop's target is
    // origin-validated, so the diagnosis is "exceeded", not "cross-origin".
    handler = (req, res) => {
      const n = Number(new URL(req.url ?? '/', base).searchParams.get('n') ?? '0')
      const location = n === 0 ? '/?n=1' : 'https://example.com/'
      res.writeHead(302, { location })
      res.end()
    }
    await expect(provider({ maxRedirects: 1 }).fetch({ url: `${base}/?n=0` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED', message: 'exceeded the maximum of 1 redirects' }))
  })

  it('maxRedirects: 0 follows no redirect but still fetches a direct 200', async () => {
    handler = (req, res) => {
      if (req.url === '/r') { res.writeHead(302, { location: '/done' }); res.end() }
      else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('direct') }
    }
    await expect(provider({ maxRedirects: 0 }).fetch({ url: `${base}/r` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
    const direct = await provider({ maxRedirects: 0 }).fetch({ url: `${base}/done` })
    expect(direct.body.content).toBe('direct')
  })

  it('treats a redirect without a Location header as a provider error', async () => {
    handler = (_req, res) => { res.writeHead(302); res.end() }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('follows a relative same-origin redirect', async () => {
    handler = (req, res) => {
      if (req.url === '/a') { res.writeHead(301, { location: 'b' }); res.end() }
      else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('landed') }
    }
    const result = await provider().fetch({ url: `${base}/a` })
    expect(result.body.content).toBe('landed')
  })
})

describe('HttpFetchProvider invalid URLs and abort', () => {
  it('rejects a non-http scheme before any network access', async () => {
    await expect(provider().fetch({ url: 'ftp://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
  })

  it('rejects credentials in the URL', async () => {
    await expect(provider().fetch({ url: 'http://user:pass@127.0.0.1/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('honors a pre-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(provider().fetch({ url: base }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('aborts an in-flight fetch via the signal', async () => {
    handler = (_req, _res) => { /* never responds */ }
    const controller = new AbortController()
    const promise = provider().fetch({ url: base }, controller.signal)
    controller.abort()
    await expect(promise).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('times out a slow response with WEB_FETCH_TIMEOUT', async () => {
    handler = (_req, _res) => { /* never responds */ }
    await expect(provider({ timeoutMs: 50 }).fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_FETCH_TIMEOUT' }))
  })

  it('classifies a timeout DURING the body read as WEB_FETCH_TIMEOUT, not WEB_ABORTED', async () => {
    // Promise body that resolves headers (so fetch() returns) but a content-length
    // that outlasts the bytes sent, so readCapped()'s reader awaits more and the
    // timeout fires mid-read — the reader then surfaces a generic AbortError that
    // must still be recovered as the timeout reason via signal.reason.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' })
      res.write('partial')
      // never send the remaining bytes nor end the response
    }
    await expect(provider({ timeoutMs: 80 }).fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_FETCH_TIMEOUT' }))
  })

  it('maps a connection failure to WEB_PROVIDER_ERROR', async () => {
    // Port 1 on loopback is not listening: a real connection failure (not abort).
    await expect(provider().fetch({ url: 'http://127.0.0.1:1/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

})

describe('HttpFetchProvider body cancellation on error paths', () => {
  /** A fake Response whose body.cancel is observable. */
  type FakeInit = { status: number; headers: Record<string, string>; location?: string }
  function fakeResponse(init: FakeInit): { response: Response; cancelled: () => boolean } {
    let cancelled = false
    const headers = new Headers(init.headers)
    if (init.location !== undefined) headers.set('location', init.location)
    const response = {
      status: init.status,
      headers,
      body: { cancel: () => { cancelled = true; return Promise.resolve() } },
    } as unknown as Response
    return { response, cancelled: () => cancelled }
  }

  it('cancels the body when a cross-origin redirect is blocked', async () => {
    const { response, cancelled } = fakeResponse({ status: 302, headers: {}, location: 'https://elsewhere.test/' })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(provider().fetch({ url: 'http://127.0.0.1:9/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
    expect(cancelled()).toBe(true)
  })

  it('cancels the body when an unsupported charset is rejected', async () => {
    const { response, cancelled } = fakeResponse({ status: 200, headers: { 'content-type': 'text/plain; charset=not-a-charset' } })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(provider().fetch({ url: 'http://127.0.0.1:9/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }))
    expect(cancelled()).toBe(true)
  })

  it('cancels the body when a redirect has no Location header', async () => {
    const { response, cancelled } = fakeResponse({ status: 302, headers: {} })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(provider().fetch({ url: 'http://127.0.0.1:9/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(cancelled()).toBe(true)
  })
})

describe('HttpFetchProvider SSRF address guard', () => {
  const guarded = () => provider({ allowPrivateAddresses: false })
  const okResponse = () => new Response('ok', { headers: { 'content-type': 'text/plain' } })
  const lookupMock = vi.mocked(lookup as unknown as (host: string, opts: { all: true }) => Promise<{ address: string; family: number }[]>)

  it('refuses a literal private/loopback/link-local IPv4 target before any request', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    for (const url of ['http://127.0.0.1/', 'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data/']) {
      await expect(guarded().fetch({ url })).rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a bracketed IPv6 loopback literal', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await expect(guarded().fetch({ url: 'http://[::1]/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('allows a public literal IP and proceeds to fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    const result = await guarded().fetch({ url: 'http://8.8.8.8/' })
    expect(result.body).toEqual({ kind: 'text', content: 'ok' })
  })

  it('refuses a hostname that resolves to a private address', async () => {
    lookupMock.mockResolvedValue([{ address: '10.1.2.3', family: 4 }])
    vi.stubGlobal('fetch', vi.fn())
    const error = await guarded().fetch({ url: 'http://intranet.test/' }).catch((reason: unknown) => reason)
    expect(error).toMatchObject({ code: 'WEB_BLOCKED_URL' })
    expect(String(error)).toContain('10.1.2.3')
  })

  it('allows a hostname that resolves only to public addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    const result = await guarded().fetch({ url: 'http://example.test/' })
    expect(result.body).toEqual({ kind: 'text', content: 'ok' })
  })

  it('reports an unresolvable host as a provider error', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'))
    vi.stubGlobal('fetch', vi.fn())
    await expect(guarded().fetch({ url: 'http://nope.invalid/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('pins the connection: a host public at pre-flight but private at connect is blocked (rebinding)', async () => {
    // Pre-flight (dns/promises) sees a public address and passes.
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    // The pinned dispatcher's connect-time resolution (node:dns) sees a private
    // address: the connection must be refused before any socket opens.
    dnsCbMock.mockImplementation((_host, _opts, cb) => { cb(null, [{ address: '127.0.0.1', family: 4 }]) })
    await expect(guarded().fetch({ url: 'http://rebind.test/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })
})

describe('guardedLookup connection pinning', () => {
  it('passes through addresses that are all public', () => {
    dnsCbMock.mockImplementation((_host, _opts, cb) => { cb(null, [{ address: '93.184.216.34', family: 4 }]) })
    let error: unknown = 'unset'
    let addresses: unknown
    guardedLookup('example.test', {}, (err, addrs) => { error = err; addresses = addrs })
    expect(error).toBeNull()
    expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }])
  })

  it('refuses when any resolved address is private or reserved', () => {
    dnsCbMock.mockImplementation((_host, _opts, cb) => {
      cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }])
    })
    let error: unknown
    guardedLookup('intranet.test', {}, (err) => { error = err })
    expect(error).toMatchObject({ code: 'WEB_BLOCKED_URL' })
    expect(String(error)).toContain('10.0.0.5')
  })

  it('forwards a DNS resolution error unchanged', () => {
    const dnsError = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
    dnsCbMock.mockImplementation((_host, _opts, cb) => { cb(dnsError, []) })
    let error: unknown
    guardedLookup('nope.invalid', {}, (err) => { error = err })
    expect(error).toBe(dnsError)
  })
})

describe('web-fetch-http plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    const fiber = await ctx.plugin(fetchPlugin, { allowPrivateAddresses: true })
    await expect(ctx.web.fetch({ url: `${base}/` }))
      .resolves.toMatchObject({ statusCode: 200 })
    await fiber.dispose()
    await expect(ctx.web.fetch({ url: `${base}/` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in fetchPlugin).toBe(false)
  })

  it('rejects a non-positive resource limit at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { maxResponseBytes: -1 }))
      .rejects.toThrow(/maxResponseBytes must be a positive finite number/)
  })

  it('rejects a zero timeout at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { timeoutMs: 0 }))
      .rejects.toThrow(/timeoutMs must be a positive finite number/)
  })

  it('rejects a timeout beyond Node timer range at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { timeoutMs: 2_147_483_648 }))
      .rejects.toThrow(/timeoutMs must be no greater than 2147483647/)
  })

  it('rejects a fractional redirect cap at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { maxRedirects: 1.5 }))
      .rejects.toThrow(/maxRedirects must be a non-negative integer/)
  })

  it('rejects a negative redirect cap at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { maxRedirects: -1 }))
      .rejects.toThrow(/maxRedirects must be a non-negative integer/)
  })

  it('accepts maxRedirects: 0 (follow no redirects) as valid config', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    const fiber = await ctx.plugin(fetchPlugin, { maxRedirects: 0, allowPrivateAddresses: true })
    await expect(ctx.web.fetch({ url: `${base}/` }))
      .resolves.toMatchObject({ statusCode: 200 })
    await fiber.dispose()
  })
})
