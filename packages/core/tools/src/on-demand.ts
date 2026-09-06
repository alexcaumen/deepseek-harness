/** Native tool discovery using the existing registry and durable session results. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolPresentationMode, ToolRuntime } from './index.ts'
import { defineTool } from './schema.ts'

const SEARCH_NAME = 'tool_search'

/** Provider-scoped prompt reduction; capability registration and execution are unchanged. */
export interface OnDemandConfig {
  /** Exact deployment provider ids that use native discovery. */
  providers: string[]
  /** Tool names offered without discovery when visible in the current scope. */
  alwaysAvailable: string[]
  /** Maximum schemas returned by one search. */
  maxSearchResults: number
  /** Maximum recently discovered or called schemas retained in the request. */
  maxActiveTools: number
}

/** Rank exact names first, then name matches, then words in descriptions. */
function searchSchemas(schemas: ToolSchema[], query: string): ToolSchema[] {
  const normalized = query.trim().toLowerCase()
  const terms = normalized.split(/\s+/u).filter(Boolean)
  return schemas.filter(schema => schema.name !== SEARCH_NAME).map((schema) => {
    const name = schema.name.toLowerCase()
    const description = schema.description.toLowerCase()
    const score = name === normalized ? 10000 : terms.reduce((sum, term) =>
      sum + (name.includes(term) ? 20 : description.includes(term) ? 1 : 0), 0)
    return { schema, score }
  }).filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || a.schema.name.localeCompare(b.schema.name))
    .map(row => row.schema)
}

/** Reconstruct discoveries only from successful, correlated registry tool results. */
function recentTools(agent: Agent, maximum: number): Set<string> {
  const names = new Set<string>()
  const calls = new Map<string, string>()
  const touch = (name: string): void => {
    if (name === SEARCH_NAME) return
    names.delete(name)
    names.add(name)
    if (names.size > maximum) {
      const oldest = names.values().next().value
      if (oldest !== undefined) names.delete(oldest)
    }
  }
  for (const event of agent.session.events) {
    if (event.type === 'tool/call') {
      calls.set(event.data.callId, event.data.name)
      touch(event.data.name)
    }
    if (event.type !== 'tool/result') continue
    const message = event.data.message
    if (message.source.kind !== 'tool' || calls.get(message.source.callId) !== SEARCH_NAME) continue
    for (const result of message.content) {
      if (result.type !== 'tool-result' || result.isError || result.toolCallId !== message.source.callId) continue
      for (const block of result.content) {
        if (block.type !== 'text') continue
        let value: unknown
        try { value = JSON.parse(block.text) } catch { continue } // Other result renderers are not discoveries.
        if (typeof value !== 'object' || value === null || !('tools' in value) || !Array.isArray(value.tools)) continue
        for (const tool of value.tools as unknown[]) {
          if (typeof tool === 'object' && tool !== null && 'name' in tool && typeof tool.name === 'string') touch(tool.name)
        }
      }
    }
  }
  return names
}

/** Register discovery and return the request-schema projection for this registry. */
export function installOnDemandTools(ctx: Context, registry: ToolRuntime, config: OnDemandConfig,
  modeFor: (context: AssembleContext) => ToolPresentationMode):
(schemas: ToolSchema[], agent: Agent, provider: string) => ToolSchema[] {
  if (!Number.isInteger(config.maxSearchResults) || config.maxSearchResults < 1
    || !Number.isInteger(config.maxActiveTools) || config.maxActiveTools < config.maxSearchResults
    || config.providers.some(value => !value.trim()) || config.alwaysAvailable.some(value => !value.trim())) {
    throw new Error('onDemand requires nonempty names and 1 <= maxSearchResults <= maxActiveTools')
  }
  const providers = new Set(config.providers)
  const pinned = new Set([SEARCH_NAME, ...config.alwaysAvailable])

  registry.register(defineTool({
    name: SEARCH_NAME,
    description: 'Find available tools by capability or exact name. Returns their complete input schemas. Use the current tool execution mode to call the returned tools. Search when the tool you need is not listed; never invent tool names or arguments.',
    parameters: {
      query: { type: 'string', required: true, description: 'Capability words or an exact tool name.' },
      offset: { type: 'integer', description: 'Zero-based offset for further matches; omitted means 0.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      if (!args.query.trim()) throw new Error('tool_search query must not be empty')
      const offset = args.offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('tool_search offset must be a nonnegative integer')
      const matches = searchSchemas(registry.schemas(exec.agent), args.query)
      const tools = matches.slice(offset, offset + config.maxSearchResults)
      return JSON.stringify({ tools, totalMatches: matches.length,
        nextOffset: offset + tools.length < matches.length ? offset + tools.length : null })
    },
    presentCall(args) { return { card: 'generic', title: 'Find tools', kind: 'read', rawInput: args.query } },
  }))
  ctx.systemPrompt.section({
    name: 'tools:on-demand', order: 98,
    text: context => modeFor(context) === 'native' && registry.schemas(context.scope).some(schema => schema.name === SEARCH_NAME)
      ? 'When tool_search is offered, additional tools remain available on demand. Search by capability or exact tool name to load input schemas, then call the returned tools directly. All tools retain their normal permissions. A missing schema is not an unavailable capability.' : '',
  })
  return (schemas, agent, provider) => {
    if (!providers.has(provider) || modeFor({ scope: agent }) !== 'native'
      || !schemas.some(schema => schema.name === SEARCH_NAME)) {
      return schemas.filter(schema => schema.name !== SEARCH_NAME)
    }
    const active = recentTools(agent, config.maxActiveTools)
    return schemas.filter(schema => pinned.has(schema.name) || active.has(schema.name))
  }
}
