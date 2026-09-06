/** Package-owned invariant companion. @module @neo/dsh-prompt-section/invariant */

/* jscpd:ignore-start */
import type { Context } from '@neo/cordis'
import type { InvariantInstaller } from '@neo/dsh-invariants'

const PACKAGE_NAME = '@neo/dsh-prompt-section'

/** Cordis companion plugin name. */
export const name = 'prompt-section-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: this package owns a scope-only prompt contribution. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
