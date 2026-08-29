/**
 * Package-owned invariant companion for the GianaOS participant catalog.
 * @module @grinviro/dsh-gianaos-catalog/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@grinviro/dsh-gianaos-catalog'

/** Cordis companion plugin name. */
export const name = 'gianaos-catalog-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: this package projects immutable source-backed catalog rows only. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
