import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CodeRuntime, type CodeRunRequest, type CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { CallId } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { OnDemandConfig } from '../src/on-demand.ts'

const config: OnDemandConfig = {
  providers: ['local-glm'], alwaysAvailable: ['read'], maxSearchResults: 2, maxActiveTools: 3,
}
async function mount(onDemand: OnDemandConfig | undefined = config) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { onDemand })
  return ctx
}
function register(ctx: Context, name: string, description = `Capability ${name}`) {
  return ctx.tools.register(defineTool({
    name, description, parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) { return args.text },
  }))
}
function fakeAgent(provider = 'local-glm', events: unknown[] = []) {
  return { options: { provider }, session: { events } } as unknown as Agent
}
async function assemble(ctx: Context, agent: Agent, provider = agent.options.provider ?? '') {
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
  return { ...assembly, tools: ctx.tools.schemasForRequest(assembly.tools, agent, provider) }
}
async function search(ctx: Context, agent: Agent, query: string, offset = 0) {
  return ctx.tools.execute({ name: 'tool_search', callId: CallId('search'),
    arguments: { query, offset }, agent, signal: new AbortController().signal })
}
function discovery(names: string[], options: { failed?: boolean; mismatch?: boolean; malformed?: boolean } = {}) {
  return [
    { type: 'tool/call', data: { callId: 'search', name: 'tool_search' } },
    { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'search' },
      content: [{ type: 'tool-result', toolCallId: options.mismatch ? 'other' : 'search', isError: options.failed,
        content: [{ type: 'text', text: options.malformed ? 'invalid' : JSON.stringify({ tools: names.map(name => ({ name })) }) }] }] } } },
  ]
}

class FakeCodeRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fake'
  run(_request: CodeRunRequest): Promise<CodeRunResult> { return Promise.resolve({ logs: [] }) }
}

describe('provider-scoped native tool discovery', () => {
  it('reduces the request without removing capabilities or changing other providers', async () => {
    const ctx = await mount()
    register(ctx, 'read')
    for (let n = 0; n < 100; n++) register(ctx, `large_${n}`, 'long schema description '.repeat(40))
    const local = await assemble(ctx, fakeAgent())
    expect(local.tools.map(tool => tool.name).sort()).toEqual(['read', 'tool_search'])
    expect(ctx.tools.schemas()).toHaveLength(102)
    const remote = await assemble(ctx, fakeAgent('other'))
    expect(remote.tools).toHaveLength(101)
    expect(JSON.stringify(local.tools).length).toBeLessThan(JSON.stringify(remote.tools).length / 20)
  })

  it('returns complete scoped schemas, exact matches first, with pagination', async () => {
    const ctx = await mount()
    for (const name of ['read', 'browser_navigate', 'browser_snapshot', 'browser_click']) register(ctx, name)
    const agent = fakeAgent()
    const exact = await search(ctx, agent, 'browser_snapshot')
    expect(exact.isError).toBe(false)
    expect(JSON.parse(exact.value as string).tools[0]).toEqual(ctx.tools.schemas(agent).find(tool => tool.name === 'browser_snapshot'))
    const first = JSON.parse((await search(ctx, agent, 'browser')).value as string)
    const second = JSON.parse((await search(ctx, agent, 'browser', first.nextOffset)).value as string)
    expect(first.totalMatches).toBe(3)
    expect(first.tools).toHaveLength(2)
    expect(second.tools).toHaveLength(1)
    expect(second.nextOffset).toBeNull()
    expect((await search(ctx, agent, ' ')).isError).toBe(true)
    expect((await search(ctx, agent, 'browser', -1)).isError).toBe(true)
  })

  it('recovers discoveries from persisted results, retains recent calls, and bounds growth', async () => {
    const ctx = await mount()
    for (const name of ['read', 'a', 'b', 'c', 'd', 'e']) register(ctx, name)
    const events = [...discovery(['a', 'b']), ...discovery(['c', 'd']),
      { type: 'tool/call', data: { callId: 'e', name: 'e' } }]
    const restored = fakeAgent('local-glm', JSON.parse(JSON.stringify(events)))
    expect((await assemble(ctx, restored)).tools.map(tool => tool.name).sort()).toEqual(['c', 'd', 'e', 'read', 'tool_search'])
    expect((await assemble(ctx, fakeAgent())).tools.map(tool => tool.name).sort()).toEqual(['read', 'tool_search'])
  })

  it('ignores failed, uncorrelated, malformed, and unregistered discoveries', async () => {
    const ctx = await mount()
    register(ctx, 'hidden')
    const events = [...discovery(['hidden'], { failed: true }), ...discovery(['hidden'], { mismatch: true }),
      ...discovery(['hidden'], { malformed: true }), ...discovery(['not_registered'])]
    expect((await assemble(ctx, fakeAgent('local-glm', events))).tools.map(tool => tool.name)).toEqual(['tool_search'])
  })

  it('cannot discover or execute tools outside the current scope, even with replayed names', async () => {
    const ctx = await mount()
    register(ctx, 'read')
    register(ctx, 'private_tool')
    const agent = fakeAgent('local-glm', discovery(['private_tool']))
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) },
      { inject: ['tools', 'systemPrompt'] }))
    scope.ctx.tools.restrict({ deny: ['private_tool'] })
    expect(JSON.parse((await search(ctx, agent, 'private_tool')).value as string).tools).toEqual([])
    expect((await assemble(ctx, agent)).tools.map(tool => tool.name).sort()).toEqual(['read', 'tool_search'])
    const execution = await ctx.tools.execute({ name: 'private_tool', callId: CallId('denied'),
      arguments: { text: 'no' }, agent, signal: new AbortController().signal })
    expect(execution.isError).toBe(true)
    scope.ctx.tools.restrict({ deny: ['tool_search'] })
    // A scope which forbids discovery must still see its permitted tools.
    register(ctx, 'another')
    expect((await assemble(ctx, agent)).tools.map(tool => tool.name).sort()).toEqual(['another', 'read'])
  })

  it('uses current schemas after hot replacement rather than saved schema content', async () => {
    const ctx = await mount()
    const dispose = register(ctx, 'browser', 'old')
    const agent = fakeAgent('local-glm', discovery(['browser']))
    dispose()
    register(ctx, 'browser', 'new')
    expect((await assemble(ctx, agent)).tools.find(tool => tool.name === 'browser')?.description).toBe('new')
  })

  it('preserves code-only presentation and does not inject direct-call discovery guidance', async () => {
    const ctx = await mount()
    await ctx.plugin(FakeCodeRuntime)
    register(ctx, 'read')
    const agent = fakeAgent()
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) },
      { inject: ['tools', 'systemPrompt'] }))
    scope.ctx.tools.presentAs('code')
    const assembly = await assemble(ctx, agent)
    expect(assembly.tools.map(tool => tool.name)).toEqual(['run_code'])
    expect(JSON.stringify(assembly)).not.toContain('When tool_search is offered, additional tools remain available on demand.')
  })

  it('uses the current request provider rather than the original session options', async () => {
    const ctx = await mount()
    register(ctx, 'read')
    register(ctx, 'browser')
    const agent = fakeAgent('other')
    expect((await assemble(ctx, agent, 'local-glm')).tools.map(tool => tool.name).sort()).toEqual(['read', 'tool_search'])
    expect((await assemble(ctx, agent, 'other')).tools.map(tool => tool.name).sort()).toEqual(['browser', 'read'])
    expect((await assemble(ctx, fakeAgent(), 'other')).tools.map(tool => tool.name).sort()).toEqual(['browser', 'read'])
  })
})
