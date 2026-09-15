import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Invariants from '@deepseek-ai/dsh-invariants'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as mock from './scripted-provider.ts'
import * as tool from '../src/index.ts'
import {
  assertAllowedModelRoutes,
  assertAllowedModelSelection,
  requestedAgentOptions,
} from '../src/model-selection.ts'
import { applyChildComposition, resolveChildAgentOptions, usesModelDefaultReasoning } from '@deepseek-ai/dsh-subagent'
import {
  recordSubagentModelSelection,
  subagentModelSelectionPolicy,
} from '../src/model-selection-state.ts'

const signal = new AbortController().signal
const ALLOWED_MODELS = [
  { provider: 'alpha', model: 'fast' },
  { provider: 'alpha', model: 'careful' },
]

const REASONING = {
  efforts: [
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ],
  defaultEffort: ReasoningEffortId('high'),
} as const

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

let callId = 0
function callSubagent(ctx: Context, agent: Agent, arguments_: unknown) {
  return ctx.tools.execute({
    signal,
    callId: CallId(`model-selection-${++callId}`),
    name: 'subagent',
    arguments: arguments_,
    agent,
  })
}

async function boot(provider = 'spawn', capabilities: mock.Config['capabilities'] = { agentOptions: true }) {
  const requests: SubagentStartRequest[] = []
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await mock.mountScriptedProvider(ctx, {
    name: provider,
    capabilities,
    onStart: (request) => { requests.push(request) },
  })
  ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
  return { ctx, requests }
}

async function createWithPolicy(
  ctx: Context,
  sessionId: string,
  options: {
    seed?: Session['events']
    provider?: string
    parentSession?: ReturnType<typeof SessionId>
    allowedModels?: typeof ALLOWED_MODELS
    backgroundMode?: 'one-shot' | 'continuable'
  } = {},
) {
  return ctx.agents.create({
    sessionId: SessionId(sessionId),
    ...options.seed === undefined ? {} : { seed: options.seed },
    ...options.parentSession === undefined
      ? {}
      : { meta: { parentSession: options.parentSession, origin: 'subagent' as const } },
    agentOptions: { provider: 'alpha', model: 'parent' },
    setup: async (agentCtx) => {
      await agentCtx.plugin(tool, {
        provider: options.provider ?? 'spawn',
        maxDepth: 'provider-managed',
        ...options.backgroundMode === undefined ? {} : { backgroundMode: options.backgroundMode },
        modelSelectionPolicy: { allowedModels: options.allowedModels ?? ALLOWED_MODELS },
      })
    },
  })
}

async function mountStandingSelectionTool(ctx: Context, config: tool.Config, bindCreatedChildren = false) {
  const compositionCarrier = {}
  let compositionCtx: Context | undefined
  await ctx.plugin(Object.assign((inner: Context) => {
    compositionCtx = createScope(inner, compositionCarrier).ctx
  }, { inject: ['tools', 'subagents', 'systemPrompt', 'agents'] }))
  if (compositionCtx === undefined) throw new Error('standing composition scope was not created')
  // Test-only preset stand-in: production AgentPresets.composeFrom() links a
  // child to this composition before publication. Register the equivalent
  // bridge before the standing plugin's agent/created listener.
  if (bindCreatedChildren) {
    ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.origin !== 'subagent') return
      bindScopeParent(agent, compositionCarrier)
      ctx.emit('tools/change')
    })
  }
  const fiber = await compositionCtx.plugin(tool, config)
  return { compositionCarrier, compositionCtx, fiber }
}

describe('subagent model selection policy', () => {
  it('requires a non-empty unique exact-route allowlist', () => {
    expect(() => { assertAllowedModelRoutes([]) }).toThrow('at least one allowed route')
    expect(() => { assertAllowedModelRoutes([{ provider: '', model: 'fast' }]) })
      .toThrow('non-empty provider and model ids')
    expect(() => {
      assertAllowedModelRoutes([
        { provider: 'alpha', model: 'fast' },
        { provider: 'alpha', model: 'fast' },
      ])
    }).toThrow('repeats route "alpha/fast"')
  })

  it('enforces provider/model pairing and clears stale effort on a route change', () => {
    const parent = {
      provider: 'alpha',
      model: 'parent',
      reasoningEffort: ReasoningEffortId('high'),
    }
    expect(() => {
      requestedAgentOptions(parent, undefined, { provider: 'alpha' }, true)
    }).toThrow('`provider` and `model` must be supplied together')

    expect(requestedAgentOptions(
      parent,
      undefined,
      { provider: 'alpha', model: 'fast' },
      true,
    )).toEqual({ provider: 'alpha', model: 'fast' })

    const explicitEffort = requestedAgentOptions(
      parent,
      undefined,
      { provider: 'alpha', model: 'fast', reasoning_effort: 'low' },
      true,
    )
    expect(explicitEffort).toEqual({
      provider: 'alpha',
      model: 'fast',
      reasoningEffort: 'low',
    })
    expect(usesModelDefaultReasoning(explicitEffort)).toBe(false)

    const returnedToParentRoute = requestedAgentOptions(
      parent,
      { provider: 'beta', model: 'configured' },
      { provider: 'alpha', model: 'parent' },
      true,
    )
    expect(usesModelDefaultReasoning(returnedToParentRoute)).toBe(true)
    const parentAgent = {
      options: parent,
      session: { requestContext: () => undefined, requestHeader: () => undefined },
    } as unknown as Agent
    expect(resolveChildAgentOptions(parentAgent, returnedToParentRoute, 1)).toEqual({
      provider: 'alpha',
      model: 'parent',
      subagentDepth: 1,
    })
  })

  it('allows inherited defaults but rejects every explicit route outside policy', () => {
    const policy = { routes: ALLOWED_MODELS }
    const parent = { provider: 'alpha', model: 'parent' }
    expect(() => { assertAllowedModelSelection(policy, parent, undefined, {}) }).not.toThrow()
    expect(() => {
      assertAllowedModelSelection(
        policy,
        parent,
        { provider: 'alpha', model: 'blocked' },
        { provider: 'alpha', model: 'blocked' },
      )
    }).toThrow('is not allowed for this Session')
  })

  it('exposes fields only for a new Session with a persisted policy and forwards an allowed selection', async () => {
    const { ctx, requests } = await boot()
    const handle = await createWithPolicy(ctx, 'selectable-new')
    const schema = ctx.tools.schemas(handle.agent).find(candidate => candidate.name === 'subagent')!
    const properties = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(properties).sort()).toEqual([
      'description',
      'model',
      'prompt',
      'provider',
      'reasoning_effort',
      'run_in_background',
    ])
    expect(ctx.tools.get('list_subagent_models', handle.agent)).toBeDefined()
    expect(subagentModelSelectionPolicy(handle.agent.session)).toEqual(ALLOWED_MODELS)

    const result = await callSubagent(ctx, handle.agent, {
      description: 'route child',
      prompt: 'do work',
      provider: 'alpha',
      model: 'fast',
      reasoning_effort: 'low',
    })
    expect(result.isError).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({
      provider: 'alpha',
      model: 'fast',
      reasoningEffort: 'low',
    })
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('limits discovery to the Session allowlist', async () => {
    const { ctx } = await boot()
    const handle = await createWithPolicy(ctx, 'selection-discovery')
    const inspect = await ctx.tools.execute({
      signal,
      callId: CallId('inspect-allowed-model'),
      name: 'list_subagent_models',
      arguments: { provider: 'alpha', model: 'fast' },
      agent: handle.agent,
    })
    expect(inspect.isError).toBe(false)
    expect(resultText(inspect)).toContain('Reasoning efforts:')
    expect(resultText(inspect)).toContain('high (default)')

    const denied = await ctx.tools.execute({
      signal,
      callId: CallId('inspect-blocked-model'),
      name: 'list_subagent_models',
      arguments: { provider: 'alpha', model: 'blocked' },
      agent: handle.agent,
    })
    expect(denied.isError).toBe(true)
    expect(resultText(denied)).toContain('is not allowed for this Session')
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects disallowed and partial routes before provider start', async () => {
    const { ctx, requests } = await boot()
    const handle = await createWithPolicy(ctx, 'selectable-denial')
    const denied = await callSubagent(ctx, handle.agent, {
      description: 'blocked child',
      prompt: 'do work',
      provider: 'alpha',
      model: 'blocked',
    })
    expect(denied.isError).toBe(true)
    expect(resultText(denied)).toContain('is not allowed for this Session')

    const partial = await callSubagent(ctx, handle.agent, {
      description: 'partial child',
      prompt: 'do work',
      provider: 'alpha',
    })
    expect(partial.isError).toBe(true)
    expect(resultText(partial)).toContain('must be supplied together')

    const unsupportedEffort = await callSubagent(ctx, handle.agent, {
      description: 'unsupported effort',
      prompt: 'do work',
      provider: 'alpha',
      model: 'fast',
      reasoning_effort: 'max',
    })
    expect(unsupportedEffort.isError).toBe(true)
    expect(resultText(unsupportedEffort)).toContain('does not support reasoning effort "max"')
    expect(requests).toHaveLength(0)
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it.each(['spawn', 'fork'] as const)(
    'applies provider, model, and reasoning effort to a real %s child request',
    async (provider) => {
      const ctx = new Context()
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(provider === 'spawn' ? SubagentSpawn : SubagentFork, { providerName: provider })
      const adapter = new MockAdapter([textResponse('child complete')], REASONING)
      ctx.llm.registerAdapter(['alpha'], adapter)
      const handle = await createWithPolicy(ctx, `real-${provider}-selection`, { provider })

      const result = await callSubagent(ctx, handle.agent, {
        description: 'real child',
        prompt: 'do work',
        provider: 'alpha',
        model: 'fast',
        reasoning_effort: 'low',
      })

      expect(result.isError).toBe(false)
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]).toMatchObject({
        provider: 'alpha',
        model: 'fast',
        reasoningEffort: 'low',
      })
      await handle.dispose()
      await ctx.fiber.dispose()
    },
  )

  it.each(['spawn', 'fork'] as const)(
    'uses the selected model default after a real %s route round-trip',
    async (provider) => {
      const ctx = new Context()
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(provider === 'spawn' ? SubagentSpawn : SubagentFork, { providerName: provider })
      const adapter = new MockAdapter([textResponse('child complete')], REASONING)
      ctx.llm.registerAdapter(['alpha'], adapter)
      const handle = await ctx.agents.create({
        sessionId: SessionId(`real-${provider}-round-trip`),
        agentOptions: {
          provider: 'alpha',
          model: 'parent',
          reasoningEffort: ReasoningEffortId('low'),
        },
        setup: async (agentCtx) => {
          await agentCtx.plugin(tool, {
            provider,
            maxDepth: 'provider-managed',
            agentOptions: { provider: 'beta', model: 'configured' },
            modelSelectionPolicy: { allowedModels: [{ provider: 'alpha', model: 'parent' }] },
          })
        },
      })

      const result = await callSubagent(ctx, handle.agent, {
        description: 'round trip child',
        prompt: 'do work',
        provider: 'alpha',
        model: 'parent',
      })

      expect(result.isError).toBe(false)
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]).toMatchObject({
        provider: 'alpha',
        model: 'parent',
        reasoningEffort: 'high',
      })
      await handle.dispose()
      await ctx.fiber.dispose()
    },
  )

  it('persists and cold-resumes a policy-selected continuable route and effort', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-tool-subagent-model-selection-'))
    const ctx = new Context()
    let handle: Awaited<ReturnType<typeof createWithPolicy>> | undefined
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root })
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
      const adapter = new MockAdapter([
        textResponse('initial child'),
        textResponse('effort changed'),
        textResponse('resumed child'),
      ], REASONING)
      ctx.llm.registerAdapter(['alpha'], adapter)
      const childForEffortChange: { current?: ReturnType<typeof SessionId> } = {}
      let changeEffort = false
      ctx.on('agent/request', async ({ agent }, next) => {
        const config = await next()
        return changeEffort && agent.id === childForEffortChange.current
          ? { ...config, reasoningEffort: ReasoningEffortId('high') }
          : config
      })
      handle = await createWithPolicy(ctx, 'continuable-selection-parent', {
        provider: 'spawn',
        backgroundMode: 'continuable',
      })
      ctx.on('agent/pre-step', async ({ agent }, next) => (
        agent === handle?.agent ? { kind: 'reject' as const } : next()
      ))

      const started = await callSubagent(ctx, handle.agent, {
        description: 'continuable route',
        prompt: 'do work',
        provider: 'alpha',
        model: 'fast',
        reasoning_effort: 'low',
      })
      expect(started.isError).toBe(false)
      const match = /^started subagent (\S+)$/.exec(resultText(started))
      expect(match).not.toBeNull()
      const childId = SessionId(match![1]!)
      childForEffortChange.current = childId
      await vi.waitFor(() => {
        expect(ctx.agents.get(childId)).toBeUndefined()
      }, { timeout: 5_000 })

      const initial = await ctx.sessionPersistence.load(childId)
      expect(initial.events.find(event => event.type === 'subagent/descriptor')?.data)
        .toMatchObject({
          version: 2,
          agentProvider: 'alpha',
          agentModel: 'fast',
          agentReasoningEffort: 'low',
        })
      expect(initial.events.find(event => event.type === 'request/header')?.data)
        .toMatchObject({
          reason: 'initial',
          header: { config: { provider: 'alpha', model: 'fast', reasoningEffort: 'low' } },
        })

      changeEffort = true
      await ctx.subagents.followup(
        handle.agent,
        childId,
        [{ type: 'text', text: 'continue' }],
        { source: { kind: 'user' }, signal },
      )
      await vi.waitFor(() => {
        expect(ctx.agents.get(childId)).toBeUndefined()
      }, { timeout: 5_000 })
      changeEffort = false
      expect(adapter.requests).toHaveLength(2)
      expect(adapter.requests[1]).toMatchObject({
        provider: 'alpha',
        model: 'fast',
        reasoningEffort: 'high',
      })
      await ctx.subagents.followup(
        handle.agent,
        childId,
        [{ type: 'text', text: 'continue again' }],
        { source: { kind: 'user' }, signal },
      )
      await vi.waitFor(() => {
        expect(ctx.agents.get(childId)).toBeUndefined()
      }, { timeout: 5_000 })
      expect(adapter.requests).toHaveLength(3)
      expect(adapter.requests[2]).toMatchObject({
        provider: 'alpha',
        model: 'fast',
        reasoningEffort: 'high',
      })
      const resumed = await ctx.sessionPersistence.load(childId)
      expect(resumed.events.filter(event => event.type === 'request/header').at(-1)?.data)
        .toMatchObject({
          reason: 'resume',
          header: { config: { provider: 'alpha', model: 'fast', reasoningEffort: 'high' } },
        })
    } finally {
      await handle?.dispose()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('cold-resumes a route round-trip with the selected model default', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-tool-subagent-default-resume-'))
    const ctx = new Context()
    let handle: Awaited<ReturnType<typeof ctx.agents.create>> | undefined
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root })
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
      const adapter = new MockAdapter([
        textResponse('initial default'),
        textResponse('resumed default'),
      ], REASONING)
      ctx.llm.registerAdapter(['alpha'], adapter)
      handle = await ctx.agents.create({
        sessionId: SessionId('default-resume-parent'),
        agentOptions: {
          provider: 'alpha',
          model: 'parent',
          reasoningEffort: ReasoningEffortId('low'),
        },
        setup: async (agentCtx) => {
          await agentCtx.plugin(tool, {
            provider: 'spawn',
            maxDepth: 'provider-managed',
            backgroundMode: 'continuable',
            agentOptions: { provider: 'beta', model: 'configured' },
            modelSelectionPolicy: { allowedModels: [{ provider: 'alpha', model: 'parent' }] },
          })
        },
      })
      ctx.on('agent/pre-step', async ({ agent }, next) => (
        agent === handle?.agent ? { kind: 'reject' as const } : next()
      ))

      const started = await callSubagent(ctx, handle.agent, {
        description: 'default resume child',
        prompt: 'first turn',
        provider: 'alpha',
        model: 'parent',
      })
      expect(started.isError).toBe(false)
      const match = /^started subagent (\S+)$/.exec(resultText(started))
      expect(match).not.toBeNull()
      const childId = SessionId(match![1]!)
      await vi.waitFor(() => {
        expect(ctx.agents.get(childId)).toBeUndefined()
      }, { timeout: 5_000 })

      const initial = await ctx.sessionPersistence.load(childId)
      expect(initial.events.find(event => event.type === 'subagent/descriptor')?.data)
        .not.toHaveProperty('agentReasoningEffort')
      expect(initial.events.find(event => event.type === 'request/header')?.data)
        .toMatchObject({
          header: {
            config: { provider: 'alpha', model: 'parent', reasoningEffort: 'high' },
            adapterDefaults: { reasoningEffort: true },
          },
        })

      await ctx.subagents.followup(
        handle.agent,
        childId,
        [{ type: 'text', text: 'continue' }],
        { source: { kind: 'user' }, signal },
      )
      await vi.waitFor(() => {
        expect(ctx.agents.get(childId)).toBeUndefined()
      }, { timeout: 5_000 })
      expect(adapter.requests.map(request => request.reasoningEffort)).toEqual(['high', 'high'])
      const resumed = await ctx.sessionPersistence.load(childId)
      expect(resumed.events.filter(event => event.type === 'request/header').at(-1)?.data)
        .toMatchObject({
          reason: 'resume',
          header: {
            config: { provider: 'alpha', model: 'parent', reasoningEffort: 'high' },
            adapterDefaults: { reasoningEffort: true },
          },
        })
    } finally {
      await handle?.dispose()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('preserves enabled restores and keeps a restored legacy Session disabled', async () => {
    const { ctx } = await boot()
    const enabledSeed = Session.create(SessionId('enabled-seed'))
    recordSubagentModelSelection(enabledSeed, ALLOWED_MODELS)
    const enabled = await createWithPolicy(ctx, 'enabled-restore', { seed: enabledSeed.events })
    const enabledProps = (ctx.tools.schemas(enabled.agent).find(candidate => candidate.name === 'subagent')!
      .parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(enabledProps).toHaveProperty('provider')

    const legacySeed = Session.create(SessionId('legacy-seed'), [])
    const legacy = await createWithPolicy(ctx, 'legacy-restore', { seed: legacySeed.events })
    const legacyProps = (ctx.tools.schemas(legacy.agent).find(candidate => candidate.name === 'subagent')!
      .parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(legacyProps).sort()).toEqual(['description', 'prompt', 'run_in_background'])
    expect(ctx.tools.get('list_subagent_models', legacy.agent)).toBeUndefined()
    expect(subagentModelSelectionPolicy(legacy.agent.session)).toBeUndefined()

    const forced = await callSubagent(ctx, legacy.agent, {
      description: 'forced child',
      prompt: 'do work',
      provider: 'alpha',
      model: 'fast',
    })
    expect(forced.isError).toBe(true)
    expect(resultText(forced)).toContain('disabled for this Session')
    await enabled.dispose()
    await legacy.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps a raw empty restored Session without policy or selectable fields', async () => {
    const { ctx } = await boot()
    const handle = await createWithPolicy(ctx, 'empty-restore', { seed: [] })
    try {
      expect(handle.agent.session.firstLiveSeq).toBe(0)
      expect(handle.agent.session.events[0]?.type).toBe('session/end-seed')
      expect(subagentModelSelectionPolicy(handle.agent.session)).toBeUndefined()
      const properties = (ctx.tools.schemas(handle.agent).find(candidate => candidate.name === 'subagent')!
        .parameters as { properties?: Record<string, unknown> }).properties ?? {}
      expect(Object.keys(properties).sort()).toEqual(['description', 'prompt', 'run_in_background'])
      expect(ctx.tools.get('list_subagent_models', handle.agent)).toBeUndefined()
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('inherits the live parent policy instead of recapturing child configuration', async () => {
    const { ctx } = await boot()
    const parent = await createWithPolicy(ctx, 'selection-parent')
    const child = await createWithPolicy(ctx, 'selection-child', {
      parentSession: parent.agent.id,
      allowedModels: [{ provider: 'alpha', model: 'blocked' }],
    })

    expect(subagentModelSelectionPolicy(child.agent.session)).toEqual(ALLOWED_MODELS)
    const allowed = await callSubagent(ctx, child.agent, {
      description: 'inherited route',
      prompt: 'do work',
      provider: 'alpha',
      model: 'fast',
    })
    expect(allowed.isError).toBe(false)
    await child.dispose()
    await parent.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps delegation tools outside a restricted child whose allow-list excludes them', async () => {
    const { ctx } = await boot('spawn', { agentOptions: true })
    const standing = await mountStandingSelectionTool(ctx, {
      provider: 'spawn',
      maxDepth: 'provider-managed',
      modelSelectionPolicy: { allowedModels: ALLOWED_MODELS },
    })
    const parent = await ctx.agents.create({
      sessionId: SessionId('restricted-parent'),
      agentOptions: { provider: 'alpha', model: 'parent' },
      setup: (agentCtx) => {
        if (agentCtx.agent === undefined) throw new Error('restricted parent Agent is unavailable')
        bindScopeParent(agentCtx.agent, standing.compositionCarrier)
      },
    })
    const handle = await ctx.agents.create({
      sessionId: SessionId('restricted-child'),
      meta: { origin: 'subagent', parentSession: parent.agent.id },
      agentOptions: { provider: 'alpha', model: 'parent' },
      setup: (agentCtx) => {
        if (agentCtx.agent === undefined) throw new Error('restricted child Agent is unavailable')
        bindScopeParent(agentCtx.agent, standing.compositionCarrier)
        applyChildComposition(agentCtx, parent.agent, { toolFilter: { allow: [] } })
      },
    })

    expect(ctx.tools.get('subagent', handle.agent)).toBeUndefined()
    expect(ctx.tools.get('list_subagent_models', handle.agent)).toBeUndefined()
    await handle.dispose()
    await parent.dispose()
    await standing.fiber.dispose()
    await ctx.fiber.dispose()
  })

  it.each([
    ['spawn', SubagentSpawn],
    ['fork', SubagentFork],
  ] as const)('enforces a real restricted %s child before discovery or delegation can execute', async (_name, provider) => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(provider, { providerName: 'local' })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([textResponse('restricted child complete')], REASONING))
    const standing = await mountStandingSelectionTool(ctx, {
      provider: 'local',
      maxDepth: 'provider-managed',
      toolFilter: { allow: [] },
      modelSelectionPolicy: { allowedModels: ALLOWED_MODELS },
    }, true)
    let observed: { delegation: boolean; discovery: boolean } | undefined
    const forced: Promise<{ isError?: boolean }>[] = []
    ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.origin !== 'subagent') return
      observed = {
        delegation: ctx.tools.get('subagent', agent) !== undefined,
        discovery: ctx.tools.get('list_subagent_models', agent) !== undefined,
      }
      forced.push(
        ctx.tools.execute({
          signal,
          callId: CallId(`restricted-delegation-${agent.id}`),
          name: 'subagent',
          arguments: { description: 'must fail', prompt: 'must not run' },
          agent,
        }),
        ctx.tools.execute({
          signal,
          callId: CallId(`restricted-discovery-${agent.id}`),
          name: 'list_subagent_models',
          arguments: {},
          agent,
        }),
      )
    })
    const parent = await ctx.agents.create({
      sessionId: SessionId(`real-restricted-${_name}-parent`),
      agentOptions: { provider: 'alpha', model: 'parent' },
      setup: (agentCtx) => {
        if (agentCtx.agent === undefined) throw new Error('restricted parent Agent is unavailable')
        bindScopeParent(agentCtx.agent, standing.compositionCarrier)
      },
    })

    const result = await callSubagent(ctx, parent.agent, {
      description: 'restricted real child',
      prompt: 'finish without tools',
    })

    expect(result.isError).toBe(false)
    expect(observed).toEqual({ delegation: false, discovery: false })
    expect(await Promise.all(forced)).toEqual([
      expect.objectContaining({ isError: true }),
      expect.objectContaining({ isError: true }),
    ])
    await parent.dispose()
    await standing.fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('does not treat an inherited fork descriptor as the new child restriction', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentFork, { providerName: 'fork' })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter(['hang'], REASONING))
    const standing = await mountStandingSelectionTool(ctx, {
      provider: 'fork',
      maxDepth: 'provider-managed',
      modelSelectionPolicy: { allowedModels: ALLOWED_MODELS },
    }, true)
    const ancestor = Session.create(SessionId('ancestor-descriptor-seed'))
    ancestor.append('subagent/descriptor', {
      version: 2,
      mode: 'one-shot',
      provider: 'fork',
      toolFilter: { allow: [] },
    })
    let childAgent: Agent | undefined
    ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.origin === 'subagent') {
        childAgent = agent
      }
    })
    const parent = await ctx.agents.create({
      sessionId: SessionId('ancestor-descriptor-parent'),
      seed: ancestor.events,
      agentOptions: { provider: 'alpha', model: 'parent' },
      setup: (agentCtx) => {
        if (agentCtx.agent === undefined) throw new Error('fork parent Agent is unavailable')
        bindScopeParent(agentCtx.agent, standing.compositionCarrier)
      },
    })

    const controller = new AbortController()
    const running = ctx.tools.execute({
      signal: controller.signal,
      callId: CallId('ancestor-descriptor-fork'),
      name: 'subagent',
      arguments: {
        description: 'unrestricted fork child',
        prompt: 'remain active',
      },
      agent: parent.agent,
    })

    await vi.waitFor(() => {
      expect(childAgent).toBeDefined()
      expect(ctx.tools.get('subagent', childAgent)).toBeDefined()
    })
    controller.abort()
    await running
    await parent.dispose()
    await standing.fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('allows a policy-bearing restricted continuable fork to run and cold-resume', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-tool-subagent-restricted-resume-'))
    const ctx = new Context()
    let parent: Awaited<ReturnType<typeof ctx.agents.create>> | undefined
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(Invariants)
      await ctx.plugin(JsonlSessionPersistence, { root })
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(SubagentFork, { providerName: 'fork' })
      const adapter = new MockAdapter([
        textResponse('parent complete'),
        textResponse('child initial complete'),
        textResponse('child resumed complete'),
      ], REASONING)
      ctx.llm.registerAdapter(['alpha'], adapter)
      const standing = await mountStandingSelectionTool(ctx, {
        provider: 'fork',
        maxDepth: 'provider-managed',
        backgroundMode: 'continuable',
        toolFilter: { allow: [] },
        modelSelectionPolicy: { allowedModels: ALLOWED_MODELS },
      }, true)
      parent = await ctx.agents.create({
        sessionId: SessionId('restricted-resume-parent'),
        agentOptions: { provider: 'alpha', model: 'parent' },
        setup: (agentCtx) => {
          if (agentCtx.agent === undefined) throw new Error('restricted resume parent is unavailable')
          bindScopeParent(agentCtx.agent, standing.compositionCarrier)
        },
      })
      parent.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'complete a seed turn' }],
        source: { kind: 'user' },
      }))
      await parent.agent.whenIdle()
      ctx.on('agent/pre-step', async ({ agent }, next) => (
        agent === parent?.agent ? { kind: 'reject' as const } : next()
      ))

      const started = await callSubagent(ctx, parent.agent, {
        description: 'restricted resumable child',
        prompt: 'first child turn',
        provider: 'alpha',
        model: 'fast',
      })
      expect(started.isError).toBe(false)
      const match = /^started subagent (\S+)$/.exec(resultText(started))
      expect(match).not.toBeNull()
      const childId = SessionId(match![1]!)
      await vi.waitFor(() => {
        expect(ctx.agents.get(childId)).toBeUndefined()
      }, { timeout: 5_000 })
      const initial = await ctx.sessionPersistence.load(childId)
      expect(initial.events.filter(event => event.type === 'turn/end').at(-1)?.data.reason)
        .toEqual({ kind: 'completed' })

      await ctx.subagents.followup(
        parent.agent,
        childId,
        [{ type: 'text', text: 'second child turn' }],
        { source: { kind: 'user' }, signal },
      )
      await vi.waitFor(() => {
        expect(ctx.agents.get(childId)).toBeUndefined()
      }, { timeout: 5_000 })
      const resumed = await ctx.sessionPersistence.load(childId)
      expect(resumed.events.filter(event => event.type === 'turn/end').at(-1)?.data.reason)
        .toEqual({ kind: 'completed' })
      expect(resumed.events.filter(event => event.type === 'turn/end')).toHaveLength(3)
      await standing.fiber.dispose()
    } finally {
      await parent?.dispose()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('removes sampled Agent tools when the standing plugin unloads', async () => {
    const { ctx } = await boot('spawn', { agentOptions: true })
    const standing = await mountStandingSelectionTool(ctx, {
      provider: 'spawn',
      maxDepth: 'provider-managed',
      modelSelectionPolicy: { allowedModels: ALLOWED_MODELS },
    })
    const handle = await ctx.agents.create({
      sessionId: SessionId('standing-unload-agent'),
      agentOptions: { provider: 'alpha', model: 'parent' },
      setup: (agentCtx) => {
        if (agentCtx.agent === undefined) throw new Error('standing Agent is unavailable')
        bindScopeParent(agentCtx.agent, standing.compositionCarrier)
      },
    })
    expect(ctx.tools.get('subagent', handle.agent)).toBeDefined()

    await standing.fiber.dispose()

    expect(ctx.tools.get('subagent', handle.agent)).toBeUndefined()
    expect(ctx.tools.get('list_subagent_models', handle.agent)).toBeUndefined()
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('restores sampled Agent tools immediately when the standing plugin remounts', async () => {
    const { ctx } = await boot('spawn', { agentOptions: true })
    const config: tool.Config = {
      provider: 'spawn',
      maxDepth: 'provider-managed',
      modelSelectionPolicy: { allowedModels: ALLOWED_MODELS },
    }
    const standing = await mountStandingSelectionTool(ctx, config)
    const handle = await ctx.agents.create({
      sessionId: SessionId('standing-remount-agent'),
      agentOptions: { provider: 'alpha', model: 'parent' },
      setup: (agentCtx) => {
        if (agentCtx.agent === undefined) throw new Error('standing Agent is unavailable')
        bindScopeParent(agentCtx.agent, standing.compositionCarrier)
      },
    })
    expect(ctx.tools.get('subagent', handle.agent)).toBeDefined()

    await standing.fiber.dispose()
    expect(ctx.tools.get('subagent', handle.agent)).toBeUndefined()

    const remounted = await standing.compositionCtx.plugin(tool, config)
    expect(ctx.tools.get('subagent', handle.agent)).toBeDefined()
    expect(ctx.tools.get('list_subagent_models', handle.agent)).toBeDefined()

    await remounted.dispose()
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it.each(['acp', 'codex', 'claude-code', 'spawn'])('rejects a capability-less %s provider alias', async (provider) => {
    const { ctx } = await boot(provider, {})
    await expect(createWithPolicy(ctx, `rejected-${provider}`, { provider }))
      .rejects.toThrow('does not advertise the agentOptions capability')
    await ctx.fiber.dispose()
  })

  it('keeps an ACP-backed legacy restore fixed-route instead of applying configured dynamic policy', async () => {
    const { ctx, requests } = await boot('acp', { agentOptions: true })
    const legacySeed = Session.create(SessionId('legacy-acp-seed'), [])
    const handle = await createWithPolicy(ctx, 'legacy-acp-restore', {
      provider: 'acp',
      seed: legacySeed.events,
    })
    const schema = ctx.tools.schemas(handle.agent).find(candidate => candidate.name === 'subagent')!
    const properties = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(properties).sort()).toEqual(['description', 'prompt', 'run_in_background'])

    const result = await callSubagent(ctx, handle.agent, {
      description: 'fixed child',
      prompt: 'do work',
    })
    expect(result.isError).toBe(false)
    expect(requests).toHaveLength(1)
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('requires DSH SDK to advertise route-option support', async () => {
    const unsupported = await boot('dsh-sdk', {})
    await expect(createWithPolicy(unsupported.ctx, 'sdk-without-capability', { provider: 'dsh-sdk' }))
      .rejects.toThrow('does not advertise the agentOptions capability')
    await unsupported.ctx.fiber.dispose()

    const supported = await boot('dsh-sdk', { agentOptions: true })
    const handle = await createWithPolicy(supported.ctx, 'sdk-with-capability', { provider: 'dsh-sdk' })
    const result = await callSubagent(supported.ctx, handle.agent, {
      description: 'sdk child',
      prompt: 'do work',
      provider: 'alpha',
      model: 'careful',
    })
    expect(result.isError).toBe(false)
    expect(supported.requests[0]?.agentOptions).toMatchObject({ provider: 'alpha', model: 'careful' })
    await handle.dispose()
    await supported.ctx.fiber.dispose()
  })
})
