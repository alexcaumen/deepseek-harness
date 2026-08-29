/**
 * Package-owned invariant companion for the GianaOS workspace bridge.
 * @module @grinviro/dsh-llm-gianaos-workspace-bridge/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@grinviro/dsh-llm-gianaos-workspace-bridge'

/** Cordis companion plugin name. */
export const name = 'llm-gianaos-workspace-bridge-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: bounded workspace operations are validated synchronously at their seam. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
