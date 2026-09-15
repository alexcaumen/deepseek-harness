/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-subagent`.
 * @module @deepseek-ai/dsh-tool-subagent/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { delegationAllowsTool } from '@deepseek-ai/dsh-subagent'
import { subagentModelSelectionPolicies } from './model-selection-state.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-subagent'

/** Cordis companion plugin name. */
export const name = 'tool-subagent-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Assert that a durable selection policy has both model-facing definitions. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const schemas = ctx.tools.schemas(agent)
    for (const policy of subagentModelSelectionPolicies(agent.session)) {
      if (!delegationAllowsTool(agent, policy.definitionId)
        || !delegationAllowsTool(agent, policy.discoveryToolName)) continue
      const definition = schemas.find(schema => schema.name === policy.definitionId)
      const providerPresent = policy.providerName === undefined
        ? definition !== undefined
        : ctx.subagents.getProvider(policy.providerName) !== undefined
      if (!providerPresent) continue
      const properties = definition === undefined
        ? undefined
        : (definition.parameters as { properties?: Record<string, unknown> }).properties
      const selectable = properties?.['provider'] !== undefined
        && properties['model'] !== undefined
        && properties['reasoning_effort'] !== undefined
      if (!selectable || !schemas.some(schema => schema.name === policy.discoveryToolName)) {
        fail(`a subagent/model-selection-policy Session must expose route fields on ${policy.definitionId}`
          + ` and ${policy.discoveryToolName}`)
      }
    }
    return next()
  }, { global: true })
}, { inject: ['tools', 'subagents'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
