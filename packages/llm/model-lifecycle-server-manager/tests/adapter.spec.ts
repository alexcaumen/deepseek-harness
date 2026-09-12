import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type {
  GovernedModelRoute,
  ModelExecutionScope,
  ModelLifecycleStageContext,
  ResourceLeaseGrant,
  ResourceLeaseTarget,
} from '@deepseek-ai/dsh-model-lifecycle/src/index.ts'
import {
  ServerManagerAdapterError,
  ServerManagerModelLifecycleAdapter,
  type ServerManagerOperation,
  type ServerManagerTransport,
} from '../src/index.ts'

const bare = (digit: string): string => digit.repeat(64)
const prefixed = (digit: string): string => `sha256:${bare(digit)}`
const ISSUER = `giana:issuer:sha256:${bare('1')}`
const HOLDER = `giana:holder:sha256:${bare('2')}`
const ADMISSION = bare('3')
const LEASE_ID = bare('4')
const FENCING = prefixed('5')

function asciiJsonString(value: string): string {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return asciiJsonString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key =>
    `${asciiJsonString(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function digest(value: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function digestBoundReceipt(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, receiptDigest: `sha256:${digest(body)}` }
}

const TARGETS = {
  r5300: { identityDigest: bare('6'), currentnessDigest: bare('7') },
  prdg: { identityDigest: bare('8'), currentnessDigest: bare('9') },
  'ram-cpu': { identityDigest: bare('a'), currentnessDigest: bare('b') },
} as const

interface Call {
  readonly operation: ServerManagerOperation
  readonly request: Readonly<Record<string, unknown>>
}

class FixtureTransport implements ServerManagerTransport {
  readonly calls: Call[] = []
  now = 1_000_000
  sequence = 0
  preflight: 'AVAILABLE' | 'UNAVAILABLE' = 'AVAILABLE'
  health: 'HEALTHY' | 'UNHEALTHY' = 'HEALTHY'
  corruptNext = false
  duplicateTargetsNext = false
  mutateNextStage: ((receipt: Record<string, unknown>) => void) | undefined
  private transaction: Record<string, unknown> = {}

  async invoke(
    operation: ServerManagerOperation,
    request: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    this.calls.push({ operation, request })
    const targets = operation === 'acquire'
      ? (request.targets as readonly Record<string, unknown>[]).map(target => target.class)
      : ['r5300']
    const descriptors = operation === 'acquire'
      ? [...request.targets as readonly Record<string, unknown>[]]
        .sort((left, right) => String(left.class).localeCompare(String(right.class)))
      : [this.target('r5300')]
    const base: Record<string, unknown> = {
      schema: 'giana.server-manager.resource-lease-receipt.v2',
      state: 'ACQUIRED',
      leaseRef: `giana:lease:sha256:${LEASE_ID}`,
      issuerRef: ISSUER,
      holderRef: HOLDER,
      targets,
      fencingDigest: FENCING,
      expiresAt: this.now + 60_000,
      renewAfterMs: 10_000,
      lease_id: LEASE_ID,
      fence: 1,
      generation: 0,
      coverage_digest: digest({ targets: descriptors }),
      admission_digest: ADMISSION,
      no_secret: true,
    }
    if (operation === 'renew') {
      base.state = 'RENEWED'
      base.expiresAt = this.now + 60_000
    } else if (operation === 'begin') {
      this.transaction = {
        transaction_digest: request.transaction_digest,
        transaction_kind: request.transaction_kind,
        scope_digest: request.scope_digest,
      }
      Object.assign(base, this.transaction, {
        state: 'TRANSACTION_BEGUN',
        state_machine_digest: bare((++this.sequence % 15).toString(16)),
        next_allowed_stages: ['preflight'],
      })
    } else if (operation === 'stage') {
      const stage = String(request.stage)
      const decision = this.decision(stage)
      const unhealthy = (stage === 'health' || stage === 'probe') && decision === 'UNHEALTHY'
      Object.assign(base, this.transaction, {
        state: unhealthy ? 'STAGE_FAILED_RECOVERY_REQUIRED' : 'STAGE_SUCCEEDED',
        route_id: request.route_id,
        target_class: (request.target as Record<string, unknown>).class,
        exact_revision_digest: request.exact_revision_digest,
        state_machine_digest: bare((++this.sequence % 15).toString(16)),
        next_allowed_stages: this.next(stage, decision),
        stage_receipt: {
          stage,
          status: unhealthy ? 'FAIL' : 'PASS',
          decision,
          evidence_digest: bare((++this.sequence % 15).toString(16)),
          error_class: unhealthy ? `${stage.toUpperCase()}_UNHEALTHY` : '',
        },
      })
    } else if (operation === 'cancel-clean') {
      Object.assign(base, this.transaction, {
        state: 'TRANSACTION_CANCELLED_CLEAN',
        state_machine_digest: bare((++this.sequence % 15).toString(16)),
        next_allowed_stages: [],
      })
    } else if (operation === 'release') {
      base.state = request.outcome === 'SETTLED' ? 'RELEASED' : 'QUARANTINED'
    }
    if (this.duplicateTargetsNext) {
      this.duplicateTargetsNext = false
      base.targets = [targets[0], targets[0]]
    }
    if (operation === 'stage') {
      this.mutateNextStage?.(base)
      this.mutateNextStage = undefined
    }
    const receipt = digestBoundReceipt(base)
    if (this.corruptNext) {
      this.corruptNext = false
      return { ...receipt, state: 'CORRUPTED_AFTER_SIGNING' }
    }
    return receipt
  }

  private target(target: ResourceLeaseTarget): Record<string, unknown> {
    return {
      class: target,
      identity_digest: TARGETS[target].identityDigest,
      currentness_digest: TARGETS[target].currentnessDigest,
    }
  }

  private decision(stage: string): string {
    if (stage === 'preflight') return this.preflight
    if (stage === 'prestate') return 'EMPTY'
    if (stage === 'drain') return 'DRAINED'
    if (stage === 'stop') return 'STOPPED'
    if (stage === 'verify-stopped') return 'VERIFIED_STOPPED'
    if (stage === 'start') return 'STARTED'
    if (stage === 'health' || stage === 'probe') return this.health
    throw new Error(`unexpected stage ${stage}`)
  }

  private next(stage: string, decision: string): string[] {
    if (stage === 'preflight') return decision === 'AVAILABLE' ? ['prestate'] : ['preflight']
    if (stage === 'prestate') return ['start']
    if (stage === 'start') return ['health']
    if (stage === 'health') return decision === 'HEALTHY' ? ['probe'] : ['stop']
    if (stage === 'probe') return decision === 'HEALTHY' ? [] : ['stop']
    if (stage === 'stop') return ['verify-stopped']
    if (stage === 'verify-stopped') return []
    return []
  }
}

function adapter(transport: FixtureTransport, key = { value: 0 }): ServerManagerModelLifecycleAdapter {
  return new ServerManagerModelLifecycleAdapter({
    transport,
    targets: TARGETS,
    issuerRef: ISSUER,
    holderRef: HOLDER,
    admissionDigest: ADMISSION,
    leaseTtlMs: 60_000,
    operationTimeoutMs: 30_000,
    maxClockSkewMs: 1_000,
    now: () => transport.now,
    idempotencyKey: () => (++key.value).toString(16).padStart(64, '0'),
  })
}

function route(): GovernedModelRoute {
  return {
    id: 'qwen-local',
    selection: { provider: 'local', model: 'qwen' },
    disposition: 'AVAILABLE',
    admissionReceiptDigest: prefixed('c'),
    revisionDigest: prefixed('d'),
    targets: ['r5300'],
    allowRamCpuOffload: false,
  }
}

function scope(): ModelExecutionScope {
  return {
    workId: 'work-1', principalId: 'principal-1', tenantId: 'tenant-1', sessionId: 'session-1',
    digest: prefixed('e'),
  }
}

function context(grant: ResourceLeaseGrant): ModelLifecycleStageContext {
  return {
    route: route(),
    target: 'r5300',
    scope: scope(),
    transactionKind: 'MODEL_ROUTE',
    transactionDigest: prefixed('f'),
    resourceLease: grant,
    deadlineAt: 1_020_000,
    signal: new AbortController().signal,
  }
}

describe('Server Manager model lifecycle gateway', () => {
  it('validates and normalizes acquire, renew, and settled release', async () => {
    const transport = new FixtureTransport()
    const gateway = adapter(transport)
    const grant = await gateway.acquire({ targets: ['r5300'] }, new AbortController().signal)

    expect(grant).toMatchObject({
      issuerRef: ISSUER,
      holderRef: HOLDER,
      targets: ['r5300'],
      expiresAt: 1_030_000,
      renewAfterMs: 10_000,
    })
    transport.now += 11_000
    const renewed = await gateway.renew(grant, new AbortController().signal)
    expect(renewed.expiresAt).toBe(1_041_000)
    expect(renewed.receiptDigest).not.toBe(grant.receiptDigest)

    await gateway.release(renewed, 'SETTLED', new AbortController().signal)
    expect(transport.calls.map(call => call.operation)).toEqual(['acquire', 'renew', 'release'])
  })

  it('terminally cancels an unavailable-only transaction before settled release', async () => {
    const transport = new FixtureTransport()
    transport.preflight = 'UNAVAILABLE'
    const gateway = adapter(transport)
    const grant = await gateway.acquire({ targets: ['r5300'] }, new AbortController().signal)

    await expect(gateway.preflight(context(grant))).resolves.toEqual({
      ok: false,
      reason: 'Selected compute target is unavailable',
    })
    await gateway.release(grant, 'SETTLED', new AbortController().signal)

    expect(transport.calls.map(call => call.operation)).toEqual([
      'acquire', 'begin', 'stage', 'cancel-clean', 'release',
    ])
    expect(transport.calls.at(-1)?.request.outcome).toBe('SETTLED')
  })

  it('binds successful lifecycle receipts to one transaction and fence', async () => {
    const transport = new FixtureTransport()
    const gateway = adapter(transport)
    const grant = await gateway.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const ctx = context(grant)

    const capacity = await gateway.preflight(ctx)
    const prestate = await gateway.capturePrestate(ctx)
    const started = await gateway.start(ctx)
    const health = await gateway.health(ctx)
    const probe = await gateway.probe(ctx)

    expect(capacity.ok).toBe(true)
    expect(prestate.residency).toEqual({ kind: 'EMPTY' })
    expect(started).toMatchObject({ stage: 'start', fencingDigest: FENCING })
    expect(health.ok).toBe(true)
    expect(probe.ok).toBe(true)
    expect(transport.calls.filter(call => call.operation === 'begin')).toHaveLength(1)
    expect(transport.calls.filter(call => call.operation === 'stage').map(call => call.request.stage))
      .toEqual(['preflight', 'prestate', 'start', 'health', 'probe'])

    await gateway.release(grant, 'SETTLED', new AbortController().signal)
    expect(transport.calls.at(-1)?.request.outcome).toBe('SETTLED')
  })

  it('returns an unhealthy decision for bounded recovery instead of committing ready', async () => {
    const transport = new FixtureTransport()
    const gateway = adapter(transport)
    const grant = await gateway.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const ctx = context(grant)
    await gateway.preflight(ctx)
    await gateway.capturePrestate(ctx)
    await gateway.start(ctx)
    transport.health = 'UNHEALTHY'

    await expect(gateway.health(ctx)).resolves.toEqual({
      ok: false,
      reason: 'health reported unhealthy',
    })
    await expect(gateway.stop(ctx)).resolves.toMatchObject({ stage: 'stop' })
    await expect(gateway.verifyStopped(ctx)).resolves.toMatchObject({ stage: 'verify-stopped' })
    await gateway.release(grant, 'SETTLED', new AbortController().signal)
  })

  it('forwards the exact eviction consent on a fenced stop stage', async () => {
    const transport = new FixtureTransport()
    const gateway = adapter(transport)
    const grant = await gateway.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const consent = {
      id: 'approval-1',
      signature: bare('a'),
      fencing_digest: FENCING,
      scope_digest: scope().digest,
      transaction_digest: prefixed('f'),
      source_route_id: 'qwen-local',
      source_revision_digest: route().revisionDigest,
      source_target: 'r5300' as const,
      destination_route_id: 'glm-local',
      destination_revision_digest: prefixed('b'),
      destination_target: 'prdg' as const,
      source_prestate_digest: prefixed('c'),
      destination_prestate_digest: prefixed('d'),
      expires_at: 1_010_000,
    }
    await gateway.stop({ ...context(grant), evictionConsent: consent })

    const request = transport.calls.find(call => call.operation === 'stage' && call.request.stage === 'stop')?.request
    expect(request?.eviction_consent).toEqual({
      ...consent,
      fencing_digest: bare('5'),
      scope_digest: bare('e'),
      transaction_digest: bare('f'),
      source_revision_digest: bare('d'),
      destination_revision_digest: bare('b'),
      source_prestate_digest: bare('c'),
      destination_prestate_digest: bare('d'),
    })
    expect(request).toMatchObject({ lease_id: LEASE_ID, fence: 1 })
  })

  it('rejects a receipt changed after signing without exposing the wire payload', async () => {
    const transport = new FixtureTransport()
    transport.corruptNext = true
    const gateway = adapter(transport)

    const error = await gateway.acquire({ targets: ['r5300'] }, new AbortController().signal)
      .then(() => undefined, (failure: unknown) => failure)

    expect(error).toBeInstanceOf(ServerManagerAdapterError)
    expect(error).toMatchObject({ code: 'CONTRACT_INVALID' })
    expect(String(error)).not.toContain('CORRUPTED_AFTER_SIGNING')
  })

  it('rejects digest-bound duplicate target coverage that omits an admitted target', async () => {
    const transport = new FixtureTransport()
    transport.duplicateTargetsNext = true
    const gateway = adapter(transport)

    await expect(gateway.acquire({ targets: ['r5300', 'prdg'] }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'CONTRACT_INVALID' })
  })

  it('sanitizes an incomplete identity for a declared target', () => {
    expect(() => new ServerManagerModelLifecycleAdapter({
      transport: new FixtureTransport(),
      targets: { r5300: { identityDigest: TARGETS.r5300.identityDigest } } as unknown as typeof TARGETS,
      issuerRef: ISSUER,
      holderRef: HOLDER,
      admissionDigest: ADMISSION,
      leaseTtlMs: 60_000,
      operationTimeoutMs: 30_000,
      maxClockSkewMs: 1_000,
    })).toThrow(expect.objectContaining({ code: 'CONTRACT_INVALID' }))
  })

  it('accepts R5300-only admission without inventing PRDG or RAM target identities', async () => {
    const transport = new FixtureTransport()
    const gateway = new ServerManagerModelLifecycleAdapter({
      transport, targets: { r5300: TARGETS.r5300 }, issuerRef: ISSUER, holderRef: HOLDER,
      admissionDigest: ADMISSION, leaseTtlMs: 60_000, operationTimeoutMs: 30_000,
      maxClockSkewMs: 1_000, now: () => transport.now,
    })
    await expect(gateway.acquire({ targets: ['prdg'] }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'RESOURCE_LEASE_UNAVAILABLE' })
    expect(transport.calls).toHaveLength(0)
    const lease = await gateway.acquire({ targets: ['r5300'] }, new AbortController().signal)
    expect(lease.targets).toEqual(['r5300'])
    await gateway.release(lease, 'SETTLED', new AbortController().signal)
  })

  it('refuses empty or unknown target coverage', () => {
    for (const targets of [{}, { unknown: TARGETS.r5300 }]) {
      expect(() => new ServerManagerModelLifecycleAdapter({
        transport: new FixtureTransport(), targets: targets as unknown as typeof TARGETS, issuerRef: ISSUER, holderRef: HOLDER,
        admissionDigest: ADMISSION, leaseTtlMs: 60_000, operationTimeoutMs: 30_000, maxClockSkewMs: 1_000,
      })).toThrow(expect.objectContaining({ code: 'CONTRACT_INVALID' }))
    }
  })

  it('rejects a digest-bound stage receipt bound to another target', async () => {
    const transport = new FixtureTransport()
    const gateway = adapter(transport)
    const grant = await gateway.acquire({ targets: ['r5300'] }, new AbortController().signal)
    transport.mutateNextStage = (receipt) => { receipt.target_class = 'prdg' }

    await expect(gateway.preflight(context(grant)))
      .rejects.toMatchObject({ code: 'CONTRACT_INVALID' })
  })

  it('does not open a remote transaction for an aborted or expired stage', async () => {
    const transport = new FixtureTransport()
    const gateway = adapter(transport)
    const grant = await gateway.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const aborted = new AbortController()
    aborted.abort()

    await expect(gateway.preflight({ ...context(grant), signal: aborted.signal }))
      .rejects.toMatchObject({ code: 'TRANSPORT_UNAVAILABLE' })
    await expect(gateway.preflight({ ...context(grant), deadlineAt: transport.now }))
      .rejects.toMatchObject({ code: 'TRANSPORT_UNAVAILABLE' })
    expect(transport.calls.map(call => call.operation)).toEqual(['acquire'])
  })

  it('rejects digest-bound invalid outer state, transition, and failed prestate receipts', async () => {
    const cases: Array<(receipt: Record<string, unknown>) => void> = [
      (receipt) => { receipt.state = 'RELEASED' },
      (receipt) => { receipt.next_allowed_stages = ['not-a-stage'] },
      (receipt) => {
        receipt.state = 'STAGE_FAILED_RECOVERY_REQUIRED'
        receipt.next_allowed_stages = ['stop']
        const stage = receipt.stage_receipt as Record<string, unknown>
        stage.status = 'FAIL'
      },
    ]
    for (const mutate of cases) {
      const transport = new FixtureTransport()
      const gateway = adapter(transport)
      const grant = await gateway.acquire({ targets: ['r5300'] }, new AbortController().signal)
      transport.mutateNextStage = mutate
      const operation = cases.indexOf(mutate) === 2
        ? gateway.capturePrestate(context(grant))
        : gateway.preflight(context(grant))
      await expect(operation).rejects.toBeInstanceOf(ServerManagerAdapterError)
    }
  })

  it('fails closed when the admitted clock-skew bound consumes the lease window', async () => {
    const transport = new FixtureTransport()
    const gateway = new ServerManagerModelLifecycleAdapter({
      transport,
      targets: TARGETS,
      issuerRef: ISSUER,
      holderRef: HOLDER,
      admissionDigest: ADMISSION,
      leaseTtlMs: 60_000,
      operationTimeoutMs: 30_000,
      maxClockSkewMs: 60_000,
      now: () => transport.now,
      idempotencyKey: () => bare('a'),
    })

    await expect(gateway.acquire({ targets: ['r5300'] }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'RESOURCE_LEASE_UNAVAILABLE' })
  })

  it('forwards cancellation to the credential-owning transport', async () => {
    const seen = vi.fn()
    const transport: ServerManagerTransport = {
      invoke: (_operation, _request, signal) => {
        seen(signal)
        return Promise.reject(new Error('offline'))
      },
    }
    const gateway = new ServerManagerModelLifecycleAdapter({
      transport,
      targets: TARGETS,
      issuerRef: ISSUER,
      holderRef: HOLDER,
      admissionDigest: ADMISSION,
      leaseTtlMs: 60_000,
      operationTimeoutMs: 30_000,
      maxClockSkewMs: 1_000,
    })
    const controller = new AbortController()
    controller.abort()

    await expect(gateway.acquire({ targets: ['r5300'] }, controller.signal))
      .rejects.toMatchObject({ code: 'TRANSPORT_UNAVAILABLE' })
    expect(seen).toHaveBeenCalledWith(controller.signal)
  })
})
