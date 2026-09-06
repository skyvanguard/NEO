/**
 * Package-owned invariant companion for `@neo/dsh-client-ui-tool`.
 * @module @neo/dsh-client-ui-tool/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@neo/cordis'
import type { InvariantInstaller } from '@neo/dsh-invariants'

const PACKAGE_NAME = '@neo/dsh-client-ui-tool'

/** Cordis companion plugin name. */
export const name = 'client-ui-tool-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: Tool composition is browser-only and contributes no
 * events or cross-plugin mutable state; slot ownership is checked by ui-slots.
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
