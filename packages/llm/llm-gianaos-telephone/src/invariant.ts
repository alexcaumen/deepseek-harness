/**
 * Package-owned invariant companion for canonical GianaOS telephone routes.
 * @module @grinviro/dsh-llm-gianaos-telephone/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@grinviro/dsh-llm-gianaos-telephone'

/** Cordis companion plugin name. */
export const name = 'llm-gianaos-telephone-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: canonical runtime and session seams own all durable telephone state. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
