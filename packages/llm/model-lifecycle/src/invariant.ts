/** Package-owned invariant companion for the model lifecycle seam. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-model-lifecycle'

export const name = 'model-lifecycle-invariant'
export const inject = ['invariants']

/** Runtime methods enforce the transaction invariants at their mutation boundaries. */
const install: InvariantInstaller = () => {
  // No runtime invariant: register(), acquireRoute(), and the stream lease validate at mutation boundaries.
}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
