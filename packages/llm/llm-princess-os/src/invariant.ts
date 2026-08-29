/**
 * Package-owned invariant companion for Princess OS participant routes.
 * @module @grinviro/dsh-llm-princess-os/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@grinviro/dsh-llm-princess-os'

/** Cordis companion plugin name. */
export const name = 'llm-princess-os-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: ACP participant routes own no independent durable relation. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
