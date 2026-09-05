import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Lifecycle, { createModelExecutionScopeDigest } from '../src/index.ts'
import { fixtureResources } from './resource-fixture.ts'
import type {
  GovernedModelRoute,
  ModelLifecycleAuditRecord,
  ModelLifecycleConfig,
  ModelLifecyclePrestateReceipt,
  ModelLifecycleStage,
  ModelLifecycleStageContext,
  ModelLifecycleStageReceipt,
} from '../src/index.ts'

const digest = `sha256:${'a'.repeat(64)}`
const route: GovernedModelRoute = {
  id: 'fixture-local', selection: { provider: 'fixture-local', model: 'fixture-model' },
  disposition: 'AVAILABLE', admissionReceiptDigest: digest, revisionDigest: digest,
  targets: ['r5300'], allowRamCpuOffload: false,
}
let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  try {
    await ctx?.fiber.dispose()
  } finally {
    ctx = undefined
    if (root !== undefined) {
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('fixture cleanup escaped temp root')
      await rm(root, { recursive: true, force: true })
      root = undefined
    }
  }
})

async function boot(
  residency: ModelLifecyclePrestateReceipt['residency'],
  config: ModelLifecycleConfig = {},
  beforeReply?: () => Promise<void>,
) {
  const stages: string[] = []
  const records: ModelLifecycleAuditRecord[] = []
  let requests = 0
  const receipt = (stage: ModelLifecycleStage, context: ModelLifecycleStageContext): ModelLifecycleStageReceipt => {
    stages.push(stage)
    return {
      stage, routeId: context.route.id, target: context.target,
      revisionDigest: context.route.revisionDigest, scopeDigest: context.scope.digest,
      transactionDigest: context.transactionDigest, digest,
      fencingDigest: context.resourceLease.fencingDigest,
    }
  }
  class FixtureAdapter extends LlmAdapter {
    async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests++
      await beforeReply?.()
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'LOCAL_INFERENCE_OK' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'LOCAL_INFERENCE_OK' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const hostFixture = {
    name: 'test-only-local-host',
    inject: ['llm', 'modelLifecycle'],
    apply(context: Context) {
      context.llm.registerAdapter(['fixture-local'], new FixtureAdapter())
      context.modelLifecycle.installResources(fixtureResources())
      context.modelLifecycle.installAuthority({
        classifyProvider: provider => provider === 'fixture-local' ? 'GOVERNED_LOCAL' : 'UNMANAGED_EXTERNAL',
        resolve: (request) => {
          const scope = { workId: 'fixture-work', principalId: 'fixture-user', tenantId: 'fixture-tenant',
            sessionId: request.sessionId! }
          return { kind: 'GOVERNED', route, scope: { ...scope, digest: createModelExecutionScopeDigest(scope) } }
        },
        record: async (record) => { records.push(record) },
      })
      context.modelLifecycle.register(route, {
        capturePrestate: async stage => ({ ...receipt('prestate', stage), residency }),
        preflight: async stage => ({ ok: true, receipt: receipt('preflight', stage) }),
        drain: async stage => receipt('drain', stage),
        stop: async stage => receipt('stop', stage),
        verifyStopped: async (stage) => {
          residency = { kind: 'EMPTY' }
          return receipt('verify-stopped', stage)
        },
        start: async (stage) => {
          residency = { kind: 'RESIDENT', routeId: route.id, revisionDigest: route.revisionDigest }
          return receipt('start', stage)
        },
        health: async stage => ({ ok: true, receipt: receipt('health', stage) }),
        probe: async stage => ({ ok: true, receipt: receipt('probe', stage) }),
      })
    },
  }
  root = await mkdtemp(join(tmpdir(), 'giana-lifecycle-loader-'))
  const configPath = join(root, 'cordis.yml')
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-model-lifecycle', Lifecycle],
    ['test-only-local-host', hostFixture],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])
  await writeFile(configPath, [...modules.keys()].map(name =>
    `- name: '${name}'${name === '@deepseek-ai/dsh-model-lifecycle' ? `\n  config: ${JSON.stringify(config)}` : ''}`,
  ).join('\n') + '\n')
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const agent = ctx.agentLoop.create(SessionId('isolated-lifecycle-fixture'), route.selection)
  return { agent, stages, records, requests: () => requests }
}

it.each([
  { config: { maxPendingRequests: 0 }, code: 'QUEUE_FULL', message: 'Local model queue is full; retry after a request completes' },
  { config: { queueTimeoutMs: 20 }, code: 'QUEUE_TIMEOUT', message: 'Local model queue wait timed out; the active request was not stopped' },
])('records $code through the assembled loop while the original inference completes', async ({ config, code, message }) => {
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  const fixture = await boot({ kind: 'EMPTY' }, config, () => gate)
  try {
    fixture.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'First request.' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(fixture.requests()).toBe(1) })
    const second = ctx!.agentLoop.create(SessionId('isolated-lifecycle-second'), route.selection)
    second.followup(createUserMessage({ content: [{ type: 'text', text: 'Second request.' }], source: { kind: 'user' } }))
    await second.whenIdle()
    expect(second.session.events.filter(event => event.type === 'turn/end').map(event => event.data.reason))
      .toEqual([{ kind: 'error', error: { code, message } }])
    expect(fixture.requests()).toBe(1)
    expect(fixture.stages).not.toContain('stop')
  } finally {
    finish()
    await fixture.agent.whenIdle()
  }
  expect(fixture.agent.session.deriveMessages().at(-1)).toMatchObject({
    role: 'assistant', content: [{ type: 'text', text: 'LOCAL_INFERENCE_OK' }],
  })
})

it('runs a recorded turn through the YAML-mounted lifecycle and releases after inference', async () => {
  const fixture = await boot({ kind: 'EMPTY' })
  fixture.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run local fixture.' }], source: { kind: 'user' } }))
  await fixture.agent.whenIdle()
  expect(fixture.agent.session.events.filter(event => event.type === 'turn/end').map(event => event.data.reason))
    .not.toContainEqual(expect.objectContaining({ kind: 'error' }))
  expect(fixture.requests()).toBe(1)
  expect(fixture.agent.session.deriveMessages().at(-1)).toMatchObject({
    role: 'assistant', content: [{ type: 'text', text: 'LOCAL_INFERENCE_OK' }],
  })
  const effectiveRoutes = fixture.agent.session.events.filter(event =>
    event.type === 'model-lifecycle/effective-route')
  expect(effectiveRoutes).toHaveLength(1)
  const effectiveRoute = effectiveRoutes[0]!
  const requestHeader = fixture.agent.session.events.findLast(event =>
    event.type === 'request/header' && event.seq < effectiveRoute.seq)
  const providerOutput = fixture.agent.session.events.find(event =>
    event.type === 'assistant/chunk' && event.seq > effectiveRoute.seq)
  expect(requestHeader).toBeDefined()
  expect(providerOutput).toBeDefined()
  expect(requestHeader!.seq).toBeLessThan(effectiveRoute.seq)
  expect(effectiveRoute.seq).toBeLessThan(providerOutput!.seq)
  expect({ stages: fixture.stages, outcomes: fixture.records.map(record => record.outcome) }).toMatchInlineSnapshot(`
    {
      "outcomes": [
        "READY",
        "RELEASED",
      ],
      "stages": [
        "preflight",
        "prestate",
        "start",
        "health",
        "probe",
      ],
    }
  `)
})

it('records a sanitized turn failure instead of executing against unknown preexisting residency', async () => {
  const fixture = await boot({ kind: 'RESIDENT', routeId: 'another-client-route', revisionDigest: digest })
  fixture.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run local fixture.' }], source: { kind: 'user' } }))
  await fixture.agent.whenIdle()
  expect(fixture.requests()).toBe(0)
  expect(fixture.stages).toEqual(['preflight', 'prestate'])
  expect(fixture.agent.session.events).not.toContainEqual(
    expect.objectContaining({ type: 'model-lifecycle/effective-route' }),
  )
  expect(fixture.agent.session.events.filter(event => event.type === 'turn/end').map(event => event.data.reason))
    .toMatchInlineSnapshot(`
      [
        {
          "error": {
            "code": "RESIDENCY_UNVERIFIED",
            "message": "The host model residency differs from this runtime; owner reconciliation is required before resource changes",
          },
          "kind": "error",
        },
      ]
    `)
})
