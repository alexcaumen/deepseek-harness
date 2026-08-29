/**
 * Package-owned invariant companion for the ToolRuntime MCP server.
 * @module @deepseek-ai/dsh-mcp-server-tool-runtime/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp-server-tool-runtime'

/** Cordis companion plugin name. */
export const name = 'mcp-server-tool-runtime-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: capability bindings are process-local and expose no durable event vocabulary. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
