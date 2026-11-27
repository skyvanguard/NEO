/**
 * The one home of the generated-region grammar and the pair-record primitives
 * shared by the region-injecting generators. NEO dropped the bilingual-document
 * pairing gate with the zh/i18n documents, so only these helpers remain.
 */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'

/** Complete opening marker line: `<!-- BEGIN GENERATED <slug> … -->` (slug captured). */
const GENERATED_REGION_BEGIN_LINE = /^<!-- BEGIN GENERATED (\S+)(?: [^>]*)? -->$/
/** Complete closing marker line: `<!-- END GENERATED <slug> -->` (slug captured). */
const GENERATED_REGION_END_LINE = /^<!-- END GENERATED (\S+) -->$/
/** Loose marker detector: any line that LOOKS like a region marker must parse as one. */
const GENERATED_REGION_MARKER_HINT = /^<!-- (?:BEGIN|END) GENERATED /

/**
 * Extract every generated region (markers included) and the document with
 * those regions removed. Regions are line-delimited: a marker occupies its
 * whole line, must be a complete well-formed marker, and the closing slug
 * must match the opener. The stripped form is what "human content" means for
 * the region-aware pair-record guard.
 *
 * @param content - Full Markdown document text.
 * @returns The regions in document order and the region-free remainder.
 * @throws Error on an unopened END, unclosed BEGIN, nested BEGIN, malformed
 *   marker line, or a closing slug that does not match its opener.
 */
export function partitionGeneratedRegions(content: string): { regions: string[]; stripped: string } {
  const lines = content.split('\n')
  const regions: string[] = []
  const kept: string[] = []
  let open: { slug: string; lines: string[] } | null = null
  for (const line of lines) {
    const begin = GENERATED_REGION_BEGIN_LINE.exec(line)
    if (begin?.[1]) {
      if (open) throw new Error('generated region BEGIN marker nested inside an open region')
      open = { slug: begin[1], lines: [line] }
      continue
    }
    const end = GENERATED_REGION_END_LINE.exec(line)
    if (end?.[1]) {
      if (!open) throw new Error('generated region END marker without a BEGIN')
      if (end[1] !== open.slug) throw new Error(`generated region END slug '${end[1]}' does not match its BEGIN slug '${open.slug}'`)
      open.lines.push(line)
      regions.push(open.lines.join('\n'))
      open = null
      continue
    }
    if (GENERATED_REGION_MARKER_HINT.test(line)) {
      throw new Error(`malformed generated region marker line: ${JSON.stringify(line)}`)
    }
    if (open) open.lines.push(line)
    else kept.push(line)
  }
  if (open) throw new Error('generated region BEGIN marker without an END')
  return { regions, stripped: kept.join('\n') }
}

/**
 * Full git blob hash of file content (what `git hash-object` prints).
 * @param content - Exact file bytes.
 * @returns The 40-hex-digit SHA-1 blob hash.
 */
export function blobHash(content: Buffer): string {
  const hash = createHash('sha1')
  hash.update(`blob ${content.byteLength}\0`)
  hash.update(content)
  return hash.digest('hex')
}

const PAIR_META_LINE = /^([^:#]+\.md): ([0-9a-f]{40})$/

/**
 * Parse a `foo.i18n.yaml` consistency record into basename → recorded blob
 * hash, or undefined when any non-comment line deviates from the exact
 * `<basename>.md: <40-hex>` format or repeats a key. Consumers must
 * additionally require exactly the two expected basenames — a renamed key is
 * a malformed record, never a silently-missing entry.
 * @param content - Sidecar file text.
 * @returns The recorded map, or undefined for a malformed record.
 */
export function parsePairMeta(content: string): Map<string, string> | undefined {
  const out = new Map<string, string>()
  for (const line of content.split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const match = PAIR_META_LINE.exec(line)
    if (!match?.[1] || !match[2]) return undefined
    if (out.has(match[1])) return undefined
    out.set(match[1], match[2])
  }
  return out
}

/**
 * Render a `foo.i18n.yaml` consistency record.
 * @param source - Repo-relative English path.
 * @param sourceHash - Blob hash of the English side.
 * @param zh - Repo-relative Chinese path.
 * @param zhHash - Blob hash of the Chinese side.
 * @returns The exact sidecar file content.
 */
export function renderPairMeta(source: string, sourceHash: string, zh: string, zhHash: string): string {
  return [
    '# Bilingual-pair consistency record (docs/i18n/README.md): the git blob hash of each',
    '# side as of the last confirmed-consistent state. Both languages carry equal authority;',
    '# after editing either side, bring the other along and re-record with:',
    `#   pnpm run verify-translation-pairing --write ${source}`,
    `${basename(source)}: ${sourceHash}`,
    `${basename(zh)}: ${zhHash}`,
    '',
  ].join('\n')
}
