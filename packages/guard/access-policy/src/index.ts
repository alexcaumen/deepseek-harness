/**
 * Configurable fail-closed tool-name policy for deployments that add broad
 * external capability surfaces such as MCP servers.
 * @module @grinviro/dsh-tool-access-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'

export const name = 'tool-access-policy'

/** Tool-name patterns evaluated in order-independent deny-before-ask policy. */
export interface Config {
  /** `*`-wildcard patterns that are always denied before tool dispatch. */
  denyPatterns?: string[]
  /** `*`-wildcard patterns that require the deployment approval service. */
  askPatterns?: string[]
}

export const Config: z<Config> = z.object({
  denyPatterns: z.array(z.string()).default([]),
  askPatterns: z.array(z.string()).default([]),
})

/** Convert a literal-with-`*` pattern to an anchored regular expression. */
function compile(pattern: string): RegExp {
  if (pattern.length === 0) throw new Error('tool-access-policy: patterns must not be empty')
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/** Install the policy at the canonical DSH pre-execution seam. */
export function apply(ctx: Context, config: Config): void {
  const deny = (config.denyPatterns ?? []).map(compile)
  const ask = (config.askPatterns ?? []).map(compile)

  ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    if (deny.some(pattern => pattern.test(exec.name))) {
      return Promise.resolve({
        kind: 'deny',
        reason: `Tool "${exec.name}" is disabled by the deployment tool-access policy.`,
      })
    }
    if (ask.some(pattern => pattern.test(exec.name))) {
      return Promise.resolve({
        kind: 'ask',
        reason: `Tool "${exec.name}" requires explicit approval by the deployment policy.`,
      })
    }
    return next()
  }, { prepend: true })
}

export default apply
