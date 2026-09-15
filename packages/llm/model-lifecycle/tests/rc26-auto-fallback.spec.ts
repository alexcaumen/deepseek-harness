import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ModelLifecycleRuntime, { createModelExecutionScopeDigest } from '../src/index.ts'
import type {
  AcquireModelRouteRequest,
  GovernedModelRoute,
  ModelExecutionScope,
  ModelLifecycleDriver,
  ModelLifecycleStage,
  ModelLifecycleStageContext,
  ModelLifecycleStageReceipt,
  ResourceLeaseProvider,
} from '../src/index.ts'
import { fixtureResources } from './resource-fixture.ts'

const registryPath = fileURLToPath(new URL(
  '../../../../configs/giana-cowork-preview/gcp.model-registry.json',
  import.meta.url,
))
const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
  admissionDigest: string
  routes: Array<{
    id: string
    revisionDigest: string
    target: 'r5300' | 'prdg'
    runtime: { expectedModel: string }
  }>
}
const qwenDeployments = registry.routes.filter(route => route.id === 'qwen38-local')
const contexts: Context[] = []
let receiptSequence = 0

class SessionBoundLifecycleRuntime extends ModelLifecycleRuntime {
  override async acquireRoute(request: AcquireModelRouteRequest) {
    const sessionId = SessionId(request.sessionId ?? 'rc26-f01-session')
    if (this.ctx.sessions.get(sessionId) === undefined) this.ctx.sessions.create(sessionId)
    return await super.acquireRoute({ ...request, sessionId })
  }
}

function digest(value: string): string {
  return `sha256:${value}`
}

function receipt(stage: ModelLifecycleStage, context: ModelLifecycleStageContext): ModelLifecycleStageReceipt {
  receiptSequence += 1
  return {
    stage,
    routeId: context.route.id,
    target: context.target,
    revisionDigest: context.route.revisionDigest,
    scopeDigest: context.scope.digest,
    transactionDigest: context.transactionDigest,
    fencingDigest: context.resourceLease.fencingDigest,
    digest: digest(receiptSequence.toString(16).padStart(64, '0')),
  }
}

function qwenRoute(): GovernedModelRoute {
  const [r5300, prdg] = qwenDeployments
  if (r5300 === undefined || prdg === undefined) throw new Error('RC26 Qwen dual-host registry rows are missing')
  return {
    id: r5300.id,
    selection: { provider: 'qwen-local-r5300', model: r5300.runtime.expectedModel },
    disposition: 'AVAILABLE',
    admissionReceiptDigest: digest(registry.admissionDigest),
    revisionDigest: digest(r5300.revisionDigest),
    targets: ['r5300', 'prdg'],
    allowRamCpuOffload: false,
    allowExactResidentAdoption: true,
    supportedReasoningEfforts: ['low', 'medium', 'xhigh'],
  }
}

function scope(sessionId: string): ModelExecutionScope {
  const fields = {
    workId: 'giana-cowork-preview-local-model-heqa-20260911',
    principalId: 'alex',
    tenantId: 'giana-cowork-preview',
    sessionId,
  }
  return { ...fields, digest: createModelExecutionScopeDigest(fields) }
}

function deterministicDriver(stages: string[], forbiddenMutations: string[]): ModelLifecycleDriver {
  const complete = (stage: ModelLifecycleStage, context: ModelLifecycleStageContext) => {
    stages.push(`${stage}:${context.route.id}:${context.target}`)
    return receipt(stage, context)
  }
  const forbidden = async (stage: 'drain' | 'stop' | 'verify-stopped', context: ModelLifecycleStageContext) => {
    forbiddenMutations.push(`${stage}:${context.route.id}:${context.target}`)
    throw new Error(`RC26 F01 unexpectedly attempted ${stage}`)
  }
  return {
    preflight: async (context) => {
      stages.push(`preflight:${context.route.id}:${context.target}`)
      if (context.target === 'r5300') return { ok: false, reason: 'VRAM_INSUFFICIENT_PRE_MUTATION' }
      return { ok: true, receipt: receipt('preflight', context) }
    },
    capturePrestate: async context => ({ ...complete('prestate', context), residency: { kind: 'EMPTY' } }),
    drain: context => forbidden('drain', context),
    stop: context => forbidden('stop', context),
    verifyStopped: context => forbidden('verify-stopped', context),
    start: async context => complete('start', context),
    health: async context => ({ ok: true, receipt: complete('health', context) }),
    probe: async context => ({ ok: true, receipt: complete('probe', context) }),
  }
}

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  vi.restoreAllMocks()
})

describe('RC26 F01 automatic Qwen fallback evidence', () => {
  it('binds the current Qwen revision to PRDG after a known pre-mutation R5300 rejection', async () => {
    expect(qwenDeployments.map(route => route.target)).toEqual(['r5300', 'prdg'])
    expect(new Set(qwenDeployments.map(route => route.revisionDigest))).toHaveLength(1)
    expect(new Set(qwenDeployments.map(route => route.runtime.expectedModel))).toHaveLength(1)

    const context = new Context()
    contexts.push(context)
    await context.plugin(SessionStore)
    await context.plugin(SessionBoundLifecycleRuntime, { preference: 'automatic', idleUnloadMs: 0 })

    const route = qwenRoute()
    const stages: string[] = []
    const forbiddenMutations: string[] = []
    const baseResources = fixtureResources()
    const acquisitions: string[][] = []
    const releases: string[] = []
    const resources: ResourceLeaseProvider = {
      ...baseResources,
      acquire: async (request, signal) => {
        acquisitions.push([...request.targets])
        return await baseResources.acquire(request, signal)
      },
      release: async (grant, reason, signal) => {
        releases.push(`${grant.targets.join('+')}:${reason}`)
        await baseResources.release(grant, reason, signal)
      },
    }
    context.modelLifecycle.register(route, deterministicDriver(stages, forbiddenMutations))
    context.modelLifecycle.installResources(resources)
    const audit = vi.fn(async (_event: unknown) => {})
    context.modelLifecycle.installAuthority({
      classifyProvider: provider => provider === route.selection.provider ? 'GOVERNED_LOCAL' : 'UNMANAGED_EXTERNAL',
      resolve: request => ({
        kind: 'GOVERNED',
        route,
        scope: scope(request.sessionId ?? 'rc26-f01-session'),
      }),
      record: audit,
    })

    const sessionId = 'rc26-f01-session'
    const lease = await context.modelLifecycle.acquireRoute({
      sessionId,
      selection: route.selection,
      preference: 'automatic',
    })

    expect(lease).toMatchObject({ managed: true, routeId: 'qwen38-local', target: 'prdg' })
    expect(Object.isFrozen(lease)).toBe(true)
    expect(acquisitions).toEqual([['r5300'], ['prdg']])
    expect(releases).toEqual(['r5300:SETTLED'])
    expect(stages).toEqual([
      'preflight:qwen38-local:r5300',
      'preflight:qwen38-local:prdg',
      'prestate:qwen38-local:prdg',
      'start:qwen38-local:prdg',
      'health:qwen38-local:prdg',
      'probe:qwen38-local:prdg',
    ])
    expect(forbiddenMutations).toEqual([])
    expect(stages.some(stage => /stop|reset/u.test(stage))).toBe(false)

    const events = context.sessions.get(SessionId(sessionId))!.events.filter(event =>
      event.type === 'model-lifecycle/effective-route')
    expect(events).toHaveLength(1)
    expect(events[0]!.data).toMatchObject({
      selection: route.selection,
      routeId: route.id,
      target: 'prdg',
      admissionReceiptDigest: route.admissionReceiptDigest,
      revisionDigest: route.revisionDigest,
      scopeDigest: scope(sessionId).digest,
    })
    const immutableBinding = structuredClone(events[0]!.data)
    await lease.release()
    expect(events[0]!.data).toEqual(immutableBinding)
    expect(audit.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      routeId: route.id,
      target: 'prdg',
      outcome: 'READY',
    }))
  })
})
