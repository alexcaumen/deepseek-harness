/**
 * Package-owned invariant companion for the canonical GianaOS ACP adapter.
 * @module @grinviro/dsh-llm-gianaos-acp/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@grinviro/dsh-llm-gianaos-acp'

/** Cordis companion plugin name. */
export const name = 'llm-gianaos-acp-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: live ACP bindings are guarded by exact Agent/Session object identity,
 * while the only durable projection is a non-secret remote-session pointer.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
