/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list that inserts exactly one
 * `@neo/mcp-client` row configured to spawn the Playwright MCP server.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@neo/cordis-plugin-include'

interface InsertRow {
  id?: string
  name?: string
  config?: Record<string, unknown>
}

function patchRows(): InsertRow[] {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'package.json'), 'utf8'),
  ) as { dsh?: { bundle?: { patch?: string } } }
  expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  const parsed = yaml.load(
    readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
    { schema: entryListSchema },
  )
  expect(Array.isArray(parsed)).toBe(true)
  return (parsed as { insert?: InsertRow[] }[]).flatMap(patch => patch.insert ?? [])
}

describe('@neo/browser bundle', () => {
  it('mounts exactly one Playwright MCP client row over stdio', () => {
    const rows = patchRows()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.id).toBe('mcp-browser')
    expect(row.name).toBe('@neo/mcp-client')
    expect(row.config?.transport).toBe('stdio')
    expect(row.config?.serverName).toBe('browser')
    expect(row.config?.command).toBe('npx')
  })

  it('spawns the Playwright MCP package headless so it runs on a display-less host', () => {
    const args = patchRows()[0]?.config?.args as string[] | undefined
    expect(args).toBeDefined()
    expect(args).toContain('@playwright/mcp@latest')
    expect(args).toContain('--headless')
  })
})
