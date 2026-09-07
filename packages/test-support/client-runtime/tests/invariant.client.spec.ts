import { describe, expect, it } from 'vitest'
import { Context } from '@neo/cordis'
import * as TestRuntimeInvariant from '@neo/client-test-runtime/invariant'
import InvariantRegistry from '@neo/invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(TestRuntimeInvariant).await()).resolves.toBeDefined()
  })
})
