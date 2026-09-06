import { describe, expect, it } from 'vitest'
import { Context } from '@neo/cordis'
import * as SchemaFormInvariant from '@neo/dsh-client-schema-form/invariant'
import InvariantRegistry from '@neo/dsh-invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(SchemaFormInvariant).await()).resolves.toBeDefined()
  })
})
