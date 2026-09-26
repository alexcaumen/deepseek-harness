import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import ModelLifecycleRuntime, { createModelExecutionScopeDigest } from '@deepseek-ai/dsh-model-lifecycle'
import type {
  AcquireModelRouteRequest,
  GovernedModelRoute,
  ModelLifecycleDriver,
  ModelLifecycleStage,
  ModelLifecycleStageContext,
  ModelLifecycleStageReceipt,
} from '@deepseek-ai/dsh-model-lifecycle'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { closeMockServers, mockServer, textEvents } from '../../llm-pi-ai/tests/mock-server.ts'
import { fixtureResources } from '../../model-lifecycle/tests/resource-fixture.ts'

const model = 'managed-local-model'
const provider = 'governed-local'
const sessionId = SessionId('dispatch-integration-session')
const admissionReceiptDigest = `sha256:${'a'.repeat(64)}`
const revisionDigest = `sha256:${'b'.repeat(64)}`
const route: GovernedModelRoute = {
  id: 'dispatch-integration-route',
  selection: { provider, model },
  disposition: 'AVAILABLE',
  admissionReceiptDigest,
  revisionDigest,
  targets: ['r5300'],
  allowRamCpuOffload: false,
}

const contexts: Context[] = []

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  } finally {
    await closeMockServers()
    vi.unstubAllEnvs()
  }
})

function receipt(stage: ModelLifecycleStage, context: ModelLifecycleStageContext): ModelLifecycleStageReceipt {
  return {
    stage,
    routeId: context.route.id,
    target: context.target,
    revisionDigest: context.route.revisionDigest,
    scopeDigest: context.scope.digest,
    transactionDigest: context.transactionDigest,
    fencingDigest: context.resourceLease.fencingDigest,
    digest: `sha256:${'c'.repeat(64)}`,
  }
}

function driver(events: string[], failPreflight = false): ModelLifecycleDriver {
  const complete = (stage: ModelLifecycleStage, context: ModelLifecycleStageContext) => {
    events.push(stage)
    return receipt(stage, context)
  }
  return {
    preflight: async (context) => {
      events.push('preflight')
      return failPreflight
        ? { ok: false, reason: 'synthetic capacity denial' }
        : { ok: true, receipt: receipt('preflight', context) }
    },
    capturePrestate: async context => ({ ...complete('prestate', context), residency: { kind: 'EMPTY' } }),
    drain: async context => complete('drain', context),
    stop: async context => complete('stop', context),
    verifyStopped: async context => complete('verify-stopped', context),
    start: async context => complete('start', context),
    health: async context => ({ ok: true, receipt: complete('health', context) }),
    probe: async (context) => {
      return { ok: true, receipt: complete('probe', context) }
    },
  }
}

async function harness(
  baseURL: string,
  events: string[],
  options: { acquisitionGate?: Promise<void>; failPreflight?: boolean; deny?: boolean } = {},
): Promise<Context> {
  vi.stubEnv('DISPATCH_INTEGRATION_KEY', 'test-key')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  class GatedLifecycleRuntime extends ModelLifecycleRuntime {
    override async acquireRoute(request: AcquireModelRouteRequest) {
      const lease = await super.acquireRoute(request)
      events.push('acquired')
      await options.acquisitionGate
      return lease
    }
  }
  await ctx.plugin(GatedLifecycleRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: {
      [provider]: {
        api: 'openai-completions',
        apiKeyEnv: 'DISPATCH_INTEGRATION_KEY',
        baseURL: `${baseURL}/v1`,
        models: [{ id: model }],
        availabilityProbe: { model, timeoutMs: 1_000, phase: 'dispatch' },
      },
    },
  })
  ctx.sessions.create(sessionId)
  ctx.llm.registerModelOwnership([route.selection])
  ctx.modelLifecycle.register(route, driver(events, options.failPreflight))
  ctx.modelLifecycle.installResources(fixtureResources())
  ctx.modelLifecycle.installAuthority({
    classifyProvider: name => name === provider ? 'GOVERNED_LOCAL' : 'UNMANAGED_EXTERNAL',
    resolve: () => {
      if (options.deny) return { kind: 'HELD', routeId: route.id, reason: 'synthetic denial' }
      const fields = {
        workId: 'dispatch-integration-work',
        principalId: 'dispatch-integration-principal',
        tenantId: 'dispatch-integration-tenant',
        sessionId: String(sessionId),
      }
      return {
        kind: 'GOVERNED',
        route,
        scope: { ...fields, digest: createModelExecutionScopeDigest(fields) },
      }
    },
    record: async () => {},
  })
  return ctx
}

async function collect(ctx: Context, selectedModel = model, selectedProvider = provider): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream({ provider: selectedProvider, model: selectedModel, messages: [], sessionId })) {
    chunks.push(chunk)
  }
  return chunks
}

describe('governed llm-pi-ai dispatch integration', () => {
  it('waits for lifecycle acquisition before probing models or sending chat', async () => {
    const server = await mockServer([
      { body: JSON.stringify({ data: [{ id: model }] }) },
      { events: textEvents },
    ])
    const events: string[] = []
    let completeAcquisition!: () => void
    const acquisitionGate = new Promise<void>((resolve) => { completeAcquisition = resolve })
    const ctx = await harness(server.url, events, { acquisitionGate })
    const pending = collect(ctx)
    try {
      await vi.waitFor(() => expect(events).toContain('acquired'))
      expect(server.paths).toEqual([])
    } finally {
      completeAcquisition()
    }
    const chunks = await pending
    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(true)
    expect(server.paths).toEqual(['/v1/models', '/v1/chat/completions'])
    expect(events).toContain('probe')
  })

  it('leaves HTTP untouched when lifecycle preflight fails', async () => {
    const server = await mockServer([])
    const events: string[] = []
    const ctx = await harness(server.url, events, { failPreflight: true })
    await expect(collect(ctx)).rejects.toMatchObject({ code: 'NO_CAPACITY' })
    expect(events).toEqual(['preflight'])
    expect(server.paths).toEqual([])
  })

  it('leaves HTTP untouched when governance denies the route', async () => {
    const server = await mockServer([])
    const events: string[] = []
    const ctx = await harness(server.url, events, { deny: true })
    await expect(collect(ctx)).rejects.toMatchObject({ code: 'ROUTE_HELD' })
    expect(events).toEqual([])
    expect(server.paths).toEqual([])
  })

  it('rejects a reserved model on the wrong provider before lifecycle stages or HTTP dispatch', async () => {
    const server = await mockServer([])
    const events: string[] = []
    const ctx = await harness(server.url, events)
    const chunks = await collect(ctx, model, 'foreign-provider')
    expect(chunks).toEqual([expect.objectContaining({
      type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_PROVIDER_MISMATCH', message: expect.any(String) } },
    })])
    expect(events).toEqual(['acquired'])
    expect(server.paths).toEqual([])
  })
})
