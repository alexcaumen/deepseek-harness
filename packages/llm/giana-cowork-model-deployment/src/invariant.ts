/** Package-owned invariant companion for the GCP model deployment. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-giana-cowork-model-deployment'
export const name = 'giana-cowork-model-deployment-invariant'
export const inject = ['invariants']

/** Runtime checks remain in the receipt validator and manager state machine. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
