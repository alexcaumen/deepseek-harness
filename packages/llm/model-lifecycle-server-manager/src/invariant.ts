/** Package-owned invariant companion for the Server Manager lifecycle gateway. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-model-lifecycle-server-manager'

export const name = 'model-lifecycle-server-manager-invariant'
export const inject = ['invariants']

/** No runtime invariant: every wire receipt is verified before publication. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
