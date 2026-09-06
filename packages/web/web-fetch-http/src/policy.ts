/**
 * URL validation and content-type classification for the local HTTP(S) fetch
 * provider — the pure, network-free half. The provider's `fetch()` composes
 * these with transport (redirect following, byte caps, decoding).
 *
 * @module @deepseek-ai/dsh-web-fetch-http/policy
 */

import { WebError } from '@deepseek-ai/dsh-web'

/** The body kinds this provider decodes. */
export type FetchableKind = 'html' | 'text'

/**
 * Validate a request URL against the basic transport hygiene the provider
 * enforces before any network access: http(s) only, no embedded credentials,
 * bounded length. Returns the parsed `URL`. Throws {@link WebError} otherwise.
 * (SSRF / private-network blocking is deferred — see the package Agent Note.)
 *
 * @param input - the raw URL string from the fetch request.
 * @param maxUrlLength - inclusive upper bound on `input`'s length.
 * @returns the parsed `URL`.
 */
export function validateFetchUrl(input: string, maxUrlLength: number): URL {
  if (input.length > maxUrlLength) {
    throw new WebError(`URL exceeds the maximum length of ${maxUrlLength}`, 'WEB_INVALID_URL')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch (error: unknown) {
    throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  }
  return url
}

/**
 * Two URLs are same-origin when scheme, hostname, and port match. A redirect
 * that crosses origins is refused so each new origin requires a fresh tool call
 * (and thus a fresh provider/permission decision).
 *
 * @param a - one of the two URLs to compare.
 * @param b - the other URL to compare.
 * @returns true when `a` and `b` share scheme, hostname, and port.
 */
export function isSameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
}

/**
 * Classify a response `Content-Type` into a decodable body kind, or `undefined`
 * for an unsupported (e.g. binary) type. `text/html` and `application/xhtml+xml`
 * are `html`; other `text/*` plus a few structured text types are `text`.
 *
 * @param contentType - the raw `Content-Type` header, or `null` when the
 *   response carries none (unsupported).
 * @returns the decodable kind, or `undefined` for an unsupported type.
 */
export function classifyContentType(contentType: string | null): FetchableKind | undefined {
  const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) return 'text'
  return undefined
}

/**
 * Extract the `charset` parameter from a response `Content-Type`, lower-cased,
 * or `undefined` when absent. The provider feeds this label to `TextDecoder`
 * so a non-UTF-8 response is decoded with its declared encoding rather than
 * silently mangled into replacement characters.
 *
 * @param contentType - the raw `Content-Type` header, or `null` when the
 *   response carries none.
 * @returns the lower-cased charset label, or `undefined` when none is declared.
 */
export function parseCharset(contentType: string | null): string | undefined {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '')
  return match?.[1]?.trim().toLowerCase()
}

/**
 * Build a `TextDecoder` for the declared charset, falling back to UTF-8 when
 * none is declared. Throws {@link WebError} `WEB_UNSUPPORTED_CONTENT_TYPE` when
 * the label is present but not a charset `TextDecoder` recognizes — better to
 * fail loudly than return mojibake.
 *
 * @param charset - the declared charset label (from {@link parseCharset}), or
 *   `undefined` to default to UTF-8.
 * @returns a decoder for the declared (or defaulted) encoding.
 */
export function decoderForCharset(charset: string | undefined): TextDecoder {
  if (charset === undefined) return new TextDecoder('utf-8')
  try {
    return new TextDecoder(charset)
  } catch (error: unknown) {
    throw new WebError(`unsupported charset "${charset}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE', { cause: error })
  }
}

/**
 * Parse a dotted-quad IPv4 string to its unsigned 32-bit value, or `undefined`
 * when it is not four decimal octets in range. Pure; no DNS.
 *
 * @param ip - a candidate dotted-quad string.
 * @returns the 32-bit value, or `undefined` when `ip` is not a valid IPv4.
 */
function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    value = value * 256 + octet
  }
  return value >>> 0
}

/** True when `value` (a 32-bit IPv4) falls in a private/loopback/reserved range. */
function isBlockedIpv4(value: number): boolean {
  const inRange = (base: number, bits: number): boolean => {
    const mask = (0xffffffff << (32 - bits)) >>> 0
    return (value & mask) === (base & mask)
  }
  return (
    inRange(0x00000000, 8) || // 0.0.0.0/8      "this host on this network"
    inRange(0x0a000000, 8) || // 10.0.0.0/8     private
    inRange(0x64400000, 10) || // 100.64.0.0/10  carrier-grade NAT (shared)
    inRange(0x7f000000, 8) || // 127.0.0.0/8    loopback
    inRange(0xa9fe0000, 16) || // 169.254.0.0/16 link-local (incl. cloud metadata)
    inRange(0xac100000, 12) || // 172.16.0.0/12  private
    inRange(0xc0000000, 24) || // 192.0.0.0/24   IETF protocol assignments
    inRange(0xc0a80000, 16) || // 192.168.0.0/16 private
    inRange(0xc6120000, 15) || // 198.18.0.0/15  benchmarking
    inRange(0xe0000000, 4) || // 224.0.0.0/4    multicast
    inRange(0xf0000000, 4) // 240.0.0.0/4    reserved / broadcast
  )
}

/**
 * Expand a (net.isIPv6-validated) IPv6 string to its 16 bytes, folding any
 * trailing dotted-quad and `::` compression. Returns `undefined` only on shapes
 * `net.isIPv6` would already reject (defensive). Pure; no DNS.
 */
function ipv6ToBytes(ip: string): number[] | undefined {
  const zone = ip.indexOf('%')
  let addr = zone === -1 ? ip : ip.slice(0, zone)
  const lastColon = addr.lastIndexOf(':')
  const tail = addr.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail)
    /* v8 ignore next -- net.isIPv6 already rejects a malformed embedded IPv4. */
    if (v4 === undefined) return undefined
    addr = `${addr.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  const sides = addr.split('::')
  /* v8 ignore next -- more than one "::" is not a valid IPv6. */
  if (sides.length > 2) return undefined
  const toWords = (part: string): number[] => (part === '' ? [] : part.split(':').map(group => parseInt(group, 16)))
  /* v8 ignore next -- split always yields index 0; the ?? only guards the type. */
  const head = toWords(sides[0] ?? '')
  /* v8 ignore next -- index 1 exists whenever a "::" split the string; the ?? only guards the type. */
  const rear = sides.length === 2 ? toWords(sides[1] ?? '') : []
  const missing = sides.length === 2 ? 8 - head.length - rear.length : 0
  /* v8 ignore next -- a negative fill count is not a valid IPv6. */
  if (missing < 0) return undefined
  const words = [...head, ...Array<number>(missing).fill(0), ...rear]
  /* v8 ignore next -- a group count other than 8, or a non-hex word, is already rejected upstream. */
  if (words.length !== 8 || words.some(word => Number.isNaN(word) || word < 0 || word > 0xffff)) return undefined
  return words.flatMap(word => [(word >>> 8) & 0xff, word & 0xff])
}

/** Read four bytes of an expanded IPv6 at `offset` as an embedded IPv4 value. */
function embeddedIpv4(bytes: number[], offset: number): number {
  return bytes.slice(offset, offset + 4).reduce((acc, byte) => acc * 256 + byte, 0) >>> 0
}

/** True when the 16 IPv6 bytes fall in a loopback/ULA/link-local/embedded-private range. */
function isBlockedIpv6(bytes: number[]): boolean {
  /* v8 ignore next -- a validated IPv6 always has byte 0; the ?? only guards the type for the arithmetic below. */
  const byte0 = bytes.at(0) ?? 0
  /* v8 ignore next -- a validated IPv6 always has byte 1; the ?? only guards the type for the arithmetic below. */
  const byte1 = bytes.at(1) ?? 0
  if (bytes.every(byte => byte === 0)) return true // ::            unspecified
  if (bytes.slice(0, 15).every(byte => byte === 0) && bytes.at(15) === 1) return true // ::1 loopback
  if (bytes.slice(0, 10).every(byte => byte === 0) && bytes.at(10) === 0xff && bytes.at(11) === 0xff) {
    return isBlockedIpv4(embeddedIpv4(bytes, 12)) // ::ffff:0:0/96 IPv4-mapped
  }
  if (byte0 === 0x00 && byte1 === 0x64 && bytes.at(2) === 0xff && bytes.at(3) === 0x9b && bytes.slice(4, 12).every(byte => byte === 0)) {
    return isBlockedIpv4(embeddedIpv4(bytes, 12)) // 64:ff9b::/96 NAT64
  }
  if (byte0 === 0x20 && byte1 === 0x02) return isBlockedIpv4(embeddedIpv4(bytes, 2)) // 2002::/16 6to4
  if ((byte0 & 0xfe) === 0xfc) return true // fc00::/7   unique local
  if (byte0 === 0xfe && (byte1 & 0xc0) === 0x80) return true // fe80::/10  link-local
  if (byte0 === 0xff) return true // ff00::/8   multicast
  return false
}

/**
 * Classify an IP literal as one that must never be reached through the public
 * fetch provider: any private, loopback, link-local (incl. cloud-metadata
 * 169.254.169.254), unique-local, multicast, or reserved range, across IPv4,
 * IPv6, and IPv4-mapped / NAT64 / 6to4 embeddings. A non-IP string returns
 * `false` — the caller resolves hostnames via DNS and classifies each result.
 * Pure and network-free.
 *
 * @param ip - an IP literal (no brackets), or a hostname (returns `false`).
 * @returns true when the literal is a blocked internal/reserved address.
 */
export function isBlockedAddress(ip: string): boolean {
  const v4 = ipv4ToInt(ip)
  if (v4 !== undefined) return isBlockedIpv4(v4)
  const bytes = ipv6ToBytes(ip)
  if (bytes !== undefined && bytes.length === 16) return isBlockedIpv6(bytes)
  return false
}
