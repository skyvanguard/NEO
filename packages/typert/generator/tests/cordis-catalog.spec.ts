import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectCordisCatalog } from '../src/cordis-catalog.ts'
import { CORDIS_CATALOG_POLICY } from '../../../../scripts/gen-cordis-catalog.ts'

const workspaceRoot = resolve(import.meta.dirname, '../../../..')

/** One workspace projection shared by both cases: analyzing it twice doubles a multi-minute run. */
let cached: ReturnType<typeof projectCordisCatalog> | undefined
const projection = (): ReturnType<typeof projectCordisCatalog> =>
  (cached ??= projectCordisCatalog(workspaceRoot, CORDIS_CATALOG_POLICY))

describe('Typert-backed Cordis catalog', () => {
  it('reproduces the committed runtime API catalog byte for byte', { timeout: 480_000 }, () => {
    const { projector, model } = projection()
    const expected = (path: string): string => readFileSync(join(workspaceRoot, path), 'utf8')

    // The documentation/website subsystem (docs/cordis-api, docs/subsystems) was
    // removed for the public release, so only the product-code artifact remains
    // to reproduce: the generated runtime API catalog consumed by tool-cordis.
    expect(projector.renderRuntimeApi(model)).toBe(
      expected('packages/extensions/tool-cordis/src/api-catalog.ts'),
    )
  })

  it('resolves each key to the declaration a caller meets, and drops keys no plugin provides', { timeout: 480_000 }, () => {
    const byKey = new Map(projection().model.services.map(service => [service.key, service]))
    // An interface-typed key is described by its Service Definition: that is where
    // the contract and, by repository convention, the member JSDoc live.
    expect(byKey.get('lsp')?.type).toBe('LspService')
    // The Service Definition may sit anywhere in the package, including a nested
    // contract directory (`src/api/`), while the Context merge stays in `src`.
    expect(byKey.get('apiProxy')?.type).toBe('ApiProxy')
    // Two packages describe `ctx.typert` — a merge-extensible interface in
    // type-meta and the implementing class in registry. The class wins: it is the
    // object a caller meets and it carries the documentation.
    expect(byKey.get('typert')?.type).toBe('TypertRegistry')
    // Optional keys are values a launcher installs before the tree mounts. No
    // plugin provides them, so describing one as a service would answer "add the
    // plugin that provides it" for a key where no such plugin exists.
    expect(byKey.has('headlessIo')).toBe(false)
    expect(byKey.has('neoHomePath')).toBe(false)
    expect(byKey.has('launcherEnvironment')).toBe(false)
  })
})
