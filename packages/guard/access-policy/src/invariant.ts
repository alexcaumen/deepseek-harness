/**
 * Package-owned invariant companion for `@grinviro/dsh-tool-access-policy`.
 * @module @grinviro/dsh-tool-access-policy/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@grinviro/dsh-tool-access-policy'

/** Cordis companion plugin name. */
export const name = 'tool-access-policy-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: this stateless policy owns no mutable package-local relation to validate. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
