import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ModelLifecycleRuntime, {
  Config,
  ModelLifecycleStageRejectedError,
  ResourceLeaseError,
  createModelExecutionScopeDigest,
} from '../src/index.ts'
import { fixtureResources } from './resource-fixture.ts'
import type {
  AcquireModelRouteRequest,
  GovernedModelRoute,
  ModelComputeTarget,
  ModelExecutionScope,
  ModelLifecycleAuditRecord,
  ModelLifecycleConfig,
  ModelLifecycleDriver,
  ModelEvictionConsentRequest,
  ModelLifecyclePrestateReceipt,
  ModelLifecycleStage,
  ModelLifecycleStageContext,
  ModelLifecycleStageReceipt,
  ModelRouteResolution,
  ResourceLeaseGrant,
  ResourceLeaseProvider,
} from '../src/index.ts'

const digest = (digit: string): string => `sha256:${digit.repeat(64)}`
const ADMISSION_DIGEST = digest('a')
const REVISION_DIGEST = digest('b')
const DEFAULT_SCOPE_FIELDS = {
  workId: 'work-1',
  principalId: 'principal-1',
  tenantId: 'tenant-1',
  sessionId: 'session-1',
} as const
const OTHER_DIGEST = digest('d')
const TRANSACTION_DIGEST = digest('e')

class FixtureModelLifecycleRuntime extends ModelLifecycleRuntime {
  override async acquireRoute(request: AcquireModelRouteRequest) {
    const sessionId = SessionId(request.sessionId ?? DEFAULT_SCOPE_FIELDS.sessionId)
    if (this.ctx.sessions.get(sessionId) === undefined) this.ctx.sessions.create(sessionId)
    return await super.acquireRoute({ ...request, sessionId })
  }
}

let receiptSequence = 1

function nextReceiptDigest(): string {
  return `sha256:${(receiptSequence++).toString(16).padStart(64, '0')}`
}

function route(
  id: string,
  model: string,
  targets: readonly ModelComputeTarget[] = ['r5300', 'prdg'],
  overrides: Partial<GovernedModelRoute> = {},
): GovernedModelRoute {
  return {
    id,
    selection: { provider: 'local', model },
    disposition: 'AVAILABLE',
    admissionReceiptDigest: ADMISSION_DIGEST,
    revisionDigest: REVISION_DIGEST,
    targets,
    allowRamCpuOffload: targets.includes('ram-cpu'),
    ...overrides,
  }
}

function executionScope(overrides: Partial<ModelExecutionScope> = {}): ModelExecutionScope {
  const fields = {
    ...DEFAULT_SCOPE_FIELDS,
    ...overrides,
  }
  return {
    ...fields,
    digest: overrides.digest ?? createModelExecutionScopeDigest(fields),
  }
}

function stageReceipt(
  stage: ModelLifecycleStage,
  context: ModelLifecycleStageContext,
  overrides: Partial<ModelLifecycleStageReceipt> = {},
): ModelLifecycleStageReceipt {
  return {
    stage,
    routeId: context.route.id,
    target: context.target,
    revisionDigest: context.route.revisionDigest,
    scopeDigest: context.scope.digest,
    transactionDigest: context.transactionDigest,
    fencingDigest: context.resourceLease.fencingDigest,
    digest: nextReceiptDigest(),
    ...overrides,
  }
}

interface DriverOptions {
  readonly capacity?: Partial<Record<ModelComputeTarget, boolean>>
  readonly failStage?: ModelLifecycleStage
  readonly rejectFirstStopWithRestoredSource?: boolean
  readonly unhealthyStage?: 'health' | 'probe'
  readonly observe?: (stage: ModelLifecycleStage, context: ModelLifecycleStageContext) => void
  readonly patchReceipt?: (
    stage: ModelLifecycleStage,
    receipt: ModelLifecycleStageReceipt,
    context: ModelLifecycleStageContext,
  ) => ModelLifecycleStageReceipt
}

const simulatedHosts = new WeakMap<string[], Map<ModelComputeTarget, ModelLifecyclePrestateReceipt['residency']>>()

function driver(log: string[], options: DriverOptions = {}): ModelLifecycleDriver {
  let restoredStopRejected = false
  let hosts = simulatedHosts.get(log)
  if (hosts === undefined) {
    hosts = new Map()
    simulatedHosts.set(log, hosts)
  }
  const residency = hosts
  const complete = (stage: ModelLifecycleStage, context: ModelLifecycleStageContext): ModelLifecycleStageReceipt => {
    log.push(`${stage}:${context.route.id}:${context.target}`)
    options.observe?.(stage, context)
    if (stage === 'stop' && options.rejectFirstStopWithRestoredSource === true && !restoredStopRejected) {
      restoredStopRejected = true
      throw new ModelLifecycleStageRejectedError('stop', 'NO_MUTATION_SOURCE_RESTORED')
    }
    if (stage === 'start') residency.set(context.target, {
      kind: 'RESIDENT', routeId: context.route.id, revisionDigest: context.route.revisionDigest,
    })
    if (stage === 'verify-stopped') residency.delete(context.target)
    if (options.failStage === stage) throw new Error(`${stage} failed after a partial attempt`)
    const receipt = stageReceipt(stage, context)
    return options.patchReceipt?.(stage, receipt, context) ?? receipt
  }

  return {
    capturePrestate: async context => ({
      ...complete('prestate', context),
      residency: residency.get(context.target) ?? { kind: 'EMPTY' },
    }),
    preflight: async (context) => {
      log.push(`preflight:${context.route.id}:${context.target}`)
      options.observe?.('preflight', context)
      if (options.failStage === 'preflight') throw new Error('preflight failed')
      if (options.capacity?.[context.target] === false) return { ok: false, reason: 'capacity held' }
      const receipt = stageReceipt('preflight', context)
      return { ok: true, receipt: options.patchReceipt?.('preflight', receipt, context) ?? receipt }
    },
    drain: async context => complete('drain', context),
    stop: async context => complete('stop', context),
    verifyStopped: async context => complete('verify-stopped', context),
    start: async context => complete('start', context),
    health: async (context) => {
      if (options.unhealthyStage === 'health') {
        log.push(`health:${context.route.id}:${context.target}`)
        options.observe?.('health', context)
        return { ok: false, reason: 'health canary failed' }
      }
      return { ok: true, receipt: complete('health', context) }
    },
    probe: async (context) => {
      if (options.unhealthyStage === 'probe') {
        log.push(`probe:${context.route.id}:${context.target}`)
        options.observe?.('probe', context)
        return { ok: false, reason: 'capability probe failed' }
      }
      return { ok: true, receipt: complete('probe', context) }
    },
  }
}

type Resolver = (
  request: AcquireModelRouteRequest,
  signal: AbortSignal,
) => ModelRouteResolution | Promise<ModelRouteResolution>

function installAuthority(
  ctx: Context,
  resolver: Resolver,
  resources: ResourceLeaseProvider | undefined = fixtureResources(),
) {
  const records: ModelLifecycleAuditRecord[] = []
  const resolve = vi.fn(resolver)
  const record = vi.fn(async (entry: ModelLifecycleAuditRecord) => { records.push(entry) })
  if (resources !== undefined) ctx.modelLifecycle.installResources(resources)
  ctx.modelLifecycle.installAuthority({
    classifyProvider: provider => provider === 'local' ? 'GOVERNED_LOCAL' : 'UNMANAGED_EXTERNAL',
    resolve,
    record,
  })
  return { record, records, resolve, resources }
}

function installRouteAuthority(
  ctx: Context,
  routes: readonly GovernedModelRoute[],
  scopeFor: (request: AcquireModelRouteRequest) => ModelExecutionScope = request => executionScope({
    sessionId: request.sessionId ?? 'session-1',
  }),
) {
  return installAuthority(ctx, (request) => {
    const admitted = routes.find(candidate =>
      candidate.selection.provider === request.selection.provider
      && candidate.selection.model === request.selection.model)
    return admitted === undefined
      ? { kind: 'UNMANAGED_EXTERNAL' }
      : { kind: 'GOVERNED', route: admitted, scope: scopeFor(request) }
  })
}

const contexts: Context[] = []

async function lifecycle(config: ModelLifecycleConfig = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(FixtureModelLifecycleRuntime, config)
  return ctx
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  } finally {
    vi.useRealTimers()
  }
})

describe('governed local-model lifecycle', () => {
  it.each([undefined, 'missing-session'])('rejects absent live session %s before authority or resource acquisition', async (sessionId) => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(ModelLifecycleRuntime)
    const qwen = route('qwen', 'qwen', ['r5300'])
    const log: string[] = []
    const resources = fixtureResources()
    const acquire = vi.spyOn(resources, 'acquire')
    ctx.modelLifecycle.register(qwen, driver(log))
    const authority = installAuthority(ctx, request => ({
      kind: 'GOVERNED',
      route: qwen,
      scope: executionScope({ sessionId: request.sessionId ?? 'missing-session' }),
    }), resources)

    await expect(ctx.modelLifecycle.acquireRoute({
      selection: qwen.selection,
      ...sessionId === undefined ? {} : { sessionId },
    })).rejects.toMatchObject({ code: 'SCOPE_INVALID' })

    expect(authority.resolve).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
    expect(log).toEqual([])
  })

  it('requires shared resource ownership before any local host operation', async () => {
    const ctx = await lifecycle()
    const qwen = route('qwen', 'qwen', ['r5300'])
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log))
    ctx.modelLifecycle.installAuthority({
      classifyProvider: () => 'GOVERNED_LOCAL',
      resolve: () => ({ kind: 'GOVERNED', route: qwen, scope: executionScope() }),
      record: async () => {},
    })
    await expect(ctx.modelLifecycle.acquireRoute({ selection: qwen.selection }))
      .rejects.toMatchObject({ code: 'RESOURCE_LEASE_UNAVAILABLE' })
    expect(log).toEqual([])
  })

  it('installs shared resource mechanics without granting route authority', async () => {
    const ctx = await lifecycle()
    const log: string[] = []
    const admitted = route('qwen', 'qwen', ['r5300'])
    const unregister = ctx.modelLifecycle.register(admitted, driver(log))
    const releaseResources = ctx.modelLifecycle.installResources(fixtureResources())
    ctx.modelLifecycle.installAuthority({
      classifyProvider: provider => provider === 'local' ? 'GOVERNED_LOCAL' : 'UNMANAGED_EXTERNAL',
      resolve: request => ({
        kind: 'GOVERNED',
        route: admitted,
        scope: executionScope({ sessionId: request.sessionId ?? 'session-1' }),
      }),
      record: () => Promise.resolve(),
    })

    const lease = await ctx.modelLifecycle.acquireRoute({
      selection: admitted.selection,
      sessionId: 'session-1',
    })

    expect(lease.managed).toBe(true)
    expect(log).toEqual([
      'preflight:qwen:r5300',
      'prestate:qwen:r5300',
      'start:qwen:r5300',
      'health:qwen:r5300',
      'probe:qwen:r5300',
    ])
    await lease.release()
    await unregister()
    releaseResources()
  })

  it('rejects duplicate resource ownership', async () => {
    const ctx = await lifecycle()
    const resources = fixtureResources()
    const releaseResources = ctx.modelLifecycle.installResources(resources)

    expect(() => ctx.modelLifecycle.installResources(resources)).toThrow('resources are already installed')
    releaseResources()
  })

  it('keeps dedicated resources installed while a registered route can use them', async () => {
    const ctx = await lifecycle()
    const resources = fixtureResources()
    const releaseResources = ctx.modelLifecycle.installResources(resources)
    const unregister = ctx.modelLifecycle.register(
      route('qwen', 'qwen', ['r5300']),
      driver([]),
    )

    expect(() => { releaseResources() }).toThrow('resources remain in use')

    await unregister()
    expect(() => { releaseResources() }).not.toThrow()
  })

  it('waits for provider arbitration across two app contexts and retains ownership until idle unload', async () => {
    vi.useFakeTimers()
    const first = await lifecycle({ minimumDwellMs: 0, idleUnloadMs: 50 })
    const second = await lifecycle({ idleUnloadMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['r5300'])
    const host: string[] = []
    const resources = fixtureResources()
    const baseAcquire = resources.acquire.bind(resources)
    let claimed = false
    let grantNext: (() => void) | undefined
    resources.acquire = async (request, signal) => {
      if (claimed) await new Promise<void>((resolve) => { grantNext = resolve })
      claimed = true
      return await baseAcquire(request, signal)
    }
    const release = vi.spyOn(resources, 'release').mockImplementation(async () => {
      claimed = false
      grantNext?.()
      grantNext = undefined
    })
    for (const [ctx, model] of [[first, qwen], [second, glm]] as const) {
      ctx.modelLifecycle.register(model, driver(host))
      installAuthority(ctx, () => ({ kind: 'GOVERNED', route: model, scope: executionScope() }), resources)
    }
    const firstLease = await first.modelLifecycle.acquireRoute({ selection: qwen.selection })
    await firstLease.release()
    host.length = 0
    const waiting = second.modelLifecycle.acquireRoute({ selection: glm.selection })
    await vi.advanceTimersByTimeAsync(49)
    expect(release).not.toHaveBeenCalled()
    expect(host).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    const secondLease = await waiting
    expect(release).toHaveBeenCalledTimes(1)
    expect(release.mock.calls[0]?.[1]).toBe('SETTLED')
    expect(host.indexOf('verify-stopped:qwen:r5300')).toBeLessThan(host.indexOf('start:glm:r5300'))
    await secondLease.release()
  })

  it('aborts active adapter inference on renewal loss and performs no stale unload', async () => {
    vi.useFakeTimers()
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    await ctx.plugin(LlmRuntime)
    const qwen = route('qwen', 'qwen', ['r5300'])
    const host: string[] = []
    const resources = fixtureResources()
    resources.renew = async () => { throw new Error('private issuer transport failed') }
    const releases = vi.spyOn(resources, 'release')
    ctx.modelLifecycle.register(qwen, driver(host))
    installAuthority(ctx, () => ({ kind: 'GOVERNED', route: qwen, scope: executionScope() }), resources)
    let adapterSignal: AbortSignal | undefined
    class RevocableAdapter extends LlmAdapter {
      async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        adapterSignal = options.signal
        await new Promise<void>((resolve) => { options.signal!.addEventListener('abort', () => { resolve() }, { once: true }) })
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['local'], new RevocableAdapter())
    const options: GenerateOptions = { provider: qwen.selection.provider, model: qwen.selection.model, messages: [] }
    const result = collect(ctx.llm.stream(options)).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(19_999)
    expect(adapterSignal?.aborted).toBe(false)
    host.length = 0
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toMatchObject({ code: 'RESOURCE_LEASE_LOST' })
    expect(adapterSignal?.aborted).toBe(true)
    expect(options.signal).toBeUndefined()
    expect(host).toEqual([])
    expect(releases.mock.calls.at(-1)?.[1]).toBe('UNCERTAIN')
    expect(ctx.modelLifecycle.snapshot().phase).toBe('TAINTED')
  })

  it.each(['qwen', 'glm'])('does not let a restarted app adopt another client residency when selecting %s', async (model) => {
    const first = await lifecycle({ idleUnloadMs: 0 })
    const second = await lifecycle({ idleUnloadMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['r5300'])
    const log: string[] = []
    first.modelLifecycle.register(qwen, driver(log))
    const requested = model === 'qwen' ? qwen : glm
    second.modelLifecycle.register(requested, driver(log))
    installRouteAuthority(first, [qwen])
    const authority = installRouteAuthority(second, [requested])
    const lease = await first.modelLifecycle.acquireRoute({ selection: qwen.selection })
    await lease.release()
    log.length = 0

    await expect(second.modelLifecycle.acquireRoute({ selection: requested.selection }))
      .rejects.toMatchObject({ code: 'RESIDENCY_UNVERIFIED' })

    expect(log).toEqual([`preflight:${model}:r5300`, `prestate:${model}:r5300`])
    expect(second.modelLifecycle.snapshot()).toEqual({ phase: 'TAINTED' })
    expect(authority.records.at(-1)).toMatchObject({ outcome: 'TAINTED', errorCode: 'RESIDENCY_UNVERIFIED' })
    expect(first.modelLifecycle.snapshot()).toMatchObject({ phase: 'READY', active: { routeId: 'qwen' } })
  })

  it('adopts an explicitly admitted exact resident route only after health and capability probes', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'], { allowExactResidentAdoption: true })
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log))
    simulatedHosts.get(log)!.set('r5300', {
      kind: 'RESIDENT', routeId: qwen.id, revisionDigest: qwen.revisionDigest,
    })
    const authority = installRouteAuthority(ctx, [qwen])

    const lease = await ctx.modelLifecycle.acquireRoute({ selection: qwen.selection })

    expect(log).toEqual([
      'preflight:qwen:r5300',
      'prestate:qwen:r5300',
      'health:qwen:r5300',
      'probe:qwen:r5300',
    ])
    expect(ctx.modelLifecycle.snapshot()).toMatchObject({ phase: 'IN_USE', active: { routeId: 'qwen', target: 'r5300' } })
    expect(authority.records.at(-1)).toMatchObject({ outcome: 'READY', routeId: 'qwen', target: 'r5300' })
    await lease.release()
  })

  it('rejects an opt-in resident route when its revision is not exact without mutating the host', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'], { allowExactResidentAdoption: true })
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log))
    simulatedHosts.get(log)!.set('r5300', {
      kind: 'RESIDENT', routeId: qwen.id, revisionDigest: OTHER_DIGEST,
    })
    const authority = installRouteAuthority(ctx, [qwen])

    await expect(ctx.modelLifecycle.acquireRoute({ selection: qwen.selection }))
      .rejects.toMatchObject({ code: 'RESIDENCY_UNVERIFIED' })

    expect(log).toEqual(['preflight:qwen:r5300', 'prestate:qwen:r5300'])
    expect(ctx.modelLifecycle.snapshot()).toEqual({ phase: 'TAINTED' })
    expect(authority.records.at(-1)).toMatchObject({ outcome: 'TAINTED', errorCode: 'RESIDENCY_UNVERIFIED' })
  })

  it('does not start or stop an exact resident route when adoption health fails', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'], { allowExactResidentAdoption: true })
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log, { unhealthyStage: 'health' }))
    simulatedHosts.get(log)!.set('r5300', {
      kind: 'RESIDENT', routeId: qwen.id, revisionDigest: qwen.revisionDigest,
    })
    const authority = installRouteAuthority(ctx, [qwen])

    await expect(ctx.modelLifecycle.acquireRoute({ selection: qwen.selection }))
      .rejects.toMatchObject({ code: 'HEALTH_FAILED' })

    expect(log).toEqual(['preflight:qwen:r5300', 'prestate:qwen:r5300', 'health:qwen:r5300'])
    expect(ctx.modelLifecycle.snapshot()).toEqual({ phase: 'IDLE' })
    expect(authority.records.at(-1)).toMatchObject({ outcome: 'REJECTED', errorCode: 'HEALTH_FAILED' })
  })

  it('does not start or stop an exact resident route when adoption capability probe fails', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'], { allowExactResidentAdoption: true })
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log, { unhealthyStage: 'probe' }))
    simulatedHosts.get(log)!.set('r5300', {
      kind: 'RESIDENT', routeId: qwen.id, revisionDigest: qwen.revisionDigest,
    })
    const authority = installRouteAuthority(ctx, [qwen])

    await expect(ctx.modelLifecycle.acquireRoute({ selection: qwen.selection }))
      .rejects.toMatchObject({ code: 'HEALTH_FAILED' })

    expect(log).toEqual([
      'preflight:qwen:r5300', 'prestate:qwen:r5300', 'health:qwen:r5300', 'probe:qwen:r5300',
    ])
    expect(ctx.modelLifecycle.snapshot()).toEqual({ phase: 'IDLE' })
    expect(authority.records.at(-1)).toMatchObject({ outcome: 'REJECTED', errorCode: 'HEALTH_FAILED' })
  })

  it('finishes the non-mutating adoption probe before surfacing cancellation', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'], { allowExactResidentAdoption: true })
    const controller = new AbortController()
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log, {
      observe(stage) {
        if (stage === 'health') controller.abort()
      },
    }))
    simulatedHosts.get(log)!.set('r5300', {
      kind: 'RESIDENT', routeId: qwen.id, revisionDigest: qwen.revisionDigest,
    })
    installRouteAuthority(ctx, [qwen])

    await expect(ctx.modelLifecycle.acquireRoute({ selection: qwen.selection, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'ABORTED' })

    expect(log).toEqual([
      'preflight:qwen:r5300', 'prestate:qwen:r5300', 'health:qwen:r5300', 'probe:qwen:r5300',
    ])
    expect(ctx.modelLifecycle.snapshot()).toEqual({ phase: 'IDLE' })
    expect(simulatedHosts.get(log)!.get('r5300')).toEqual({
      kind: 'RESIDENT', routeId: qwen.id, revisionDigest: qwen.revisionDigest,
    })
  })

  it('completes health and probe when reusing an adopted route before another acquisition', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'], { allowExactResidentAdoption: true })
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log))
    simulatedHosts.get(log)!.set('r5300', {
      kind: 'RESIDENT', routeId: qwen.id, revisionDigest: qwen.revisionDigest,
    })
    installRouteAuthority(ctx, [qwen])
    const adopted = await ctx.modelLifecycle.acquireRoute({ selection: qwen.selection })
    await adopted.release()
    log.length = 0

    const reused = await ctx.modelLifecycle.acquireRoute({ selection: qwen.selection })
    await reused.release()
    const reusedAgain = await ctx.modelLifecycle.acquireRoute({ selection: qwen.selection })
    await reusedAgain.release()

    expect(log).toEqual([
      'preflight:qwen:r5300', 'prestate:qwen:r5300', 'health:qwen:r5300', 'probe:qwen:r5300',
      'preflight:qwen:r5300', 'prestate:qwen:r5300', 'health:qwen:r5300', 'probe:qwen:r5300',
    ])
    expect(ctx.modelLifecycle.snapshot()).toMatchObject({ phase: 'READY', active: { routeId: 'qwen' } })
  })

  it('retains control of an adopted route until its admitted idle unload completes', async () => {
    vi.useFakeTimers()
    const ctx = await lifecycle({ idleUnloadMs: 20, minimumDwellMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'], { allowExactResidentAdoption: true })
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log))
    simulatedHosts.get(log)!.set('r5300', {
      kind: 'RESIDENT', routeId: qwen.id, revisionDigest: qwen.revisionDigest,
    })
    installRouteAuthority(ctx, [qwen])
    const lease = await ctx.modelLifecycle.acquireRoute({ selection: qwen.selection })
    await lease.release()
    log.length = 0

    await vi.advanceTimersByTimeAsync(20)
    await flushMicrotasks()

    expect(log).toEqual([
      'prestate:qwen:r5300',
      'stop:qwen:r5300',
      'verify-stopped:qwen:r5300',
    ])
    expect(ctx.modelLifecycle.snapshot()).toEqual({ phase: 'IDLE' })
  })

  it('drains an adopted route before an admitted user-requested switch', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'], { allowExactResidentAdoption: true })
    const glm = route('glm', 'glm', ['r5300'])
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log))
    ctx.modelLifecycle.register(glm, driver(log))
    simulatedHosts.get(log)!.set('r5300', {
      kind: 'RESIDENT', routeId: qwen.id, revisionDigest: qwen.revisionDigest,
    })
    installRouteAuthority(ctx, [qwen, glm])
    const first = await ctx.modelLifecycle.acquireRoute({ selection: qwen.selection })
    await first.release()
    log.length = 0

    const second = await ctx.modelLifecycle.acquireRoute({ selection: glm.selection })

    expect(log).toEqual([
      'preflight:glm:r5300',
      'prestate:glm:r5300',
      'drain:qwen:r5300',
      'stop:qwen:r5300',
      'verify-stopped:qwen:r5300',
      'start:glm:r5300',
      'health:glm:r5300',
      'probe:glm:r5300',
    ])
    expect(ctx.modelLifecycle.snapshot()).toMatchObject({ phase: 'IN_USE', active: { routeId: 'glm' } })
    await second.release()
  })

  it('reconciles an exact admitted preserved resident before a restarted user-approved switch', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'], { allowExactResidentAdoption: true })
    const glm = route('glm', 'glm', ['r5300'], { allowExactResidentAdoption: true })
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log))
    ctx.modelLifecycle.register(glm, driver(log))
    simulatedHosts.get(log)!.set('r5300', {
      kind: 'RESIDENT', routeId: qwen.id, revisionDigest: qwen.revisionDigest,
    })
    const ask = vi.fn(async (request: ModelEvictionConsentRequest) => ({
      id: 'f'.repeat(64),
      fencing_digest: request.resourceLease.fencingDigest,
      signature: 'e'.repeat(64),
      scope_digest: request.scope.digest,
      transaction_digest: request.transactionDigest,
      source_route_id: request.sourceRoute.id,
      source_revision_digest: request.sourceRoute.revisionDigest,
      source_target: request.sourceTarget,
      destination_route_id: request.destinationRoute.id,
      destination_revision_digest: request.destinationRoute.revisionDigest,
      destination_target: request.destinationTarget,
      source_prestate_digest: request.sourcePrestate.digest,
      destination_prestate_digest: request.destinationPrestate.digest,
      expires_at: Date.now() + 30_000,
    }))
    ctx.modelLifecycle.installResources(fixtureResources())
    ctx.modelLifecycle.installAuthority({
      classifyProvider: provider => provider === 'local' ? 'GOVERNED_LOCAL' : 'UNMANAGED_EXTERNAL',
      resolve: request => ({
        kind: 'GOVERNED',
        route: request.selection.model === qwen.selection.model ? qwen : glm,
        scope: executionScope({ sessionId: request.sessionId ?? 'session-1' }),
      }),
      record: async () => {},
      requestEvictionConsent: ask,
    })

    const lease = await ctx.modelLifecycle.acquireRoute({ selection: glm.selection })

    expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      sourceRoute: qwen,
      sourceTarget: 'r5300',
      destinationRoute: glm,
      destinationTarget: 'r5300',
    }), expect.any(AbortSignal))
    expect(log).toEqual([
      'preflight:glm:r5300',
      'prestate:glm:r5300',
      'prestate:qwen:r5300',
      'drain:qwen:r5300',
      'stop:qwen:r5300',
      'verify-stopped:qwen:r5300',
      'start:glm:r5300',
      'health:glm:r5300',
      'probe:glm:r5300',
    ])
    expect(ctx.modelLifecycle.snapshot()).toMatchObject({ phase: 'IN_USE', active: { routeId: 'glm' } })
    await lease.release()
  })

  it.each([false, true])('requires a transaction-bound GCP consent before draining a resident (approved=%s)', async (approved) => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['r5300'])
    const log: string[] = []
    let stopConsent: ModelLifecycleStageContext['evictionConsent']
    const observe: DriverOptions['observe'] = (stage, context) => {
      if (stage === 'stop') stopConsent = context.evictionConsent
    }
    ctx.modelLifecycle.register(qwen, driver(log, { observe }))
    ctx.modelLifecycle.register(glm, driver(log, { observe }))
    ctx.modelLifecycle.installResources(fixtureResources())
    const ask = vi.fn(async (request: ModelEvictionConsentRequest) => approved ? {
      id: 'f'.repeat(64),
      fencing_digest: request.resourceLease.fencingDigest,
      signature: 'e'.repeat(64),
      scope_digest: request.scope.digest,
      transaction_digest: request.transactionDigest,
      source_route_id: request.sourceRoute.id,
      source_revision_digest: request.sourceRoute.revisionDigest,
      source_target: request.sourceTarget,
      destination_route_id: request.destinationRoute.id,
      destination_revision_digest: request.destinationRoute.revisionDigest,
      destination_target: request.destinationTarget,
      source_prestate_digest: request.sourcePrestate.digest,
      destination_prestate_digest: request.destinationPrestate.digest,
      expires_at: Date.now() + 30_000,
    } : null)
    ctx.modelLifecycle.installAuthority({
      classifyProvider: provider => provider === 'local' ? 'GOVERNED_LOCAL' : 'UNMANAGED_EXTERNAL',
      resolve: (request) => {
        const selected = [qwen, glm].find(candidate => candidate.selection.model === request.selection.model)!
        return { kind: 'GOVERNED', route: selected, scope: executionScope({ sessionId: request.sessionId ?? 'session-1' }) }
      },
      record: async () => {},
      requestEvictionConsent: ask,
    })
    const first = await ctx.modelLifecycle.acquireRoute({ selection: qwen.selection })
    await first.release()
    log.length = 0

    if (approved) {
      const second = await ctx.modelLifecycle.acquireRoute({ selection: glm.selection })
      expect(stopConsent).toMatchObject({ id: 'f'.repeat(64), source_route_id: 'qwen', destination_route_id: 'glm' })
      await second.release()
    } else {
      await expect(ctx.modelLifecycle.acquireRoute({ selection: glm.selection }))
        .rejects.toMatchObject({ code: 'EVICTION_NOT_APPROVED' })
      expect(log.some(entry => /^(drain|stop):/u.test(entry))).toBe(false)
      expect(ctx.modelLifecycle.snapshot()).toMatchObject({ active: { routeId: 'qwen' } })
    }
    expect(ask).toHaveBeenCalledTimes(1)
    expect(log).toContain('prestate:qwen:r5300')
  })

  it.each(['EMPTY', 'UNKNOWN', 'RESIDENT'] as const)('refuses changed %s residency before idle unload or disposal', async (kind) => {
    vi.useFakeTimers()
    const ctx = await lifecycle({ idleUnloadMs: 20, minimumDwellMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    const log: string[] = []
    const unregister = ctx.modelLifecycle.register(qwen, driver(log))
    installRouteAuthority(ctx, [qwen])
    const lease = await ctx.modelLifecycle.acquireRoute({ selection: qwen.selection })
    await lease.release()
    simulatedHosts.get(log)!.set('r5300', kind === 'RESIDENT'
      ? { kind, routeId: qwen.id, revisionDigest: OTHER_DIGEST }
      : { kind })
    log.length = 0

    await vi.advanceTimersByTimeAsync(20)
    await unregister()

    expect(log).toEqual(['prestate:qwen:r5300'])
    expect(ctx.modelLifecycle.snapshot().phase).toBe('TAINTED')
  })

  it('checks previous-host residency too before a cross-target drain', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['prdg'])
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log))
    ctx.modelLifecycle.register(glm, driver(log))
    installRouteAuthority(ctx, [qwen, glm])
    const lease = await ctx.modelLifecycle.acquireRoute({ selection: qwen.selection })
    await lease.release()
    simulatedHosts.get(log)!.set('r5300', { kind: 'UNKNOWN' })
    log.length = 0

    await expect(ctx.modelLifecycle.acquireRoute({ selection: glm.selection }))
      .rejects.toMatchObject({ code: 'RESIDENCY_UNVERIFIED' })

    expect(log).toEqual(['preflight:glm:prdg', 'prestate:glm:prdg', 'prestate:qwen:r5300'])
  })

  it.each(['throw', 'receipt'] as const)('sanitizes cross-target prestate %s failures without mutation', async (failure) => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['prdg'])
    const log: string[] = []
    let broken = false
    const base = driver(log)
    ctx.modelLifecycle.register(qwen, {
      ...base,
      capturePrestate: async (context) => {
        const value = await base.capturePrestate(context)
        if (!broken) return value
        if (failure === 'throw') throw new Error('private://host-operation-detail')
        return { ...value, revisionDigest: OTHER_DIGEST }
      },
    })
    ctx.modelLifecycle.register(glm, driver(log))
    installRouteAuthority(ctx, [qwen, glm])
    const first = await ctx.modelLifecycle.acquireRoute({ selection: qwen.selection })
    await first.release()
    broken = true
    log.length = 0
    const error: unknown = await ctx.modelLifecycle.acquireRoute({ selection: glm.selection }).catch((error: unknown) => error)
    broken = false

    expect(error).toMatchObject({ code: 'PREFLIGHT_FAILED' })
    expect(String(error)).not.toContain('private://')
    expect(log).toEqual(['preflight:glm:prdg', 'prestate:glm:prdg', 'prestate:qwen:r5300'])
  })

  it.each(['reuse', 'unregister'] as const)('audits changed residency during direct %s without stopping', async (action) => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    const log: string[] = []
    const unregister = ctx.modelLifecycle.register(qwen, driver(log))
    const authority = installRouteAuthority(ctx, [qwen])
    const lease = await ctx.modelLifecycle.acquireRoute({ selection: qwen.selection })
    await lease.release()
    simulatedHosts.get(log)!.set('r5300', { kind: 'UNKNOWN' })
    log.length = 0

    await expect(action === 'reuse' ? ctx.modelLifecycle.acquireRoute({ selection: qwen.selection }) : unregister())
      .rejects.toMatchObject({ code: 'RESIDENCY_UNVERIFIED' })

    expect(log).toEqual(action === 'reuse' ? ['preflight:qwen:r5300', 'prestate:qwen:r5300'] : ['prestate:qwen:r5300'])
    expect(authority.records.at(-1)).toMatchObject({ outcome: 'TAINTED', errorCode: 'RESIDENCY_UNVERIFIED' })
    expect(ctx.modelLifecycle.snapshot().phase).toBe('TAINTED')
  })

  it('never stops a model after a failed shutdown prestate read', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    const log: string[] = []
    let unavailable = false
    const base = driver(log)
    const unregister = ctx.modelLifecycle.register(qwen, {
      ...base,
      capturePrestate: async (context) => {
        if (unavailable) throw new Error('private host query failed')
        return await base.capturePrestate(context)
      },
    })
    installRouteAuthority(ctx, [qwen])
    const lease = await ctx.modelLifecycle.acquireRoute({ selection: qwen.selection })
    await lease.release()
    log.length = 0
    unavailable = true

    await expect(unregister()).rejects.toMatchObject({ code: 'PREFLIGHT_FAILED' })
    expect(log).toEqual([])
    expect(ctx.modelLifecycle.snapshot().phase).toBe('TAINTED')
  })

  it('uses the admitted long start deadline without lengthening health or authority deadlines', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'))
    const ctx = await lifecycle({ stageTimeoutMs: 50, idleUnloadMs: 0 })
    const longStartMs = 1_300_000
    const admitted = route('glm', 'glm', ['r5300'], { stageTimeoutsMs: { start: longStartMs } })
    const log: string[] = []
    const base = driver(log)
    let startContext: ModelLifecycleStageContext | undefined
    let finishStart!: () => void
    let healthContext: ModelLifecycleStageContext | undefined
    ctx.modelLifecycle.register(admitted, {
      ...base,
      start: async (context) => {
        startContext = context
        await new Promise<void>((resolve) => { finishStart = resolve })
        return await base.start(context)
      },
      health: async (context) => {
        healthContext = context
        return await base.health(context)
      },
    })
    installRouteAuthority(ctx, [admitted])
    const pending = ctx.modelLifecycle.acquireRoute({ selection: admitted.selection })
    await vi.advanceTimersByTimeAsync(1_169_510)
    expect(startContext?.deadlineAt).toBe(new Date('2026-09-04T00:00:00.000Z').getTime() + longStartMs)
    expect(startContext?.signal?.aborted).toBe(false)
    finishStart()
    const lease = await pending
    expect(healthContext?.deadlineAt).toBe(Date.now() + 50)
    await lease.release()
  })

  it('binds immutable stage budgets to route admission regardless of property ordering', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const timeouts = { start: 150_000, health: 3_000 }
    const admitted = route('glm', 'glm', ['r5300'], { stageTimeoutsMs: timeouts })
    const log: string[] = []
    ctx.modelLifecycle.register(admitted, driver(log))
    const authority = installAuthority(ctx, () => ({
      kind: 'GOVERNED', scope: executionScope(),
      route: { ...admitted, stageTimeoutsMs: { health: 3_000, start: 150_000 } },
    }))
    timeouts.start = 1
    const lease = await ctx.modelLifecycle.acquireRoute({ selection: admitted.selection })
    await lease.release()
    log.length = 0
    authority.resolve.mockImplementation(() => ({ kind: 'GOVERNED', route: admitted, scope: executionScope() }))

    await expect(ctx.modelLifecycle.acquireRoute({ selection: admitted.selection }))
      .rejects.toMatchObject({ code: 'ROUTE_HELD' })
    expect(log).toEqual([])
  })

  it('treats omitted and explicit-false resident adoption settings as the same route', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const admitted = route('glm', 'glm', ['r5300'])
    const log: string[] = []
    ctx.modelLifecycle.register(admitted, driver(log))
    installAuthority(ctx, () => ({
      kind: 'GOVERNED',
      scope: executionScope(),
      route: { ...admitted, allowExactResidentAdoption: false },
    }))

    const lease = await ctx.modelLifecycle.acquireRoute({ selection: admitted.selection })
    expect(lease).toMatchObject({ managed: true, routeId: 'glm', target: 'r5300' })
    await lease.release()
  })

  it.each(['start', 'health'] as const)('enforces the %s deadline independently of the long-start override', async (stage) => {
    vi.useFakeTimers()
    const ctx = await lifecycle({ stageTimeoutMs: 50, idleUnloadMs: 0 })
    const admitted = route('glm', 'glm', ['r5300'], { stageTimeoutsMs: { start: 80 } })
    let bounded: ModelLifecycleStageContext | undefined
    ctx.modelLifecycle.register(admitted, {
      ...driver([]),
      [stage]: async (context: ModelLifecycleStageContext) => {
        bounded = context
        return await new Promise<never>(() => {})
      },
    })
    installRouteAuthority(ctx, [admitted])
    const pending = ctx.modelLifecycle.acquireRoute({ selection: admitted.selection }).catch((error: unknown) => error)
    const timeout = stage === 'start' ? 80 : 50
    await vi.advanceTimersByTimeAsync(timeout - 1)
    expect(bounded?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(bounded?.signal?.aborted).toBe(true)
    expect(await pending).toMatchObject({ code: 'STAGE_TIMEOUT' })
    expect(ctx.modelLifecycle.snapshot().phase).toBe('TAINTED')
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, 1.5])('rejects unsafe stage budget %s', async (timeout) => {
    const ctx = await lifecycle()
    expect(() => ctx.modelLifecycle.register(route('glm', 'glm', ['r5300'], {
      stageTimeoutsMs: { start: timeout },
    }), driver([]))).toThrow('timer-safe')
  })

  it('passes classified external routes through and rejects a governed provider resolved as external', async () => {
    const ctx = await lifecycle()
    const admitted = route('qwen', 'qwen')
    const log: string[] = []
    ctx.modelLifecycle.register(admitted, driver(log))
    const authority = installAuthority(ctx, () => ({ kind: 'UNMANAGED_EXTERNAL' }))
    const externalRequest: AcquireModelRouteRequest = {
      sessionId: 'external-session',
      selection: { provider: 'cloud', model: 'external' },
    }

    const lease = await ctx.modelLifecycle.acquireRoute(externalRequest)

    expect(authority.resolve).not.toHaveBeenCalled()
    expect(lease).toMatchObject({ managed: false })
    expect(lease).not.toHaveProperty('routeId')
    await lease.release()

    const governedRequest: AcquireModelRouteRequest = {
      sessionId: 'governed-session',
      selection: { provider: 'local', model: 'qwen' },
    }
    await expect(ctx.modelLifecycle.acquireRoute(governedRequest)).rejects.toMatchObject({ code: 'ROUTE_HELD' })
    expect(authority.resolve).toHaveBeenCalledOnce()
    expect(authority.resolve).toHaveBeenCalledWith(governedRequest, expect.any(AbortSignal))
    expect(log).toEqual([])
    expect(authority.records).toEqual([])
    expect(ctx.modelLifecycle.snapshot()).toEqual({ phase: 'IDLE' })
  })

  it('fails closed for unavailable governance, held routes, missing drivers, and disabled registrations', async () => {
    const unavailable = await lifecycle()
    const unavailableLog: string[] = []
    unavailable.modelLifecycle.register(route('qwen', 'qwen'), driver(unavailableLog))
    await expect(unavailable.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })).rejects.toMatchObject({ code: 'GOVERNANCE_UNAVAILABLE' })
    expect(unavailableLog).toEqual([])

    const held = await lifecycle()
    const heldAuthority = installAuthority(held, () => ({
      kind: 'HELD', routeId: 'qwen', reason: 'operator hold',
    }))
    await expect(held.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })).rejects.toMatchObject({ code: 'ROUTE_HELD' })
    expect(heldAuthority.records).toEqual([])

    const missing = await lifecycle()
    const missingRoute = route('missing', 'missing')
    const missingAuthority = installRouteAuthority(missing, [missingRoute])
    await expect(missing.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'missing' },
    })).rejects.toMatchObject({ code: 'ROUTE_HELD' })
    expect(missingAuthority.records).toEqual([])

    const disabled = await lifecycle()
    const disabledRoute = route('disabled', 'disabled', ['r5300'], { disposition: 'VISIBLE_DISABLED' })
    const disabledLog: string[] = []
    disabled.modelLifecycle.register(disabledRoute, driver(disabledLog))
    installRouteAuthority(disabled, [disabledRoute])
    await expect(disabled.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'disabled' },
    })).rejects.toMatchObject({ code: 'ROUTE_HELD' })
    expect(disabledLog).toEqual([])
  })

  it('validates every scope component and preserves the exact authority scope through all stages', async () => {
    const ctx = await lifecycle()
    const admitted = route('qwen', 'qwen', ['r5300'])
    const exactScope = executionScope({
      workId: 'work-exact',
      principalId: 'principal-exact',
      tenantId: 'tenant-exact',
      sessionId: 'session-exact',
    })
    const seen: Array<{ stage: ModelLifecycleStage; context: ModelLifecycleStageContext }> = []
    const log: string[] = []
    ctx.modelLifecycle.register(admitted, driver(log, {
      observe: (stage, context) => { seen.push({ stage, context }) },
    }))
    const authority = installAuthority(ctx, () => ({ kind: 'GOVERNED', route: admitted, scope: exactScope }))
    const request: AcquireModelRouteRequest = {
      sessionId: 'session-exact', selection: { provider: 'local', model: 'qwen' },
    }

    const lease = await ctx.modelLifecycle.acquireRoute(request)

    expect(authority.resolve).toHaveBeenCalledWith(request, expect.any(AbortSignal))
    expect(seen.map(entry => entry.stage)).toEqual(['preflight', 'prestate', 'start', 'health', 'probe'])
    expect(seen.every(entry => entry.context.scope !== exactScope)).toBe(true)
    expect(seen.every(entry => Object.isFrozen(entry.context.scope))).toBe(true)
    expect(seen.every(entry => JSON.stringify(entry.context.scope) === JSON.stringify(exactScope))).toBe(true)
    expect(seen.every(entry => entry.context.scope.sessionId === request.sessionId)).toBe(true)
    expect(seen.every(entry => entry.context.transactionKind === 'MODEL_ROUTE')).toBe(true)
    expect(new Set(seen.map(entry => entry.context.transactionDigest)).size).toBe(1)
    await lease.release()
    expect(authority.records[0]?.scopeDigest).toBe(exactScope.digest)

    for (const field of ['workId', 'principalId', 'tenantId', 'sessionId'] as const) {
      const invalid = await lifecycle()
      const invalidLog: string[] = []
      invalid.modelLifecycle.register(admitted, driver(invalidLog))
      const invalidAuthority = installAuthority(invalid, () => ({
        kind: 'GOVERNED',
        route: admitted,
        scope: executionScope({ [field]: '   ' }),
      }))
      await expect(invalid.modelLifecycle.acquireRoute({
        selection: { provider: 'local', model: 'qwen' },
      })).rejects.toMatchObject({ code: 'SCOPE_INVALID' })
      expect(invalidLog).toEqual([])
      expect(invalidAuthority.records).toEqual([])
    }

    for (const field of ['workId', 'principalId', 'tenantId', 'sessionId', 'digest'] as const) {
      const missing = await lifecycle()
      const missingLog: string[] = []
      missing.modelLifecycle.register(admitted, driver(missingLog))
      const { [field]: _omitted, ...incomplete } = executionScope()
      installAuthority(missing, () => ({
        kind: 'GOVERNED',
        route: admitted,
        scope: incomplete as unknown as ModelExecutionScope,
      }))
      await expect(missing.modelLifecycle.acquireRoute({
        selection: { provider: 'local', model: 'qwen' },
      })).rejects.toMatchObject({ code: 'SCOPE_INVALID' })
      expect(missingLog).toEqual([])
    }

    const mismatch = await lifecycle()
    const mismatchLog: string[] = []
    mismatch.modelLifecycle.register(admitted, driver(mismatchLog))
    installAuthority(mismatch, () => ({
      kind: 'GOVERNED', route: admitted, scope: executionScope({ sessionId: 'other-session' }),
    }))
    await expect(mismatch.modelLifecycle.acquireRoute({
      sessionId: 'requested-session',
      selection: { provider: 'local', model: 'qwen' },
    })).rejects.toMatchObject({ code: 'SCOPE_INVALID' })
    expect(mismatchLog).toEqual([])

    const malformed = await lifecycle()
    const malformedLog: string[] = []
    malformed.modelLifecycle.register(admitted, driver(malformedLog))
    installAuthority(malformed, () => ({
      kind: 'GOVERNED', route: admitted, scope: executionScope({ digest: 'SHA256:NOT-SANITIZED' }),
    }))
    await expect(malformed.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })).rejects.toMatchObject({ code: 'SCOPE_INVALID' })
    expect(malformedLog).toEqual([])
  })

  it('rejects every authority route identity mismatch before invoking a driver', async () => {
    const cases: Array<[string, (admitted: GovernedModelRoute) => GovernedModelRoute]> = [
      ['route id', admitted => ({ ...admitted, id: 'other-route' })],
      ['provider', admitted => ({ ...admitted, selection: { ...admitted.selection, provider: 'other' } })],
      ['model', admitted => ({ ...admitted, selection: { ...admitted.selection, model: 'other' } })],
      ['admission receipt', admitted => ({ ...admitted, admissionReceiptDigest: OTHER_DIGEST })],
      ['revision', admitted => ({ ...admitted, revisionDigest: OTHER_DIGEST })],
      ['disposition', admitted => ({ ...admitted, disposition: 'HIDDEN_HELD' })],
      ['targets', admitted => ({ ...admitted, targets: ['r5300'] })],
      ['offload', admitted => ({ ...admitted, allowRamCpuOffload: true })],
      ['reasoning', admitted => ({ ...admitted, supportedReasoningEfforts: ['high'] })],
    ]

    for (const [label, mismatch] of cases) {
      const ctx = await lifecycle()
      const admitted = route('qwen', 'qwen')
      const log: string[] = []
      ctx.modelLifecycle.register(admitted, driver(log))
      const authority = installAuthority(ctx, () => ({
        kind: 'GOVERNED', route: mismatch(admitted), scope: executionScope(),
      }))

      await expect(ctx.modelLifecycle.acquireRoute({
        selection: { provider: 'local', model: 'qwen' },
      }), label).rejects.toMatchObject({ code: 'ROUTE_HELD' })
      expect(log, label).toEqual([])
      expect(authority.records, label).toEqual([])
    }

    const wrongRequest = await lifecycle()
    const qwen = route('qwen', 'qwen')
    const requestLog: string[] = []
    wrongRequest.modelLifecycle.register(qwen, driver(requestLog))
    installAuthority(wrongRequest, () => ({
      kind: 'GOVERNED', route: qwen, scope: executionScope(),
    }))
    await expect(wrongRequest.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'glm' },
    })).rejects.toMatchObject({ code: 'ROUTE_HELD' })
    expect(requestLog).toEqual([])
  })

  it('requires preflight receipts to bind every field of the active transaction', async () => {
    const cases: Array<[
      string,
      (receipt: ModelLifecycleStageReceipt) => ModelLifecycleStageReceipt,
    ]> = [
      ['stage', receipt => ({ ...receipt, stage: 'health' })],
      ['route', receipt => ({ ...receipt, routeId: 'other-route' })],
      ['target', receipt => ({ ...receipt, target: 'prdg' })],
      ['revision', receipt => ({ ...receipt, revisionDigest: OTHER_DIGEST })],
      ['scope', receipt => ({ ...receipt, scopeDigest: OTHER_DIGEST })],
      ['transaction', receipt => ({ ...receipt, transactionDigest: TRANSACTION_DIGEST })],
      ['digest format', receipt => ({ ...receipt, digest: 'SHA256:NOT-SANITIZED' })],
    ]

    for (const [label, patch] of cases) {
      const ctx = await lifecycle()
      const admitted = route('qwen', 'qwen')
      const log: string[] = []
      ctx.modelLifecycle.register(admitted, driver(log, {
        patchReceipt: (stage, receipt) => stage === 'preflight' ? patch(receipt) : receipt,
      }))
      const authority = installRouteAuthority(ctx, [admitted])

      await expect(ctx.modelLifecycle.acquireRoute({
        selection: { provider: 'local', model: 'qwen' },
      }), label).rejects.toMatchObject({ code: 'PREFLIGHT_FAILED' })
      expect(log, label).toEqual(['preflight:qwen:r5300'])
      expect(authority.records, label).toHaveLength(1)
      expect(authority.records[0]).toMatchObject({ outcome: 'REJECTED', errorCode: 'PREFLIGHT_FAILED' })
    }
  })

  it('maps prestate failures to a sanitized typed rejection', async () => {
    const ctx = await lifecycle()
    const admitted = route('qwen', 'qwen')
    const log: string[] = []
    const baseDriver = driver(log)
    ctx.modelLifecycle.register(admitted, {
      ...baseDriver,
      capturePrestate: async (context) => {
        log.push(`prestate:${context.route.id}:${context.target}`)
        throw new Error('private-host-token=must-not-escape')
      },
    })
    const authority = installRouteAuthority(ctx, [admitted])

    const result = await ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    }).then(lease => lease, (error: unknown) => error)

    expect(result).toMatchObject({ code: 'PREFLIGHT_FAILED' })
    expect(String(result)).not.toContain('private-host-token')
    expect(log).toEqual(['preflight:qwen:r5300', 'prestate:qwen:r5300'])
    expect(authority.records.at(-1)).toMatchObject({
      routeId: 'qwen', outcome: 'REJECTED', errorCode: 'PREFLIGHT_FAILED',
    })
  })

  it('uses R5300, PRDG, then admitted RAM/CPU automatically and never falls back manually', async () => {
    const automatic = await lifecycle()
    const automaticRoute = route('glm', 'glm', ['r5300', 'prdg', 'ram-cpu'])
    const automaticLog: string[] = []
    automatic.modelLifecycle.register(automaticRoute, driver(automaticLog, {
      capacity: { r5300: false, prdg: false },
    }))
    installRouteAuthority(automatic, [automaticRoute])

    const lease = await automatic.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'glm' }, preference: 'automatic',
    })
    expect(lease.target).toBe('ram-cpu')
    expect(automaticLog.slice(0, 3)).toEqual([
      'preflight:glm:r5300',
      'preflight:glm:prdg',
      'preflight:glm:ram-cpu',
    ])
    await lease.release()

    const manual = await lifecycle({ preference: 'prdg' })
    const manualRoute = route('glm', 'glm', ['r5300', 'prdg', 'ram-cpu'])
    const manualLog: string[] = []
    manual.modelLifecycle.register(manualRoute, driver(manualLog, { capacity: { r5300: false } }))
    installRouteAuthority(manual, [manualRoute])
    expect(manual.modelLifecycle.currentPreference()).toBe('prdg')

    await expect(manual.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'glm' }, preference: 'r5300',
    })).rejects.toMatchObject({ code: 'MANUAL_TARGET_UNAVAILABLE' })
    expect(manualLog).toEqual(['preflight:glm:r5300'])
  })

  it('settles shared resources after a clean no-capacity result before activation', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const admitted = route('qwen', 'qwen', ['r5300'])
    const resources = fixtureResources()
    const release = vi.spyOn(resources, 'release')
    ctx.modelLifecycle.register(admitted, driver([], { capacity: { r5300: false } }))
    installAuthority(ctx, () => ({
      kind: 'GOVERNED',
      route: admitted,
      scope: executionScope(),
    }), resources)

    await expect(ctx.modelLifecycle.acquireRoute({ selection: admitted.selection }))
      .rejects.toMatchObject({ code: 'NO_CAPACITY' })

    expect(release).toHaveBeenCalledTimes(1)
    expect(release.mock.calls[0]?.[1]).toBe('SETTLED')
    expect(ctx.modelLifecycle.snapshot()).toEqual({ phase: 'IDLE' })
  })

  it('leases automatic targets one at a time and falls through only unavailable capacity', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const admitted = route('qwen', 'qwen', ['r5300', 'prdg'])
    const log: string[] = []
    const base = fixtureResources()
    const acquire = vi.fn(async (
      request: Parameters<ResourceLeaseProvider['acquire']>[0],
      signal: Parameters<ResourceLeaseProvider['acquire']>[1],
    ) => {
      if (request.targets.length === 1 && request.targets[0] === 'r5300') {
        throw new ResourceLeaseError('RESOURCE_TARGET_UNAVAILABLE')
      }
      return await base.acquire(request, signal)
    })
    const resources: ResourceLeaseProvider = { ...base, acquire }
    ctx.modelLifecycle.register(admitted, driver(log))
    installAuthority(ctx, () => ({
      kind: 'GOVERNED', route: admitted, scope: executionScope(),
    }), resources)

    const lease = await ctx.modelLifecycle.acquireRoute({
      selection: admitted.selection, preference: 'automatic',
    })

    expect(lease.target).toBe('prdg')
    expect(acquire.mock.calls.map(([request]) => request.targets)).toEqual([['r5300'], ['prdg']])
    expect(log[0]).toBe('preflight:qwen:prdg')
    await lease.release()
  })

  it('expands resource coverage before probing another host while preserving the active route', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['prdg'])
    const log: string[] = []
    const resources = fixtureResources()
    const expand = vi.spyOn(resources, 'expand')
    const release = vi.spyOn(resources, 'release')
    ctx.modelLifecycle.register(qwen, driver(log))
    ctx.modelLifecycle.register(glm, driver(log, { capacity: { prdg: false } }))
    installAuthority(ctx, request => ({
      kind: 'GOVERNED',
      route: request.selection.model === qwen.selection.model ? qwen : glm,
      scope: executionScope({ sessionId: request.sessionId ?? 'session-1' }),
    }), resources)
    const first = await ctx.modelLifecycle.acquireRoute({ selection: qwen.selection })
    await first.release()
    log.length = 0

    await expect(ctx.modelLifecycle.acquireRoute({ selection: glm.selection, preference: 'automatic' }))
      .rejects.toMatchObject({ code: 'NO_CAPACITY' })

    expect(expand).toHaveBeenCalledTimes(1)
    expect(expand.mock.calls[0]?.[1].targets).toEqual(['r5300', 'prdg'])
    expect(release).not.toHaveBeenCalled()
    expect(log).toEqual(['preflight:glm:prdg'])
    expect(ctx.modelLifecycle.snapshot()).toMatchObject({ active: { routeId: 'qwen', target: 'r5300' } })
  })

  it('keeps the active-host lease when expansion definitively rejects the destination target', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['prdg'])
    const resources = fixtureResources()
    const expand = vi.spyOn(resources, 'expand').mockRejectedValue(
      new ResourceLeaseError('RESOURCE_TARGET_UNAVAILABLE'),
    )
    const release = vi.spyOn(resources, 'release')
    ctx.modelLifecycle.register(qwen, driver([]))
    ctx.modelLifecycle.register(glm, driver([]))
    installAuthority(ctx, request => ({
      kind: 'GOVERNED',
      route: request.selection.model === qwen.selection.model ? qwen : glm,
      scope: executionScope({ sessionId: request.sessionId ?? 'session-1' }),
    }), resources)
    const first = await ctx.modelLifecycle.acquireRoute({ selection: qwen.selection })
    await first.release()

    await expect(ctx.modelLifecycle.acquireRoute({ selection: glm.selection, preference: 'automatic' }))
      .rejects.toMatchObject({ code: 'NO_CAPACITY' })

    expect(expand).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()
    expect(ctx.modelLifecycle.snapshot()).toMatchObject({ active: { routeId: 'qwen', target: 'r5300' } })
  })

  it('orders preflight, capture, drain, stop, verification, start, health, and probe', async () => {
    const ctx = await lifecycle()
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['r5300'])
    const log: string[] = []
    const scopes: ModelExecutionScope[] = []
    const observe = (_stage: ModelLifecycleStage, context: ModelLifecycleStageContext) => {
      scopes.push(context.scope)
    }
    ctx.modelLifecycle.register(qwen, driver(log, { observe }))
    ctx.modelLifecycle.register(glm, driver(log, { observe }))
    installRouteAuthority(ctx, [qwen, glm])

    const first = await ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
      sessionId: 'session-1',
    })
    expect(log).toEqual([
      'preflight:qwen:r5300',
      'prestate:qwen:r5300',
      'start:qwen:r5300',
      'health:qwen:r5300',
      'probe:qwen:r5300',
    ])
    await first.release()
    log.length = 0
    scopes.length = 0

    const second = await ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'glm' },
      sessionId: 'session-2',
    })
    expect(log).toEqual([
      'preflight:glm:r5300',
      'prestate:glm:r5300',
      'drain:qwen:r5300',
      'stop:qwen:r5300',
      'verify-stopped:qwen:r5300',
      'start:glm:r5300',
      'health:glm:r5300',
      'probe:glm:r5300',
    ])
    expect(new Set(scopes.map(scope => scope.digest)).size).toBe(1)
    expect(scopes.every(scope => scope.sessionId === 'session-2')).toBe(true)
    expect(ctx.modelLifecycle.snapshot()).toMatchObject({
      phase: 'IN_USE', active: { routeId: 'glm', target: 'r5300' },
    })
    await second.release()
  })

  it('cleans up and restores the previous route after partial stop and start failures', async () => {
    const stopContext = await lifecycle()
    const stopQwen = route('qwen', 'qwen', ['r5300'])
    const stopGlm = route('glm', 'glm', ['r5300'])
    const stopLog: string[] = []
    stopContext.modelLifecycle.register(stopQwen, driver(stopLog, { failStage: 'stop' }))
    stopContext.modelLifecycle.register(stopGlm, driver(stopLog))
    const stopAuthority = installRouteAuthority(stopContext, [stopQwen, stopGlm])
    const stopLease = await stopContext.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })
    await stopLease.release()
    stopLog.length = 0

    await expect(stopContext.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'glm' },
    })).rejects.toMatchObject({ code: 'STOP_FAILED' })
    expect(stopLog).toEqual([
      'preflight:glm:r5300',
      'prestate:glm:r5300',
      'drain:qwen:r5300',
      'stop:qwen:r5300',
      'verify-stopped:qwen:r5300',
      'start:qwen:r5300',
      'health:qwen:r5300',
      'probe:qwen:r5300',
    ])
    expect(stopContext.modelLifecycle.snapshot()).toMatchObject({
      phase: 'FAILED_ROLLED_BACK', active: { routeId: 'qwen' },
    })
    expect(stopAuthority.records.at(-1)).toMatchObject({
      routeId: 'glm', outcome: 'FAILED_ROLLED_BACK', errorCode: 'STOP_FAILED',
    })

    const startContext = await lifecycle()
    const startQwen = route('qwen', 'qwen', ['r5300'])
    const startGlm = route('glm', 'glm', ['r5300'])
    const startLog: string[] = []
    const startScopes: ModelExecutionScope[] = []
    const observeStart = (_stage: ModelLifecycleStage, context: ModelLifecycleStageContext) => {
      startScopes.push(context.scope)
    }
    startContext.modelLifecycle.register(startQwen, driver(startLog, { observe: observeStart }))
    startContext.modelLifecycle.register(startGlm, driver(startLog, {
      failStage: 'start',
      observe: observeStart,
    }))
    const startAuthority = installRouteAuthority(startContext, [startQwen, startGlm])
    const startLease = await startContext.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
      sessionId: 'session-1',
    })
    await startLease.release()
    startLog.length = 0
    startScopes.length = 0

    await expect(startContext.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'glm' },
      sessionId: 'session-2',
    })).rejects.toMatchObject({ code: 'START_FAILED' })
    expect(startLog).toEqual([
      'preflight:glm:r5300',
      'prestate:glm:r5300',
      'drain:qwen:r5300',
      'stop:qwen:r5300',
      'verify-stopped:qwen:r5300',
      'start:glm:r5300',
      'stop:glm:r5300',
      'verify-stopped:glm:r5300',
      'start:qwen:r5300',
      'health:qwen:r5300',
      'probe:qwen:r5300',
    ])
    expect(new Set(startScopes.map(scope => scope.digest)).size).toBe(1)
    expect(startScopes.every(scope => scope.sessionId === 'session-2')).toBe(true)
    expect(startContext.modelLifecycle.snapshot()).toMatchObject({
      phase: 'FAILED_ROLLED_BACK', active: { routeId: 'qwen' },
    })
    expect(startAuthority.records.at(-1)).toMatchObject({
      routeId: 'glm', outcome: 'FAILED_ROLLED_BACK', errorCode: 'START_FAILED',
    })

    const cleanupContext = await lifecycle()
    const cleanupQwen = route('qwen', 'qwen', ['r5300'])
    const cleanupGlm = route('glm', 'glm', ['r5300'])
    const cleanupLog: string[] = []
    cleanupContext.modelLifecycle.register(cleanupQwen, driver(cleanupLog))
    const cleanupDriver = driver(cleanupLog, { failStage: 'start' })
    cleanupContext.modelLifecycle.register(cleanupGlm, {
      ...cleanupDriver,
      stop: async (context) => {
        cleanupLog.push(`stop:${context.route.id}:${context.target}`)
        throw new Error('target cleanup failed')
      },
    })
    const cleanupAuthority = installRouteAuthority(cleanupContext, [cleanupQwen, cleanupGlm])
    const cleanupLease = await cleanupContext.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })
    await cleanupLease.release()
    cleanupLog.length = 0

    await expect(cleanupContext.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'glm' },
    })).rejects.toMatchObject({ code: 'ROLLBACK_FAILED' })
    expect(cleanupLog).toEqual([
      'preflight:glm:r5300',
      'prestate:glm:r5300',
      'drain:qwen:r5300',
      'stop:qwen:r5300',
      'verify-stopped:qwen:r5300',
      'start:glm:r5300',
      'stop:glm:r5300',
    ])
    expect(cleanupContext.modelLifecycle.snapshot()).toEqual({ phase: 'TAINTED' })
    expect(cleanupAuthority.records.at(-1)).toMatchObject({
      routeId: 'glm', outcome: 'TAINTED', errorCode: 'ROLLBACK_FAILED',
    })
    await expect(cleanupContext.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })).rejects.toMatchObject({ code: 'RUNTIME_TAINTED' })
  })

  it('keeps a restored source usable after a definite mutation-free stop rejection', async () => {
    const ctx = await lifecycle()
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['r5300'])
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log, { rejectFirstStopWithRestoredSource: true }))
    ctx.modelLifecycle.register(glm, driver(log))
    installRouteAuthority(ctx, [qwen, glm])
    const first = await ctx.modelLifecycle.acquireRoute({ selection: { provider: 'local', model: 'qwen' } })
    await first.release()
    log.length = 0

    await expect(ctx.modelLifecycle.acquireRoute({ selection: { provider: 'local', model: 'glm' } }))
      .rejects.toMatchObject({ code: 'STOP_FAILED' })
    expect(log).toEqual([
      'preflight:glm:r5300', 'prestate:glm:r5300', 'drain:qwen:r5300', 'stop:qwen:r5300',
    ])
    expect(ctx.modelLifecycle.snapshot()).toMatchObject({ phase: 'READY', active: { routeId: 'qwen' } })

    const retry = await ctx.modelLifecycle.acquireRoute({ selection: { provider: 'local', model: 'glm' } })
    expect(log.slice(-8)).toEqual([
      'preflight:glm:r5300', 'prestate:glm:r5300', 'drain:qwen:r5300', 'stop:qwen:r5300',
      'verify-stopped:qwen:r5300', 'start:glm:r5300', 'health:glm:r5300', 'probe:glm:r5300',
    ])
    expect(ctx.modelLifecycle.snapshot()).toMatchObject({ phase: 'IN_USE', active: { routeId: 'glm' } })
    await retry.release()
  })

  it('taints instead of restarting a route whose failed stop cannot be verified', async () => {
    const ctx = await lifecycle()
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['r5300'])
    const log: string[] = []
    const qwenDriver = driver(log, { failStage: 'stop' })
    ctx.modelLifecycle.register(qwen, {
      ...qwenDriver,
      verifyStopped: async (context) => {
        log.push(`verify-stopped:${context.route.id}:${context.target}`)
        throw new Error('host state remains indeterminate')
      },
    })
    ctx.modelLifecycle.register(glm, driver(log))
    const authority = installRouteAuthority(ctx, [qwen, glm])
    const lease = await ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })
    await lease.release()
    log.length = 0

    await expect(ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'glm' },
    })).rejects.toMatchObject({ code: 'STOP_FAILED' })

    expect(log).toEqual([
      'preflight:glm:r5300',
      'prestate:glm:r5300',
      'drain:qwen:r5300',
      'stop:qwen:r5300',
      'verify-stopped:qwen:r5300',
    ])
    expect(ctx.modelLifecycle.snapshot()).toEqual({ phase: 'TAINTED' })
    expect(authority.records.at(-1)).toMatchObject({
      routeId: 'glm', outcome: 'TAINTED', errorCode: 'STOP_FAILED',
    })
  })

  it('uses a detached cleanup signal to restore the previous route after cancellation', async () => {
    const ctx = await lifecycle()
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['r5300'])
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log))
    const glmDriver = driver(log)
    let startEntered!: () => void
    const entered = new Promise<void>((resolve) => { startEntered = resolve })
    let finishStart!: () => void
    ctx.modelLifecycle.register(glm, {
      ...glmDriver,
      start: async (context) => {
        log.push(`start:${context.route.id}:${context.target}`)
        startEntered()
        return await new Promise<ModelLifecycleStageReceipt>((resolve) => {
          finishStart = () => { resolve(stageReceipt('start', context)) }
        })
      },
    })
    installRouteAuthority(ctx, [qwen, glm])
    const first = await ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })
    await first.release()
    log.length = 0

    const controller = new AbortController()
    const result = ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'glm' }, signal: controller.signal,
    }).then(() => undefined, (error: unknown) => error)
    await entered
    controller.abort()
    await flushMicrotasks()
    finishStart()

    expect(await result).toMatchObject({ code: 'ABORTED' })
    expect(log).toEqual([
      'preflight:glm:r5300',
      'prestate:glm:r5300',
      'drain:qwen:r5300',
      'stop:qwen:r5300',
      'verify-stopped:qwen:r5300',
      'start:glm:r5300',
      'stop:glm:r5300',
      'verify-stopped:glm:r5300',
      'start:qwen:r5300',
      'health:qwen:r5300',
      'probe:qwen:r5300',
    ])
    expect(ctx.modelLifecycle.snapshot()).toMatchObject({
      phase: 'FAILED_ROLLED_BACK', active: { routeId: 'qwen' },
    })
  })

  it('taints when a cancelled mutating stage never reaches a known state before its deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'))
    const ctx = await lifecycle({ stageTimeoutMs: 50 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['r5300'])
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log))
    const glmDriver = driver(log)
    let enteredStart!: () => void
    const entered = new Promise<void>((resolve) => { enteredStart = resolve })
    ctx.modelLifecycle.register(glm, {
      ...glmDriver,
      start: async (context) => {
        log.push(`start:${context.route.id}:${context.target}`)
        enteredStart()
        return await new Promise<ModelLifecycleStageReceipt>(() => {})
      },
    })
    installRouteAuthority(ctx, [qwen, glm])
    const first = await ctx.modelLifecycle.acquireRoute({ selection: { provider: 'local', model: 'qwen' } })
    await first.release()
    const controller = new AbortController()
    const result = ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'glm' }, signal: controller.signal,
    }).then(lease => lease, (error: unknown) => error)
    await entered

    controller.abort()
    await vi.advanceTimersByTimeAsync(50)

    expect(await result).toMatchObject({ code: 'STAGE_TIMEOUT' })
    expect(ctx.modelLifecycle.snapshot()).toEqual({ phase: 'TAINTED' })
  })

  it('rejects unsupported reasoning effort before acquiring or probing resources', async () => {
    const ctx = await lifecycle()
    const admitted = route('qwen', 'qwen', ['r5300'], { supportedReasoningEfforts: ['low', 'high'] })
    const log: string[] = []
    ctx.modelLifecycle.register(admitted, driver(log))
    const authority = installRouteAuthority(ctx, [admitted])

    await expect(ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen', reasoningEffort: 'medium' },
    })).rejects.toMatchObject({ code: 'REASONING_UNSUPPORTED' })
    expect(log).toEqual([])
    expect(authority.records).toEqual([])

    const lease = await ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen', reasoningEffort: 'high' },
    })
    expect(lease.managed).toBe(true)
    await lease.release()
  })

  it('surfaces stable lifecycle codes without authority or driver detail', async () => {
    const held = await lifecycle()
    const admitted = route('qwen', 'qwen', ['r5300'])
    held.modelLifecycle.register(admitted, driver([]))
    installAuthority(held, () => ({
      kind: 'HELD', routeId: admitted.id, reason: 'private://credential-and-host-path',
    }))

    const heldError = await held.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    }).then(() => undefined, (error: unknown) => error)
    expect(heldError).toBeInstanceOf(LlmError)
    expect(heldError).toMatchObject({ code: 'ROUTE_HELD' })
    expect(String(heldError)).not.toContain('private://')
    expect((heldError as Error).cause).toBeUndefined()

    const noCapacity = await lifecycle()
    const constrained = route('qwen', 'qwen', ['r5300'])
    noCapacity.modelLifecycle.register(constrained, driver([], { capacity: { r5300: false } }))
    installRouteAuthority(noCapacity, [constrained])
    const capacityError = await noCapacity.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    }).then(() => undefined, (error: unknown) => error)
    expect(capacityError).toBeInstanceOf(LlmError)
    expect(capacityError).toMatchObject({ code: 'NO_CAPACITY' })
    expect(String(capacityError)).not.toContain('capacity held')
    expect((capacityError as Error).cause).toBeUndefined()
  })

  it('preserves lifecycle failure codes through the LLM stream boundary', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(FixtureModelLifecycleRuntime)
    const admitted = route('qwen', 'qwen', ['r5300'])
    ctx.llm.registerAdapter(['local'], new class extends LlmAdapter {
      async * stream(): AsyncIterable<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    ctx.modelLifecycle.register(admitted, driver([]))
    installAuthority(ctx, () => ({
      kind: 'HELD', routeId: admitted.id, reason: 'private://authority-detail',
    }))

    const failure = await collect(ctx.llm.stream({
      provider: 'local', model: 'qwen', messages: [],
    })).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(LlmError)
    expect(failure).toMatchObject({
      failure: {
        message: 'Local model route qwen is held by governance',
        code: 'ROUTE_HELD',
      },
    })
  })

  it('blocks provider dispatch and rolls back when the exact session disappears before route publication', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(ModelLifecycleRuntime)
    await ctx.plugin(LlmRuntime)
    const qwen = route('qwen', 'qwen', ['r5300'])
    const sessionId = SessionId('publication-failure-session')
    const session = ctx.sessions.prepare(sessionId)
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    const log: string[] = []
    const records: ModelLifecycleAuditRecord[] = []
    let adapterRequests = 0
    ctx.modelLifecycle.register(qwen, driver(log))
    ctx.modelLifecycle.installResources(fixtureResources())
    ctx.modelLifecycle.installAuthority({
      classifyProvider: provider => provider === 'local' ? 'GOVERNED_LOCAL' : 'UNMANAGED_EXTERNAL',
      resolve: request => ({
        kind: 'GOVERNED',
        route: qwen,
        scope: executionScope({ sessionId: request.sessionId! }),
      }),
      record: async (record) => {
        records.push(record)
        if (record.outcome === 'READY') detach()
      },
    })
    ctx.llm.registerAdapter(['local'], new class extends LlmAdapter {
      async * stream(): AsyncIterable<StreamChunk> {
        adapterRequests++
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())

    const failure = await collect(ctx.llm.stream({
      provider: qwen.selection.provider,
      model: qwen.selection.model,
      messages: [],
      sessionId,
    })).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'SESSION_PUBLICATION_FAILED' })
    expect(adapterRequests).toBe(0)
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    expect(log).toEqual([
      'preflight:qwen:r5300',
      'prestate:qwen:r5300',
      'start:qwen:r5300',
      'health:qwen:r5300',
      'probe:qwen:r5300',
      'stop:qwen:r5300',
      'verify-stopped:qwen:r5300',
    ])
    expect(records.map(record => ({ outcome: record.outcome, errorCode: record.errorCode }))).toEqual([
      { outcome: 'READY', errorCode: undefined },
      { outcome: 'FAILED_ROLLED_BACK', errorCode: 'SESSION_PUBLICATION_FAILED' },
    ])
    expect(ctx.modelLifecycle.snapshot()).toEqual({ phase: 'IDLE' })
  })

  it('serializes the global lease across the complete LLM stream', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(FixtureModelLifecycleRuntime)
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['r5300'])
    const lifecycleLog: string[] = []
    const adapterLog: string[] = []
    let finishQwen!: () => void
    const qwenGate = new Promise<void>((resolve) => { finishQwen = resolve })

    class ControlledAdapter extends LlmAdapter {
      async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        adapterLog.push(`start:${options.model}`)
        if (options.model === 'qwen') await qwenGate
        adapterLog.push(`finish:${options.model}`)
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }

    ctx.llm.registerAdapter(['local'], new ControlledAdapter())
    ctx.modelLifecycle.register(qwen, driver(lifecycleLog))
    ctx.modelLifecycle.register(glm, driver(lifecycleLog))
    installRouteAuthority(ctx, [qwen, glm])
    const request = (model: string): GenerateOptions => ({ provider: 'local', model, messages: [] })

    const first = collect(ctx.llm.stream(request('qwen')))
    await vi.waitFor(() =>{  expect(adapterLog).toContain('start:qwen') })
    let secondSettled = false
    const second = collect(ctx.llm.stream(request('glm'))).then((chunks) => {
      secondSettled = true
      return chunks
    })
    await flushMicrotasks()

    expect(secondSettled).toBe(false)
    expect(adapterLog).not.toContain('start:glm')
    expect(ctx.modelLifecycle.snapshot()).toMatchObject({ phase: 'IN_USE', active: { routeId: 'qwen' } })

    finishQwen()
    await first
    await second
    expect(adapterLog).toEqual(['start:qwen', 'finish:qwen', 'start:glm', 'finish:glm'])
    expect(ctx.modelLifecycle.snapshot()).toMatchObject({ phase: 'READY', active: { routeId: 'glm' } })
  })

  it('preserves request order across asynchronous authority resolution', async () => {
    const ctx = await lifecycle()
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['r5300'])
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log))
    ctx.modelLifecycle.register(glm, driver(log))
    let allowFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { allowFirst = resolve })
    const authority = installAuthority(ctx, async (request) => {
      if (request.selection.model === 'qwen') await firstGate
      const admitted = request.selection.model === 'qwen' ? qwen : glm
      return { kind: 'GOVERNED', route: admitted, scope: executionScope({
        sessionId: request.sessionId ?? 'session-1',
      }) }
    })

    const firstPending = ctx.modelLifecycle.acquireRoute({
      sessionId: 'session-1', selection: { provider: 'local', model: 'qwen' },
    })
    await flushMicrotasks()
    const secondPending = ctx.modelLifecycle.acquireRoute({
      sessionId: 'session-2', selection: { provider: 'local', model: 'glm' },
    })
    await flushMicrotasks()
    expect(authority.resolve).toHaveBeenCalledTimes(1)

    allowFirst()
    const first = await firstPending
    expect(first.routeId).toBe('qwen')
    expect(authority.resolve).toHaveBeenCalledTimes(1)
    await first.release()

    const second = await secondPending
    expect(second.routeId).toBe('glm')
    expect(authority.resolve).toHaveBeenCalledTimes(2)
    await second.release()
  })

  it('bounds pending inference without stopping the active route or blocking external models', async () => {
    const ctx = await lifecycle({ maxPendingRequests: 1 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log))
    const authority = installRouteAuthority(ctx, [qwen])
    const request = { sessionId: 'session-1', selection: qwen.selection }
    const first = await ctx.modelLifecycle.acquireRoute(request)
    const pending = ctx.modelLifecycle.acquireRoute(request)
    await expect(ctx.modelLifecycle.acquireRoute(request)).rejects.toMatchObject({ code: 'QUEUE_FULL' })
    expect(authority.resolve).toHaveBeenCalledTimes(1)
    expect(log).not.toContain('stop:qwen:r5300')
    const external = await ctx.modelLifecycle.acquireRoute({ selection: { provider: 'external', model: 'remote' } })
    expect(external.managed).toBe(false)
    await external.release()
    await first.release()
    const second = await pending
    expect(authority.resolve).toHaveBeenCalledTimes(2)
    await second.release()
  })

  it('expires a queued request and immediately admits its replacement without touching active inference', async () => {
    vi.useFakeTimers()
    const ctx = await lifecycle({ maxPendingRequests: 1, queueTimeoutMs: 50, idleUnloadMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log))
    const authority = installRouteAuthority(ctx, [qwen])
    const request = { sessionId: 'session-1', selection: qwen.selection }
    const first = await ctx.modelLifecycle.acquireRoute(request)
    const expired = expect(ctx.modelLifecycle.acquireRoute(request)).rejects.toMatchObject({ code: 'QUEUE_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(50)
    await expired
    expect(authority.resolve).toHaveBeenCalledTimes(1)
    expect(ctx.modelLifecycle.snapshot().phase).toBe('IN_USE')
    expect(log).not.toContain('stop:qwen:r5300')
    const replacement = ctx.modelLifecycle.acquireRoute(request)
    await first.release()
    const next = await replacement
    await next.release()
    expect(authority.resolve).toHaveBeenCalledTimes(2)
  })

  it('allows zero pending requests and validates queue count and timer bounds', async () => {
    for (const config of [
      { maxPendingRequests: -1 }, { maxPendingRequests: 1.5 },
      { queueTimeoutMs: 0 }, { queueTimeoutMs: 1.5 }, { queueTimeoutMs: 2_147_483_648 },
    ]) expect(() => Config(config)).toThrow()
    const ctx = await lifecycle({ maxPendingRequests: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    ctx.modelLifecycle.register(qwen, driver([]))
    installRouteAuthority(ctx, [qwen])
    const request = { sessionId: 'session-1', selection: qwen.selection }
    const first = await ctx.modelLifecycle.acquireRoute(request)
    await expect(ctx.modelLifecycle.acquireRoute(request)).rejects.toMatchObject({ code: 'QUEUE_FULL' })
    // Orderly disposal still waits for the current stream even when inference queue admission is disabled.
    const disposed = ctx.fiber.dispose()
    await first.release()
    await disposed
  })

  it('releases an aborted queued acquisition so the next waiter proceeds', async () => {
    const ctx = await lifecycle({ maxPendingRequests: 1 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['r5300'])
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log))
    ctx.modelLifecycle.register(glm, driver(log))
    installRouteAuthority(ctx, [qwen, glm])

    const first = await ctx.modelLifecycle.acquireRoute({
      sessionId: 'session-1', selection: { provider: 'local', model: 'qwen' },
    })
    const controller = new AbortController()
    let abortedSettled = false
    const aborted = ctx.modelLifecycle.acquireRoute({
      sessionId: 'session-2',
      selection: { provider: 'local', model: 'glm' },
      signal: controller.signal,
    }).then(
      lease => lease,
      (error: unknown) => {
        abortedSettled = true
        return error
      },
    )
    await flushMicrotasks()
    controller.abort()
    await flushMicrotasks()
    expect(abortedSettled).toBe(true)
    expect(await aborted).toMatchObject({ code: 'ABORTED' })

    let followingSettled = false
    const following = ctx.modelLifecycle.acquireRoute({
      sessionId: 'session-3', selection: { provider: 'local', model: 'glm' },
    }).then((lease) => {
      followingSettled = true
      return lease
    })
    await flushMicrotasks()
    expect(followingSettled).toBe(false)
    await first.release()

    const lease = await following
    expect(lease).toMatchObject({ managed: true, routeId: 'glm' })
    await lease.release()
  })

  it('passes the slot once when a waiter is cancelled during grant before its continuation resumes', async () => {
    vi.useFakeTimers()
    const ctx = await lifecycle({ maxPendingRequests: 2, queueTimeoutMs: 20, idleUnloadMs: 0 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['r5300'])
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log))
    ctx.modelLifecycle.register(glm, driver(log))
    const authority = installRouteAuthority(ctx, [qwen, glm])
    const first = await ctx.modelLifecycle.acquireRoute({ selection: qwen.selection })
    const controller = new AbortController()
    const remove = controller.signal.removeEventListener.bind(controller.signal)
    const removal = vi.spyOn(controller.signal, 'removeEventListener').mockImplementation((type, listener, options) => {
      remove(type, listener, options)
      controller.abort()
    })
    const cancelled = expect(ctx.modelLifecycle.acquireRoute({
      selection: glm.selection, signal: controller.signal,
    })).rejects.toMatchObject({ code: 'ABORTED' })
    const following = ctx.modelLifecycle.acquireRoute({ selection: qwen.selection })
    await first.release()
    await cancelled
    const lease = await following
    await vi.advanceTimersByTimeAsync(20)
    expect(removal).toHaveBeenCalledTimes(1)
    expect(authority.resolve).toHaveBeenCalledTimes(2)
    expect(log.some(entry => entry.includes(':glm:'))).toBe(false)
    expect(ctx.modelLifecycle.snapshot().phase).toBe('IN_USE')
    await lease.release()
  })

  it('emits frozen, sanitized READY, RELEASED, and FAILED_ROLLED_BACK audit records', async () => {
    const ctx = await lifecycle()
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['r5300'])
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log))
    ctx.modelLifecycle.register(glm, driver(log, { failStage: 'start' }))
    const privateScope = executionScope({
      workId: 'private-work-value',
      principalId: 'private-principal-value',
      tenantId: 'private-tenant-value',
      sessionId: 'private-session-value',
    })
    const authority = installRouteAuthority(ctx, [qwen, glm], () => privateScope)

    const lease = await ctx.modelLifecycle.acquireRoute({
      sessionId: privateScope.sessionId,
      selection: { provider: 'local', model: 'qwen' },
    })
    await lease.release()
    const ready = authority.records[0]!
    const released = authority.records[1]!

    expect(Object.keys(ready).sort()).toEqual([
      'outcome', 'receiptDigests', 'routeId', 'scopeDigest', 'target', 'transactionDigest',
    ])
    expect(ready).toMatchObject({
      routeId: 'qwen', target: 'r5300', scopeDigest: privateScope.digest, outcome: 'READY',
    })
    expect(ready.transactionDigest).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(ready.receiptDigests).toHaveLength(5)
    expect(Object.isFrozen(ready)).toBe(true)
    expect(Object.isFrozen(ready.receiptDigests)).toBe(true)

    expect(Object.keys(released).sort()).toEqual([
      'outcome', 'receiptDigests', 'routeId', 'scopeDigest', 'target', 'transactionDigest',
    ])
    expect(released).toEqual({ ...ready, outcome: 'RELEASED' })
    expect(Object.isFrozen(released)).toBe(true)
    expect(Object.isFrozen(released.receiptDigests)).toBe(true)

    await expect(ctx.modelLifecycle.acquireRoute({
      sessionId: privateScope.sessionId,
      selection: { provider: 'local', model: 'glm' },
    })).rejects.toMatchObject({ code: 'START_FAILED' })
    const rolledBack = authority.records[2]!
    expect(Object.keys(rolledBack).sort()).toEqual([
      'errorCode', 'outcome', 'receiptDigests', 'routeId', 'scopeDigest', 'transactionDigest',
    ])
    expect(rolledBack).toMatchObject({
      routeId: 'glm',
      scopeDigest: privateScope.digest,
      outcome: 'FAILED_ROLLED_BACK',
      errorCode: 'START_FAILED',
    })
    expect(rolledBack).not.toHaveProperty('target')
    expect(rolledBack.receiptDigests.length).toBeGreaterThan(5)
    expect(Object.isFrozen(rolledBack)).toBe(true)
    expect(Object.isFrozen(rolledBack.receiptDigests)).toBe(true)

    const serialized = JSON.stringify(authority.records)
    for (const privateValue of [
      privateScope.workId,
      privateScope.principalId,
      privateScope.tenantId,
      privateScope.sessionId,
    ]) expect(serialized).not.toContain(privateValue)
  })

  it('publishes one frozen sanitized effective route for every successful managed request', async () => {
    const ctx = await lifecycle()
    const qwen = route('qwen', 'qwen', ['r5300'], { supportedReasoningEfforts: ['high'] })
    const log: string[] = []
    const sessionId = 'private-effective-route-session'
    ctx.modelLifecycle.register(qwen, driver(log))
    installRouteAuthority(ctx, [qwen])

    const first = await ctx.modelLifecycle.acquireRoute({
      sessionId,
      selection: { ...qwen.selection, reasoningEffort: 'high' },
    })
    await first.release()
    const second = await ctx.modelLifecycle.acquireRoute({
      sessionId,
      selection: { ...qwen.selection, reasoningEffort: 'high' },
    })
    await second.release()

    const events = ctx.sessions.get(SessionId(sessionId))!.events.filter(event =>
      event.type === 'model-lifecycle/effective-route')
    expect(events).toHaveLength(2)
    expect(events[0]!.data).toMatchObject({
      selection: { provider: 'local', model: 'qwen', reasoningEffort: 'high' },
      routeId: 'qwen',
      target: 'r5300',
      admissionReceiptDigest: ADMISSION_DIGEST,
      revisionDigest: REVISION_DIGEST,
      scopeDigest: createModelExecutionScopeDigest({ ...DEFAULT_SCOPE_FIELDS, sessionId }),
      fencingDigest: digest('f'),
    })
    expect(Object.keys(events[0]!.data).sort()).toEqual([
      'admissionReceiptDigest', 'fencingDigest', 'receiptDigests', 'revisionDigest', 'routeId',
      'scopeDigest', 'selection', 'target', 'transactionDigest',
    ])
    expect(events[0]!.data.receiptDigests).toHaveLength(5)
    expect(events[1]!.data.receiptDigests).toHaveLength(4)
    expect(events[0]!.data.transactionDigest).not.toBe(events[1]!.data.transactionDigest)
    for (const event of events) {
      expect(Object.isFrozen(event)).toBe(true)
      expect(Object.isFrozen(event.data)).toBe(true)
      expect(Object.isFrozen(event.data.selection)).toBe(true)
      expect(Object.isFrozen(event.data.receiptDigests)).toBe(true)
    }
    const serialized = JSON.stringify(events)
    for (const privateValue of [sessionId, DEFAULT_SCOPE_FIELDS.workId, DEFAULT_SCOPE_FIELDS.principalId, DEFAULT_SCOPE_FIELDS.tenantId]) {
      expect(serialized).not.toContain(privateValue)
    }
  })

  it('does not publish effective routes for external, held, or failed acquisitions', async () => {
    const ctx = await lifecycle()
    const failed = route('failed', 'failed', ['r5300'])
    const log: string[] = []
    ctx.modelLifecycle.register(failed, driver(log, { failStage: 'start' }))
    installAuthority(ctx, request => request.selection.model === 'held'
      ? { kind: 'HELD', routeId: 'held', reason: 'test-only governance hold' }
      : {
        kind: 'GOVERNED',
        route: failed,
        scope: executionScope({ sessionId: request.sessionId! }),
      })

    const external = await ctx.modelLifecycle.acquireRoute({
      sessionId: 'external-session',
      selection: { provider: 'external', model: 'cloud' },
    })
    await external.release()
    await expect(ctx.modelLifecycle.acquireRoute({
      sessionId: 'held-session',
      selection: { provider: 'local', model: 'held' },
    })).rejects.toMatchObject({ code: 'ROUTE_HELD' })
    await expect(ctx.modelLifecycle.acquireRoute({
      sessionId: 'failed-session',
      selection: failed.selection,
    })).rejects.toMatchObject({ code: 'START_FAILED' })

    for (const sessionId of ['external-session', 'held-session', 'failed-session']) {
      expect(ctx.sessions.get(SessionId(sessionId))!.events).not.toContainEqual(
        expect.objectContaining({ type: 'model-lifecycle/effective-route' }),
      )
    }
  })

  it('does not invalidate completed output when RELEASED audit fails, but fail-closes later local work', async () => {
    const ctx = await lifecycle()
    const admitted = route('qwen', 'qwen', ['r5300'])
    const log: string[] = []
    ctx.modelLifecycle.register(admitted, driver(log))
    const attempts: ModelLifecycleAuditRecord[] = []
    ctx.modelLifecycle.installResources(fixtureResources())
    ctx.modelLifecycle.installAuthority({
      classifyProvider: provider => provider === 'local' ? 'GOVERNED_LOCAL' : 'UNMANAGED_EXTERNAL',
      resolve: () => ({ kind: 'GOVERNED', route: admitted, scope: executionScope() }),
      record: async (entry) => {
        attempts.push(entry)
        if (entry.outcome === 'RELEASED') throw new Error('audit store unavailable')
      },
    })

    const lease = await ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })
    await expect(lease.release()).resolves.toBeUndefined()
    expect(attempts.map(entry => entry.outcome)).toEqual(['READY', 'RELEASED'])
    expect(ctx.modelLifecycle.snapshot()).toMatchObject({
      phase: 'TAINTED', active: { routeId: 'qwen', target: 'r5300' },
    })
    await expect(ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })).rejects.toMatchObject({ code: 'RUNTIME_TAINTED' })
  })

  it('bounds route authority resolution and releases the lifecycle queue after timeout', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'))
    const ctx = await lifecycle({ stageTimeoutMs: 50 })
    const admitted = route('qwen', 'qwen', ['r5300'])
    ctx.modelLifecycle.register(admitted, driver([]))
    let attempt = 0
    let firstSignal: AbortSignal | undefined
    installAuthority(ctx, (request, signal) => {
      attempt += 1
      if (attempt === 1) {
        firstSignal = signal
        return new Promise<ModelRouteResolution>(() => {})
      }
      return {
        kind: 'GOVERNED',
        route: admitted,
        scope: executionScope({ sessionId: request.sessionId ?? 'session-1' }),
      }
    })
    const first = ctx.modelLifecycle.acquireRoute({
      sessionId: 'session-1', selection: { provider: 'local', model: 'qwen' },
    }).then(lease => lease, (error: unknown) => error)
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(50)

    expect(await first).toMatchObject({ code: 'GOVERNANCE_UNAVAILABLE' })
    expect(firstSignal?.aborted).toBe(true)
    expect(ctx.modelLifecycle.snapshot()).toEqual({ phase: 'IDLE' })
    const second = await ctx.modelLifecycle.acquireRoute({
      sessionId: 'session-2', selection: { provider: 'local', model: 'qwen' },
    })
    expect(second).toMatchObject({ managed: true, routeId: 'qwen' })
    await second.release()
  })

  it('keeps authority installed until a timed-out resolver actually settles', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'))
    const ctx = await lifecycle({ stageTimeoutMs: 50 })
    const admitted = route('qwen', 'qwen', ['r5300'])
    const unregister = ctx.modelLifecycle.register(admitted, driver([]))
    let settle!: () => void
    const resolution = new Promise<ModelRouteResolution>((resolve) => {
      settle = () => {
        resolve({
          kind: 'GOVERNED',
          route: admitted,
          scope: executionScope({ sessionId: 'session-1' }),
        })
      }
    })
    const releaseAuthority = ctx.modelLifecycle.installAuthority({
      classifyProvider: provider => provider === 'local' ? 'GOVERNED_LOCAL' : 'UNMANAGED_EXTERNAL',
      resolve: () => resolution,
      record: () => Promise.resolve(),
    })
    const result = ctx.modelLifecycle.acquireRoute({
      sessionId: 'session-1', selection: admitted.selection,
    }).then(() => undefined, (error: unknown) => error)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(50)

    expect(await result).toMatchObject({ code: 'GOVERNANCE_UNAVAILABLE' })
    await unregister()
    expect(() => { releaseAuthority() }).toThrow('authority remains in use')

    settle()
    await flushMicrotasks()
    expect(() => { releaseAuthority() }).not.toThrow()
  })

  it('keeps resources installed until a late timed-out acquisition and cleanup settle', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'))
    const ctx = await lifecycle({ stageTimeoutMs: 50 })
    const admitted = route('qwen', 'qwen', ['r5300'])
    const unregister = ctx.modelLifecycle.register(admitted, driver([]))
    const base = fixtureResources()
    let settle!: () => void
    const release = vi.fn((
      grant: ResourceLeaseGrant,
      outcome: 'SETTLED' | 'UNCERTAIN',
      signal: AbortSignal,
    ) => base.release(grant, outcome, signal))
    const resources: ResourceLeaseProvider = {
      ...base,
      acquire: request => new Promise<ResourceLeaseGrant>((resolve) => {
        settle = () => { void base.acquire(request, new AbortController().signal).then(resolve) }
      }),
      release,
    }
    const releaseResources = ctx.modelLifecycle.installResources(resources)
    ctx.modelLifecycle.installAuthority({
      classifyProvider: provider => provider === 'local' ? 'GOVERNED_LOCAL' : 'UNMANAGED_EXTERNAL',
      resolve: request => ({
        kind: 'GOVERNED', route: admitted,
        scope: executionScope({ sessionId: request.sessionId ?? 'session-1' }),
      }),
      record: () => Promise.resolve(),
    })
    const result = ctx.modelLifecycle.acquireRoute({
      sessionId: 'session-1', selection: admitted.selection,
    }).then(() => undefined, (error: unknown) => error)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(50)

    expect(await result).toMatchObject({ code: 'RESOURCE_LEASE_UNAVAILABLE' })
    await unregister()
    expect(() => { releaseResources() }).toThrow('resources remain in use')

    settle()
    await flushMicrotasks()
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ targets: ['r5300'] }),
      'UNCERTAIN',
      expect.any(AbortSignal),
    )
    expect(() => { releaseResources() }).not.toThrow()
  })

  it('bounds READY audit persistence, preserves TAINTED, and releases the lifecycle queue', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'))
    const ctx = await lifecycle({ stageTimeoutMs: 50 })
    const admitted = route('qwen', 'qwen', ['r5300'])
    const log: string[] = []
    let auditSignal: AbortSignal | undefined
    let settleAudit!: () => void
    const pendingAudit = new Promise<void>((resolve) => { settleAudit = resolve })
    const auditRecords: ModelLifecycleAuditRecord[] = []
    ctx.modelLifecycle.register(admitted, driver(log))
    ctx.modelLifecycle.installResources(fixtureResources())
    ctx.modelLifecycle.installAuthority({
      classifyProvider: provider => provider === 'local' ? 'GOVERNED_LOCAL' : 'UNMANAGED_EXTERNAL',
      resolve: request => ({
        kind: 'GOVERNED', route: admitted,
        scope: executionScope({ sessionId: request.sessionId ?? 'session-1' }),
      }),
      record: (record, signal) => {
        auditRecords.push(record)
        auditSignal = signal
        return auditRecords.length === 1 ? pendingAudit : Promise.resolve()
      },
    })
    const result = ctx.modelLifecycle.acquireRoute({
      sessionId: 'session-1', selection: { provider: 'local', model: 'qwen' },
    }).then(lease => lease, (error: unknown) => error)
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(50)

    expect(await result).toMatchObject({ code: 'AUDIT_FAILED' })
    expect(auditSignal?.aborted).toBe(true)
    expect(ctx.modelLifecycle.snapshot()).toMatchObject({
      phase: 'TAINTED',
      active: { routeId: 'qwen', target: 'r5300' },
    })
    expect(log).not.toContain('stop:qwen:r5300')
    expect(auditRecords.map(record => record.outcome)).toEqual(['READY'])
    settleAudit()
    await flushMicrotasks()
    expect(auditRecords.map(record => record.outcome)).toEqual(['READY', 'TAINTED'])
    expect(auditRecords[1]).toMatchObject({
      transactionDigest: auditRecords[0]!.transactionDigest,
      routeId: 'qwen',
      errorCode: 'AUDIT_FAILED',
    })
    await expect(ctx.modelLifecycle.acquireRoute({
      sessionId: 'session-2', selection: { provider: 'local', model: 'qwen' },
    })).rejects.toMatchObject({ code: 'RUNTIME_TAINTED' })
  })

  it('rolls back after a definite READY audit rejection and attempts a TAINTED record', async () => {
    const ctx = await lifecycle()
    const admitted = route('qwen', 'qwen', ['r5300'])
    const log: string[] = []
    const auditRecords: ModelLifecycleAuditRecord[] = []
    ctx.modelLifecycle.register(admitted, driver(log))
    ctx.modelLifecycle.installResources(fixtureResources())
    ctx.modelLifecycle.installAuthority({
      classifyProvider: provider => provider === 'local' ? 'GOVERNED_LOCAL' : 'UNMANAGED_EXTERNAL',
      resolve: request => ({
        kind: 'GOVERNED', route: admitted,
        scope: executionScope({ sessionId: request.sessionId ?? 'session-1' }),
      }),
      record: (record) => {
        auditRecords.push(record)
        return auditRecords.length === 1
          ? Promise.reject(new Error('audit-rejected'))
          : Promise.resolve()
      },
    })

    await expect(ctx.modelLifecycle.acquireRoute({
      sessionId: 'session-1', selection: admitted.selection,
    })).rejects.toMatchObject({ code: 'AUDIT_FAILED' })

    expect(log.slice(-2)).toEqual(['stop:qwen:r5300', 'verify-stopped:qwen:r5300'])
    expect(ctx.modelLifecycle.snapshot()).toEqual({ phase: 'TAINTED' })
    expect(auditRecords.map(record => record.outcome)).toEqual(['READY', 'TAINTED'])
    expect(auditRecords[1]).toMatchObject({
      transactionDigest: auditRecords[0]!.transactionDigest,
      routeId: 'qwen',
      errorCode: 'AUDIT_FAILED',
    })
  })

  it('attempts a bounded TAINTED compensation after a timed-out READY audit rejects late', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'))
    const ctx = await lifecycle({ stageTimeoutMs: 50 })
    const admitted = route('qwen', 'qwen', ['r5300'])
    let rejectAudit!: (reason: unknown) => void
    const pendingAudit = new Promise<void>((_resolve, reject) => { rejectAudit = reject })
    const auditRecords: ModelLifecycleAuditRecord[] = []
    const auditSignals: AbortSignal[] = []
    ctx.modelLifecycle.register(admitted, driver([]))
    ctx.modelLifecycle.installResources(fixtureResources())
    ctx.modelLifecycle.installAuthority({
      classifyProvider: provider => provider === 'local' ? 'GOVERNED_LOCAL' : 'UNMANAGED_EXTERNAL',
      resolve: request => ({
        kind: 'GOVERNED', route: admitted,
        scope: executionScope({ sessionId: request.sessionId ?? 'session-1' }),
      }),
      record: (record, signal) => {
        auditRecords.push(record)
        auditSignals.push(signal)
        return auditRecords.length === 1 ? pendingAudit : new Promise<void>(() => {})
      },
    })
    const result = ctx.modelLifecycle.acquireRoute({
      sessionId: 'session-1', selection: admitted.selection,
    }).then(() => undefined, (error: unknown) => error)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(50)

    expect(await result).toMatchObject({ code: 'AUDIT_FAILED' })
    rejectAudit(new Error('late-audit-rejection'))
    await flushMicrotasks()
    expect(auditRecords.map(record => record.outcome)).toEqual(['READY', 'TAINTED'])
    await vi.advanceTimersByTimeAsync(50)
    expect(auditSignals[1]?.aborted).toBe(true)
    expect(ctx.modelLifecycle.snapshot()).toMatchObject({
      phase: 'TAINTED',
      active: { routeId: 'qwen', target: 'r5300' },
    })
  })

  it('cancels a host stage at its explicit deadline and records a typed rejection', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'))
    const ctx = await lifecycle({ stageTimeoutMs: 50 })
    const admitted = route('qwen', 'qwen', ['r5300'])
    const log: string[] = []
    let stageContext: ModelLifecycleStageContext | undefined
    let stageAborted = false
    const baseDriver = driver(log)
    ctx.modelLifecycle.register(admitted, {
      ...baseDriver,
      preflight: async (context) => {
        stageContext = context
        context.signal?.addEventListener('abort', () => { stageAborted = true }, { once: true })
        return await new Promise<never>(() => {})
      },
    })
    const authority = installRouteAuthority(ctx, [admitted])
    const result = ctx.modelLifecycle.acquireRoute({
      sessionId: 'session-1',
      selection: { provider: 'local', model: 'qwen' },
    }).then(lease => lease, (error: unknown) => error)

    await vi.advanceTimersByTimeAsync(0)
    expect(stageContext?.deadlineAt).toBe(Date.now() + 50)
    await vi.advanceTimersByTimeAsync(49)
    expect(stageAborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(await result).toMatchObject({ code: 'STAGE_TIMEOUT' })
    expect(stageAborted).toBe(true)
    expect(authority.records.at(-1)).toMatchObject({
      routeId: 'qwen', outcome: 'REJECTED', errorCode: 'STAGE_TIMEOUT',
    })
    expect(ctx.modelLifecycle.snapshot()).toEqual({ phase: 'IDLE' })
  })

  it('taints the slot instead of racing rollback after a mutating stage times out', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'))
    const ctx = await lifecycle({ stageTimeoutMs: 50 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['r5300'])
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log))
    const glmDriver = driver(log)
    let finishLateStart!: () => void
    ctx.modelLifecycle.register(glm, {
      ...glmDriver,
      start: async (context) => {
        log.push(`start:${context.route.id}:${context.target}`)
        return await new Promise<ModelLifecycleStageReceipt>((resolve) => {
          finishLateStart = () =>{  resolve(stageReceipt('start', context)) }
        })
      },
    })
    const authority = installRouteAuthority(ctx, [qwen, glm])
    const first = await ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })
    await first.release()
    log.length = 0

    const result = ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'glm' },
    }).then(lease => lease, (error: unknown) => error)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(50)

    expect(await result).toMatchObject({ code: 'STAGE_TIMEOUT' })
    expect(ctx.modelLifecycle.snapshot()).toEqual({ phase: 'TAINTED' })
    expect(log).toEqual([
      'preflight:glm:r5300',
      'prestate:glm:r5300',
      'drain:qwen:r5300',
      'stop:qwen:r5300',
      'verify-stopped:qwen:r5300',
      'start:glm:r5300',
    ])
    expect(authority.records.at(-1)).toMatchObject({
      routeId: 'glm', outcome: 'TAINTED', errorCode: 'STAGE_TIMEOUT',
    })

    finishLateStart()
    await flushMicrotasks()
    expect(log).not.toContain('start:qwen:r5300')
    await expect(ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })).rejects.toMatchObject({ code: 'RUNTIME_TAINTED' })
  })

  it('stops and verifies an active route before its registration is removed', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const admitted = route('qwen', 'qwen', ['r5300'])
    const log: string[] = []
    const unregister = ctx.modelLifecycle.register(admitted, driver(log))
    const authority = installRouteAuthority(ctx, [admitted])
    const lease = await ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })
    await lease.release()
    log.length = 0

    await unregister()

    expect(log).toEqual([
      'prestate:qwen:r5300',
      'stop:qwen:r5300',
      'verify-stopped:qwen:r5300',
    ])
    expect(ctx.modelLifecycle.snapshot()).toEqual({ phase: 'IDLE' })
    expect(authority.records.at(-1)).toMatchObject({
      routeId: 'qwen', target: 'r5300', outcome: 'IDLE_UNLOADED',
    })
  })

  it('withdraws a route before waiting for its active shutdown', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const admitted = route('qwen', 'qwen', ['r5300'])
    const log: string[] = []
    let finishVerify!: () => void
    let markVerifyStarted!: () => void
    const verifyStarted = new Promise<void>((resolve) => { markVerifyStarted = resolve })
    const verifyGate = new Promise<void>((resolve) => { finishVerify = resolve })
    const base = driver(log)
    const unregister = ctx.modelLifecycle.register(admitted, {
      ...base,
      verifyStopped: async (context) => {
        log.push(`verify-stopped:${context.route.id}:${context.target}`)
        markVerifyStarted()
        await verifyGate
        return stageReceipt('verify-stopped', context)
      },
    })
    installRouteAuthority(ctx, [admitted])
    const lease = await ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })
    await lease.release()
    log.length = 0

    const disposing = unregister()
    await verifyStarted
    const queued = ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })
    finishVerify()
    await disposing

    await expect(queued).rejects.toMatchObject({ code: 'ROUTE_HELD' })
    expect(log).toEqual([
      'prestate:qwen:r5300',
      'stop:qwen:r5300',
      'verify-stopped:qwen:r5300',
    ])
  })

  it('waits for the inference lease before context shutdown stops the active route', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0 })
    const runtime = ctx.modelLifecycle
    const admitted = route('qwen', 'qwen', ['r5300'])
    const log: string[] = []
    const kinds: string[] = []
    ctx.modelLifecycle.register(admitted, driver(log, {
      observe: (_stage, context) => { kinds.push(context.transactionKind) },
    }))
    installRouteAuthority(ctx, [admitted])
    const lease = await ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })
    log.length = 0

    const disposed = ctx.fiber.dispose()
    await flushMicrotasks()
    expect(log).toEqual([])

    await lease.release()
    kinds.length = 0
    await disposed
    contexts.splice(contexts.indexOf(ctx), 1)

    expect(log).toEqual([
      'prestate:qwen:r5300',
      'stop:qwen:r5300',
      'verify-stopped:qwen:r5300',
    ])
    expect(kinds).toEqual(['SHUTDOWN', 'SHUTDOWN', 'SHUTDOWN'])
    expect(runtime.snapshot()).toEqual({ phase: 'IDLE' })
  })

  it('leaves the GCP resident untouched on shutdown and releases only the app lease', async () => {
    const ctx = await lifecycle({ idleUnloadMs: 0, preserveResidentOnShutdown: true })
    const runtime = ctx.modelLifecycle
    const admitted = route('qwen', 'qwen', ['r5300'])
    const log: string[] = []
    ctx.modelLifecycle.register(admitted, driver(log))
    const authority = installRouteAuthority(ctx, [admitted])
    const lease = await ctx.modelLifecycle.acquireRoute({ selection: admitted.selection })
    await lease.release()
    log.length = 0

    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)

    expect(log).toEqual([])
    expect(simulatedHosts.get(log)?.get('r5300')).toMatchObject({ kind: 'RESIDENT', routeId: 'qwen' })
    expect(runtime.snapshot()).toEqual({ phase: 'IDLE' })
    expect(authority.records.at(-1)?.outcome).toBe('RESIDENT_NOT_STOPPED')
  })

  it('waits for both minimum dwell and post-release idle time before unloading', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'))
    const ctx = await lifecycle({ minimumDwellMs: 1_000, idleUnloadMs: 200 })
    const admitted = route('qwen', 'qwen', ['r5300'])
    const log: string[] = []
    const kinds: string[] = []
    ctx.modelLifecycle.register(admitted, driver(log, {
      observe: (_stage, context) => { kinds.push(context.transactionKind) },
    }))
    const authority = installRouteAuthority(ctx, [admitted])
    const lease = await ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })

    await vi.advanceTimersByTimeAsync(900)
    expect(ctx.modelLifecycle.snapshot().phase).toBe('IN_USE')
    await lease.release()
    log.length = 0
    kinds.length = 0

    await vi.advanceTimersByTimeAsync(99)
    expect(ctx.modelLifecycle.snapshot()).toMatchObject({ phase: 'READY', active: { routeId: 'qwen' } })
    expect(log).toEqual([])

    await vi.advanceTimersByTimeAsync(100)
    expect(ctx.modelLifecycle.snapshot()).toMatchObject({ phase: 'READY', active: { routeId: 'qwen' } })
    expect(log).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(log).toEqual([
      'prestate:qwen:r5300',
      'stop:qwen:r5300',
      'verify-stopped:qwen:r5300',
    ])
    expect(kinds).toEqual(['IDLE_UNLOAD', 'IDLE_UNLOAD', 'IDLE_UNLOAD'])
    expect(ctx.modelLifecycle.snapshot()).toEqual({ phase: 'IDLE' })
    expect(authority.records.at(-1)).toMatchObject({
      routeId: 'qwen', target: 'r5300', outcome: 'IDLE_UNLOADED',
    })
  })

  it('idle-unloads a restored route after a failed switch', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'))
    const ctx = await lifecycle({ minimumDwellMs: 0, idleUnloadMs: 50 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['r5300'])
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log))
    ctx.modelLifecycle.register(glm, driver(log, { failStage: 'start' }))
    const authority = installRouteAuthority(ctx, [qwen, glm])
    const lease = await ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })
    await lease.release()
    await expect(ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'glm' },
    })).rejects.toMatchObject({ code: 'START_FAILED' })
    expect(ctx.modelLifecycle.snapshot()).toMatchObject({
      phase: 'FAILED_ROLLED_BACK', active: { routeId: 'qwen' },
    })
    log.length = 0

    await vi.advanceTimersByTimeAsync(50)
    await flushMicrotasks()

    expect(log).toEqual([
      'prestate:qwen:r5300',
      'stop:qwen:r5300',
      'verify-stopped:qwen:r5300',
    ])
    expect(ctx.modelLifecycle.snapshot()).toEqual({ phase: 'IDLE' })
    expect(authority.records.at(-1)).toMatchObject({ outcome: 'IDLE_UNLOADED', routeId: 'qwen' })
  })

  it('taints idle unload instead of restarting when stopped state remains ambiguous', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'))
    const ctx = await lifecycle({ minimumDwellMs: 0, idleUnloadMs: 50 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    const log: string[] = []
    const baseDriver = driver(log, { failStage: 'stop' })
    ctx.modelLifecycle.register(qwen, {
      ...baseDriver,
      verifyStopped: async (context) => {
        log.push(`verify-stopped:${context.route.id}:${context.target}`)
        throw new Error('host state remains indeterminate')
      },
    })
    const authority = installRouteAuthority(ctx, [qwen])
    const lease = await ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })
    await lease.release()
    log.length = 0

    await vi.advanceTimersByTimeAsync(50)
    await flushMicrotasks()

    expect(log).toEqual([
      'prestate:qwen:r5300',
      'stop:qwen:r5300',
      'verify-stopped:qwen:r5300',
    ])
    expect(log).not.toContain('start:qwen:r5300')
    expect(ctx.modelLifecycle.snapshot()).toEqual({ phase: 'TAINTED' })
    expect(authority.records.at(-1)).toMatchObject({
      outcome: 'TAINTED', routeId: 'qwen', errorCode: 'STOP_FAILED',
    })
  })

  it('re-arms idle unload after a rejected acquisition cancels the previous timer', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'))
    const ctx = await lifecycle({ minimumDwellMs: 0, idleUnloadMs: 100 })
    const qwen = route('qwen', 'qwen', ['r5300'])
    const glm = route('glm', 'glm', ['r5300'])
    const log: string[] = []
    ctx.modelLifecycle.register(qwen, driver(log))
    ctx.modelLifecycle.register(glm, driver(log, { capacity: { r5300: false } }))
    installRouteAuthority(ctx, [qwen, glm])
    const lease = await ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'qwen' },
    })
    await lease.release()
    log.length = 0

    await vi.advanceTimersByTimeAsync(50)
    await expect(ctx.modelLifecycle.acquireRoute({
      selection: { provider: 'local', model: 'glm' },
    })).rejects.toMatchObject({ code: 'NO_CAPACITY' })
    log.length = 0

    await vi.advanceTimersByTimeAsync(99)
    expect(log).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(log).toEqual([
      'prestate:qwen:r5300',
      'stop:qwen:r5300',
      'verify-stopped:qwen:r5300',
    ])
    expect(ctx.modelLifecycle.snapshot()).toEqual({ phase: 'IDLE' })
  })
})
