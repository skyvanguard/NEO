/**
 * Package-owned invariant companion for `@neo/mcp-resources`.
 * @module @neo/mcp-resources/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@neo/cordis'
import type { InvariantInstaller } from '@neo/invariants'

const PACKAGE_NAME = '@neo/mcp-resources'

/** Cordis companion plugin name. */
export const name = 'mcp-resources-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: scoped resource-provider layers dispose with their
 * owning scope, a relation the lifecycle tests exercise directly rather than
 * through a public API added solely for an invariant.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
