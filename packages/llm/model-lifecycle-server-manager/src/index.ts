/**
 * Transport-neutral gateway for the admitted Giana Server Manager lifecycle API.
 * The injected transport owns authentication, endpoint discovery, and secrets.
 * @module @deepseek-ai/dsh-model-lifecycle-server-manager
 */

import { createHash, randomBytes } from 'node:crypto'
import { ServerManagerTransportError } from './stdio-transport.ts'
export { ServerManagerStdioTransport, ServerManagerTransportError } from './stdio-transport.ts'
export type { ServerManagerStdioOptions } from './stdio-transport.ts'
export { installServerManagerLifecycle } from './install.ts'
import {
  ResourceLeaseError,
  ResourceLeaseHolderRef,
  ResourceLeaseIssuerRef,
  ResourceLeaseRef,
  type ModelCapacityDecision,
  type ModelDrainContext,
  type ModelHealthDecision,
  type ModelLifecycleDriver,
  type ModelLifecyclePrestateReceipt,
  type ModelLifecycleStage,
  type ModelLifecycleStageContext,
  type ModelLifecycleStageReceipt,
  ModelLifecycleStageRejectedError,
  type ResourceLeaseGrant,
  type ResourceLeaseProvider,
  type ResourceLeaseTarget,
} from '@deepseek-ai/dsh-model-lifecycle'

const BARE_DIGEST = /^[a-f0-9]{64}$/u
const PREFIXED_DIGEST = /^sha256:[a-f0-9]{64}$/u
const RECEIPT_SCHEMA = 'giana.server-manager.resource-lease-receipt.v2'
const LIFECYCLE_STAGES = new Set<ModelLifecycleStage>([
  'preflight', 'prestate', 'drain', 'stop', 'verify-stopped', 'start', 'health', 'probe',
])

/** Owner API operations. Deployment maps these names to authenticated routes. */
export type ServerManagerOperation =
  | 'acquire'
  | 'expand'
  | 'renew'
  | 'release'
  | 'begin'
  | 'cancel-clean'
  | 'settle-activation'
  | 'stage'

/** Credential-owning transport injected by an admitted deployment. */
export interface ServerManagerTransport {
  /**
   * Invoke one operation. Implementations must keep idempotency keys unchanged
   * across any transport retry and reject unknown-commit outcomes.
   */
  invoke(operation: ServerManagerOperation, request: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown>
}

/** Current owner-issued identity for one physical target class. */
export interface ServerManagerTargetIdentity {
  readonly identityDigest: string
  readonly currentnessDigest: string
}

/** One exact GPU recovery action reported by the resource owner. */
export interface ServerManagerDeviceRecoveryRequirement {
  readonly index: number
  readonly uuid: string
  readonly action: 'Reset'
}

/** Immutable request presented to the deployment's native approval surface. */
export interface ServerManagerDeviceRecoveryRequest {
  readonly context: ModelLifecycleStageContext
  readonly preflightReceipt: ModelLifecycleStageReceipt
  readonly recoveryStateDigest: string
  readonly devices: readonly ServerManagerDeviceRecoveryRequirement[]
}

/** One expiring, exact-device grant minted after an allowed-once decision. */
export interface ServerManagerDeviceRecoveryConsentGrant {
  readonly id: string
  readonly fencing_digest: string
  readonly scope_digest: string
  readonly transaction_digest: string
  readonly route_id: string
  readonly revision_digest: string
  readonly target: ResourceLeaseTarget
  readonly preflight_receipt_digest: string
  readonly recovery_state_digest: string
  readonly devices: readonly ServerManagerDeviceRecoveryRequirement[]
  readonly expires_at: number
  readonly signature: string
}

/** Exact admitted deployment binding; no field is inferred by this gateway. */
export interface ServerManagerAdapterOptions {
  readonly transport: ServerManagerTransport
  readonly targets: Readonly<Partial<Record<ResourceLeaseTarget, ServerManagerTargetIdentity>>>
  readonly issuerRef: string
  readonly holderRef: string
  readonly admissionDigest: string
  readonly leaseTtlMs: number
  readonly operationTimeoutMs: number
  /** Verified maximum absolute clock difference between this client and owner. */
  readonly maxClockSkewMs: number
  readonly now?: () => number
  readonly idempotencyKey?: () => string
  /** Optional native approval bridge for an exact, owner-reported device reset. */
  readonly requestDeviceRecoveryConsent?: (
    request: ServerManagerDeviceRecoveryRequest,
    signal: AbortSignal,
  ) => Promise<ServerManagerDeviceRecoveryConsentGrant | null>
}

interface WireTarget {
  readonly class: ResourceLeaseTarget
  readonly identity_digest: string
  readonly currentness_digest: string
}

interface WireStageReceipt {
  readonly stage: string
  readonly status: string
  readonly decision: string
  readonly evidence_digest: string
  readonly error_class: string
  readonly resident_route_id?: string
  readonly resident_revision_digest?: string
  readonly recovery_state_digest?: string
  readonly recovery_devices?: readonly unknown[]
  readonly failure_detail?: {
    readonly substage: 'HOST_LEASE_ASSERTION' | 'DEVICE_RECOVERY_PRECHECK' | 'DEVICE_RECOVERY_DISPATCH'
    readonly remote_code?: number
    readonly reset_invocation: 'NOT_STARTED' | 'STARTED' | 'UNKNOWN'
  }
}

interface WireReceipt {
  readonly schema: string
  readonly state: string
  readonly leaseRef: string
  readonly issuerRef: string
  readonly holderRef: string
  readonly targets: readonly ResourceLeaseTarget[]
  readonly fencingDigest: string
  readonly receiptDigest: string
  readonly expiresAt: number
  readonly renewAfterMs: number
  readonly lease_id: string
  readonly fence: number
  readonly generation: number
  readonly coverage_digest: string
  readonly admission_digest: string
  readonly no_secret: boolean
  readonly transaction_digest?: string
  readonly transaction_kind?: string
  readonly scope_digest?: string
  readonly state_machine_digest?: string
  readonly transaction_sequence?: number
  readonly activation_settlement?: string
  readonly adopted_resident_route_id?: string
  readonly next_allowed_stages?: readonly string[]
  readonly stage_receipt?: WireStageReceipt
  readonly error_class?: string
  readonly route_id?: string
  readonly target_class?: string
  readonly exact_revision_digest?: string
}

interface LeaseState {
  wire: WireReceipt
  grant: ResourceLeaseGrant
  targetDescriptors: readonly WireTarget[]
  readonly transactions: Map<string, TransactionState>
}

interface TransactionState {
  readonly digest: string
  readonly kind: ModelLifecycleStageContext['transactionKind']
  readonly scopeDigest: string
  readonly begin: Promise<void>
  cleanCancelable: boolean
  terminal: boolean
  lastReceipt?: WireReceipt
  unresolved?: boolean
}

/** Sanitized adapter failure; wire payloads and credential details are omitted. */
export class ServerManagerAdapterError extends Error {
  constructor(readonly code: 'CONTRACT_INVALID' | 'TRANSPORT_UNAVAILABLE' | 'STAGE_REJECTED') {
    super(code === 'CONTRACT_INVALID'
      ? 'Server Manager returned an invalid lifecycle receipt'
      : code === 'TRANSPORT_UNAVAILABLE'
        ? 'Server Manager lifecycle transport is unavailable'
        : 'Server Manager rejected the lifecycle stage')
    this.name = 'ServerManagerAdapterError'
  }
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServerManagerAdapterError('CONTRACT_INVALID')
  }
}

function assertBareDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !BARE_DIGEST.test(value)) {
    throw new ServerManagerAdapterError('CONTRACT_INVALID')
  }
}

function assertPrefixedDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !PREFIXED_DIGEST.test(value)) {
    throw new ServerManagerAdapterError('CONTRACT_INVALID')
  }
}

function bareDigest(value: string): string {
  assertPrefixedDigest(value)
  return value.slice('sha256:'.length)
}

function recoveryDevices(value: unknown): readonly ServerManagerDeviceRecoveryRequirement[] {
  if (!Array.isArray(value) || value.length === 0) throw new ServerManagerAdapterError('CONTRACT_INVALID')
  const devices = value.map((candidate): ServerManagerDeviceRecoveryRequirement => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new ServerManagerAdapterError('CONTRACT_INVALID')
    }
    const input = candidate as Record<string, unknown>
    if (Object.keys(input).some(key => !['index', 'uuid', 'action'].includes(key))
      || typeof input.index !== 'number' || !Number.isSafeInteger(input.index) || input.index < 0
      || typeof input.uuid !== 'string' || !/^GPU-[A-Fa-f0-9-]+$/u.test(input.uuid)
      || input.action !== 'Reset') {
      throw new ServerManagerAdapterError('CONTRACT_INVALID')
    }
    return Object.freeze({ index: input.index, uuid: input.uuid, action: 'Reset' as const })
  })
  if (new Set(devices.map(device => device.index)).size !== devices.length
    || new Set(devices.map(device => device.uuid)).size !== devices.length) {
    throw new ServerManagerAdapterError('CONTRACT_INVALID')
  }
  return Object.freeze([...devices].sort((left, right) => left.index - right.index))
}

function validRecoveryConsent(
  consent: ServerManagerDeviceRecoveryConsentGrant | null,
  context: ModelLifecycleStageContext,
  preflightReceiptDigest: string,
  recoveryStateDigest: string,
  devices: readonly ServerManagerDeviceRecoveryRequirement[],
  now: number,
): consent is ServerManagerDeviceRecoveryConsentGrant {
  if (consent === null) return false
  try {
    assertBareDigest(consent.id)
    assertBareDigest(consent.signature)
    assertPrefixedDigest(consent.fencing_digest)
    assertPrefixedDigest(consent.scope_digest)
    assertPrefixedDigest(consent.transaction_digest)
    assertPrefixedDigest(consent.revision_digest)
    assertPrefixedDigest(consent.preflight_receipt_digest)
    assertPrefixedDigest(consent.recovery_state_digest)
  } catch {
    return false
  }
  return consent.expires_at > now
    && consent.expires_at <= context.resourceLease.expiresAt
    && consent.fencing_digest === context.resourceLease.fencingDigest
    && consent.scope_digest === context.scope.digest
    && consent.transaction_digest === context.transactionDigest
    && consent.route_id === context.route.id
    && consent.revision_digest === context.route.revisionDigest
    && consent.target === context.target
    && consent.preflight_receipt_digest === preflightReceiptDigest
    && consent.recovery_state_digest === recoveryStateDigest
    && JSON.stringify(consent.devices) === JSON.stringify(devices)
}

function prefixedDigest(value: string): string {
  assertBareDigest(value)
  return `sha256:${value}`
}

function asciiJsonString(value: string): string {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return asciiJsonString(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ServerManagerAdapterError('CONTRACT_INVALID')
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  assertRecord(value)
  return `{${Object.keys(value).sort().map(key =>
    `${asciiJsonString(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function canonicalDigest(value: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function verifyReceiptDigest(record: Record<string, unknown>): void {
  const supplied = record.receiptDigest
  assertPrefixedDigest(supplied)
  const body = { ...record }
  delete body.receiptDigest
  if (supplied !== `sha256:${canonicalDigest(body)}`) {
    throw new ServerManagerAdapterError('CONTRACT_INVALID')
  }
}

function finiteInteger(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum
}

function sortedTargets(targets: readonly WireTarget[]): readonly WireTarget[] {
  return [...targets].sort((left, right) => left.class.localeCompare(right.class))
}

function sameTargets(left: readonly ResourceLeaseTarget[], right: readonly ResourceLeaseTarget[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && left.every(target => right.includes(target))
    && right.every(target => left.includes(target))
}

/**
 * One shared adapter implements resource ownership and physical lifecycle
 * mechanics without gaining route, session, policy, or audit authority.
 */
export class ServerManagerModelLifecycleAdapter implements ResourceLeaseProvider, ModelLifecycleDriver {
  private readonly transport: ServerManagerTransport
  private readonly targetIdentities: Readonly<Partial<Record<ResourceLeaseTarget, ServerManagerTargetIdentity>>>
  private readonly issuerRef: string
  private readonly holderRef: string
  private readonly admissionDigest: string
  private readonly leaseTtlMs: number
  private readonly operationTimeoutMs: number
  private readonly maxClockSkewMs: number
  private readonly now: () => number
  private readonly idempotencyKey: () => string
  private readonly requestDeviceRecoveryConsent: ServerManagerAdapterOptions['requestDeviceRecoveryConsent']
  private readonly leases = new Map<string, LeaseState>()

  constructor(options: ServerManagerAdapterOptions) {
    this.transport = options.transport
    this.targetIdentities = Object.freeze(Object.fromEntries(Object.entries(options.targets)
      .map(([target, identity]) => [target, Object.freeze({ ...identity })])))
    this.issuerRef = options.issuerRef
    this.holderRef = options.holderRef
    this.admissionDigest = options.admissionDigest
    this.leaseTtlMs = options.leaseTtlMs
    this.operationTimeoutMs = options.operationTimeoutMs
    this.maxClockSkewMs = options.maxClockSkewMs
    this.now = options.now ?? Date.now
    this.idempotencyKey = options.idempotencyKey ?? (() =>
      createHash('sha256').update(randomBytes(32)).digest('hex'))
    this.requestDeviceRecoveryConsent = options.requestDeviceRecoveryConsent
    assertBareDigest(this.admissionDigest)
    if (!this.issuerRef || !this.holderRef
      || !finiteInteger(this.leaseTtlMs, 2)
      || !finiteInteger(this.operationTimeoutMs, 1)
      || !finiteInteger(this.maxClockSkewMs, 0)) {
      throw new ServerManagerAdapterError('CONTRACT_INVALID')
    }
    const entries = Object.entries(this.targetIdentities)
    if (entries.length === 0) throw new ServerManagerAdapterError('CONTRACT_INVALID')
    for (const [target, identity] of entries) {
      if (!['r5300', 'prdg', 'ram-cpu'].includes(target)) throw new ServerManagerAdapterError('CONTRACT_INVALID')
      assertBareDigest(identity.identityDigest)
      assertBareDigest(identity.currentnessDigest)
    }
  }

  async acquire(request: { targets: readonly ResourceLeaseTarget[] }, signal: AbortSignal): Promise<ResourceLeaseGrant> {
    const classes = [...request.targets]
    if (classes.length === 0 || classes.length > 3 || new Set(classes).size !== classes.length) {
      throw new ResourceLeaseError('RESOURCE_LEASE_UNAVAILABLE')
    }
    const targetDescriptors = sortedTargets(classes.map(target => this.target(target)))
    const startedAt = this.now()
    const receipt = await this.invoke('acquire', {
      idempotency_key: this.key(),
      timeout_ms: this.operationTimeoutMs,
      ttl_ms: this.leaseTtlMs,
      targets: targetDescriptors,
    }, signal)
    this.validateLeaseReceipt(receipt, 'ACQUIRED', classes, targetDescriptors)
    const grant = this.toGrant(receipt, startedAt, undefined)
    if (this.leases.has(grant.leaseRef)) throw new ResourceLeaseError('RESOURCE_LEASE_UNAVAILABLE')
    this.leases.set(grant.leaseRef, {
      wire: receipt,
      grant,
      targetDescriptors,
      transactions: new Map(),
    })
    return grant
  }

  async expand(
    grant: ResourceLeaseGrant,
    request: { targets: readonly ResourceLeaseTarget[] },
    signal: AbortSignal,
  ): Promise<ResourceLeaseGrant> {
    const state = this.lease(grant)
    const classes = [...request.targets]
    if (classes.length === 0 || classes.length > 3 || new Set(classes).size !== classes.length
      || !grant.targets.every(target => classes.includes(target))) {
      throw new ResourceLeaseError('RESOURCE_LEASE_LOST')
    }
    const targetDescriptors = sortedTargets(classes.map(target => this.target(target)))
    const startedAt = this.now()
    const receipt = await this.invoke('expand', {
      ...this.boundRequest(state),
      idempotency_key: this.key(),
      timeout_ms: this.operationTimeoutMs,
      ttl_ms: this.leaseTtlMs,
      targets: targetDescriptors,
    }, signal)
    this.validateLeaseReceipt(receipt, 'EXPANDED', classes, targetDescriptors, state.wire)
    const expanded = this.toGrant(receipt, startedAt, grant)
    state.wire = receipt
    state.grant = expanded
    state.targetDescriptors = targetDescriptors
    return expanded
  }

  async renew(grant: ResourceLeaseGrant, signal: AbortSignal): Promise<ResourceLeaseGrant> {
    const state = this.lease(grant)
    const startedAt = this.now()
    const receipt = await this.invoke('renew', {
      ...this.boundRequest(state),
      idempotency_key: this.key(),
      timeout_ms: this.operationTimeoutMs,
      ttl_ms: this.leaseTtlMs,
    }, signal)
    this.validateLeaseReceipt(receipt, 'RENEWED', grant.targets, state.targetDescriptors, state.wire)
    const renewed = this.toGrant(receipt, startedAt, grant)
    state.wire = receipt
    state.grant = renewed
    return renewed
  }

  async release(
    grant: ResourceLeaseGrant,
    outcome: 'SETTLED' | 'UNCERTAIN',
    signal: AbortSignal,
  ): Promise<void> {
    const state = this.lease(grant)
    let releaseOutcome = outcome
    if (outcome === 'SETTLED') {
      const active = [...state.transactions.values()].filter(transaction => !transaction.terminal)
      for (const transaction of active) {
        await transaction.begin
        if (!transaction.cleanCancelable) {
          releaseOutcome = 'UNCERTAIN'
          break
        }
        const cancelled = await this.invoke('cancel-clean', {
          ...this.boundRequest(state),
          idempotency_key: this.key(),
          timeout_ms: this.operationTimeoutMs,
          transaction_digest: transaction.digest,
          cancellation_generation: state.wire.generation,
        }, signal)
        this.validateTransactionReceipt(cancelled, state, transaction, 'TRANSACTION_CANCELLED_CLEAN')
        state.wire = cancelled
        transaction.terminal = true
      }
    }
    const receipt = await this.invoke('release', {
      ...this.boundRequest(state),
      idempotency_key: this.key(),
      timeout_ms: this.operationTimeoutMs,
      outcome: releaseOutcome,
    }, signal)
    this.validateLeaseReceipt(
      receipt,
      releaseOutcome === 'SETTLED' ? 'RELEASED' : 'QUARANTINED',
      grant.targets,
      state.targetDescriptors,
      state.wire,
    )
    this.leases.delete(grant.leaseRef)
  }

  async cancelPreparation(context: ModelLifecycleStageContext): Promise<void> {
    const state = this.lease(context.resourceLease)
    const transaction = state.transactions.get(bareDigest(context.transactionDigest))
    if (transaction === undefined) return
    if (transaction.scopeDigest !== bareDigest(context.scope.digest)
      || transaction.kind !== context.transactionKind) {
      throw new ServerManagerAdapterError('CONTRACT_INVALID')
    }
    await transaction.begin
    if (transaction.terminal) return
    if (transaction.lastReceipt?.activation_settlement === 'AWAITING_PUBLICATION'
      && transaction.lastReceipt.adopted_resident_route_id === context.route.id) {
      await this.settleActivation(context, 'COMPENSATE')
      return
    }
    if (!transaction.cleanCancelable) throw new ServerManagerAdapterError('CONTRACT_INVALID')
    const timeoutMs = Math.floor(context.deadlineAt - this.now())
    if (timeoutMs < 1 || context.signal.aborted) throw new ServerManagerAdapterError('TRANSPORT_UNAVAILABLE')
    const receipt = await this.invoke('cancel-clean', {
      ...this.boundRequest(state),
      idempotency_key: this.key(),
      timeout_ms: Math.min(timeoutMs, this.operationTimeoutMs),
      transaction_digest: transaction.digest,
      cancellation_generation: state.wire.generation,
    }, context.signal)
    this.validateTransactionReceipt(receipt, state, transaction, 'TRANSACTION_CANCELLED_CLEAN')
    state.wire = receipt
    transaction.terminal = true
  }

  async settleActivation(context: ModelLifecycleStageContext, disposition: 'COMMIT' | 'COMPENSATE'): Promise<void> {
    const state = this.lease(context.resourceLease)
    const transaction = state.transactions.get(bareDigest(context.transactionDigest))
    if (transaction === undefined || transaction.scopeDigest !== bareDigest(context.scope.digest)
      || transaction.kind !== context.transactionKind) throw new ServerManagerAdapterError('CONTRACT_INVALID')
    await transaction.begin
    const sequence = transaction.lastReceipt?.transaction_sequence
    if (transaction.unresolved || transaction.terminal || !finiteInteger(sequence, 1)) {
      throw new ServerManagerAdapterError('CONTRACT_INVALID')
    }
    const timeoutMs = Math.floor(context.deadlineAt - this.now())
    if (timeoutMs < 1 || context.signal.aborted) throw new ServerManagerAdapterError('TRANSPORT_UNAVAILABLE')
    transaction.unresolved = true
    const receipt = await this.invoke('settle-activation', {
      ...this.boundRequest(state), idempotency_key: this.key(),
      timeout_ms: Math.min(timeoutMs, this.operationTimeoutMs),
      transaction_digest: transaction.digest, scope_digest: transaction.scopeDigest,
      expected_sequence: sequence, disposition,
      route_id: context.route.id, exact_revision_digest: bareDigest(context.route.revisionDigest),
      target: this.target(context.target),
    }, context.signal)
    this.validateTransactionReceipt(receipt, state, transaction,
      disposition === 'COMMIT' ? 'ACTIVATION_COMMITTED' : 'COMPENSATION_AUTHORIZED')
    if (receipt.transaction_sequence !== sequence + 1
      || (disposition === 'COMMIT' ? receipt.activation_settlement !== 'COMMITTED'
        : receipt.activation_settlement !== 'COMPENSATING' && receipt.activation_settlement !== 'ACTIVE')) {
      throw new ServerManagerAdapterError('CONTRACT_INVALID')
    }
    transaction.lastReceipt = receipt
    transaction.terminal = receipt.next_allowed_stages?.length === 0
      && receipt.activation_settlement !== 'AWAITING_PUBLICATION'
    transaction.unresolved = false
    state.wire = receipt
  }

  capturePrestate(context: ModelLifecycleStageContext): Promise<ModelLifecyclePrestateReceipt> {
    return this.stage(context, 'prestate').then(({ wire, receipt }) => {
      const stage = wire.stage_receipt
      if (stage === undefined) throw new ServerManagerAdapterError('CONTRACT_INVALID')
      if (stage.status !== 'PASS') throw new ServerManagerAdapterError('STAGE_REJECTED')
      const decision = stage.decision
      const residency = decision === 'EMPTY'
        ? { kind: 'EMPTY' as const }
        : decision === 'UNKNOWN'
          ? { kind: 'UNKNOWN' as const }
          : decision === 'RESIDENT'
            ? {
              kind: 'RESIDENT' as const,
              routeId: this.nonempty(stage.resident_route_id),
              revisionDigest: prefixedDigest(this.digest(stage.resident_revision_digest)),
            }
            : undefined
      if (residency === undefined) throw new ServerManagerAdapterError('CONTRACT_INVALID')
      return Object.freeze({ ...receipt, residency })
    })
  }

  async preflight(context: ModelLifecycleStageContext): Promise<ModelCapacityDecision> {
    const first = await this.stage(context, 'preflight')
    const stage = first.wire.stage_receipt
    if (stage?.status === 'PASS' && stage.decision === 'AVAILABLE') return { ok: true, receipt: first.receipt }
    if (stage?.status === 'PASS' && stage.decision === 'UNAVAILABLE') {
      return { ok: false, reason: 'Selected compute target is unavailable' }
    }
    if (stage?.status !== 'PASS' || stage.decision !== 'RECOVERY_REQUIRED') {
      throw new ServerManagerAdapterError('STAGE_REJECTED')
    }
    const recoveryStateDigest = prefixedDigest(this.digest(stage.recovery_state_digest))
    const devices = recoveryDevices(stage.recovery_devices)
    const requestConsent = this.requestDeviceRecoveryConsent
    if (requestConsent === undefined) {
      return { ok: false, reason: 'Selected compute target requires an approved device reset' }
    }
    const consent = await requestConsent({
      context,
      preflightReceipt: first.receipt,
      recoveryStateDigest,
      devices,
    }, context.signal)
    if (!validRecoveryConsent(consent, context, first.receipt.digest, recoveryStateDigest, devices, this.now())) {
      return { ok: false, reason: 'Selected compute target device reset was not approved' }
    }
    const recovered = await this.stage(context, 'preflight', consent)
    if (recovered.wire.stage_receipt?.status === 'PASS'
      && recovered.wire.stage_receipt.decision === 'AVAILABLE') {
      return { ok: true, receipt: recovered.receipt }
    }
    if (recovered.wire.stage_receipt?.status === 'PASS'
      && recovered.wire.stage_receipt.decision === 'UNAVAILABLE') {
      return { ok: false, reason: 'Selected compute target remains unavailable after device reset' }
    }
    throw new ServerManagerAdapterError('STAGE_REJECTED')
  }

  drain(context: ModelDrainContext): Promise<ModelLifecycleStageReceipt> {
    return this.simpleStage(context, 'drain', 'DRAINED')
  }

  stop(context: ModelLifecycleStageContext): Promise<ModelLifecycleStageReceipt> {
    return this.simpleStage(context, 'stop', 'STOPPED')
  }

  verifyStopped(context: ModelLifecycleStageContext): Promise<ModelLifecycleStageReceipt> {
    return this.simpleStage(context, 'verify-stopped', 'VERIFIED_STOPPED')
  }

  start(context: ModelLifecycleStageContext): Promise<ModelLifecycleStageReceipt> {
    return this.simpleStage(context, 'start', 'STARTED')
  }

  health(context: ModelLifecycleStageContext): Promise<ModelHealthDecision> {
    return this.healthStage(context, 'health')
  }

  probe(context: ModelLifecycleStageContext): Promise<ModelHealthDecision> {
    return this.healthStage(context, 'probe')
  }

  private async healthStage(
    context: ModelLifecycleStageContext,
    stage: 'health' | 'probe',
  ): Promise<ModelHealthDecision> {
    const result = await this.stage(context, stage)
    const wire = result.wire.stage_receipt
    if (wire?.status === 'PASS' && wire.decision === 'HEALTHY') return { ok: true, receipt: result.receipt }
    if (wire?.status === 'FAIL' && wire.decision === 'UNHEALTHY') {
      return { ok: false, reason: `${stage} reported unhealthy` }
    }
    throw new ServerManagerAdapterError('STAGE_REJECTED')
  }

  private async simpleStage(
    context: ModelLifecycleStageContext,
    stage: ModelLifecycleStage,
    decision: string,
  ): Promise<ModelLifecycleStageReceipt> {
    const result = await this.stage(context, stage)
    const rejected = result.wire.stage_receipt
    if (stage === 'stop'
      && rejected?.status === 'FAIL'
      && rejected.decision === 'SOURCE_RESTORED'
      && rejected.error_class === 'MODEL_STAGE_NOT_APPLIED_SOURCE_RESTORED'
      && result.wire.next_allowed_stages?.length === 0) {
      throw new ModelLifecycleStageRejectedError('stop', 'NO_MUTATION_SOURCE_RESTORED')
    }
    if (result.wire.stage_receipt?.status !== 'PASS' || result.wire.stage_receipt.decision !== decision) {
      throw new ServerManagerAdapterError('STAGE_REJECTED')
    }
    return result.receipt
  }

  private async stage(
    context: ModelLifecycleStageContext,
    stage: ModelLifecycleStage,
    deviceRecoveryConsent?: ServerManagerDeviceRecoveryConsentGrant,
  ): Promise<{ wire: WireReceipt; receipt: ModelLifecycleStageReceipt }> {
    const timeoutMs = Math.floor(context.deadlineAt - this.now())
    if (timeoutMs < 1 || context.signal.aborted) {
      throw new ServerManagerAdapterError('TRANSPORT_UNAVAILABLE')
    }
    const state = this.lease(context.resourceLease)
    const transaction = await this.transaction(state, context)
    if (transaction.unresolved) throw new ServerManagerAdapterError('CONTRACT_INVALID')
    transaction.unresolved = true
    if (stage !== 'preflight' && stage !== 'prestate' || deviceRecoveryConsent !== undefined) {
      transaction.cleanCancelable = false
    }
    const wire = await this.invoke('stage', {
      ...this.boundRequest(state),
      idempotency_key: this.key(),
      timeout_ms: Math.min(timeoutMs, this.operationTimeoutMs),
      deadline_at: Math.floor(context.deadlineAt),
      transaction_digest: transaction.digest,
      cancellation_generation: state.wire.generation,
      target: this.target(context.target),
      stage,
      route_id: context.route.id,
      exact_revision_digest: bareDigest(context.route.revisionDigest),
      ...(stage === 'stop' && context.evictionConsent !== undefined
        ? { eviction_consent: {
          ...context.evictionConsent,
          scope_digest: bareDigest(context.evictionConsent.scope_digest),
          transaction_digest: bareDigest(context.evictionConsent.transaction_digest),
          fencing_digest: bareDigest(context.evictionConsent.fencing_digest),
          source_revision_digest: bareDigest(context.evictionConsent.source_revision_digest),
          destination_revision_digest: bareDigest(context.evictionConsent.destination_revision_digest),
          source_prestate_digest: bareDigest(context.evictionConsent.source_prestate_digest),
          destination_prestate_digest: bareDigest(context.evictionConsent.destination_prestate_digest),
        } }
        : {}),
      ...(stage === 'preflight' && deviceRecoveryConsent !== undefined
        ? { device_recovery_consent: {
          ...deviceRecoveryConsent,
          fencing_digest: bareDigest(deviceRecoveryConsent.fencing_digest),
          scope_digest: bareDigest(deviceRecoveryConsent.scope_digest),
          transaction_digest: bareDigest(deviceRecoveryConsent.transaction_digest),
          revision_digest: bareDigest(deviceRecoveryConsent.revision_digest),
          preflight_receipt_digest: bareDigest(deviceRecoveryConsent.preflight_receipt_digest),
          recovery_state_digest: bareDigest(deviceRecoveryConsent.recovery_state_digest),
        } }
        : {}),
    }, context.signal)
    this.validateStageReceipt(wire, state, transaction, context, stage)
    const stageReceipt = wire.stage_receipt
    if (stageReceipt === undefined) throw new ServerManagerAdapterError('CONTRACT_INVALID')
    transaction.cleanCancelable = transaction.cleanCancelable
      && (stage === 'preflight' || stage === 'prestate')
      && stageReceipt.status === 'PASS'
    transaction.terminal = Array.isArray(wire.next_allowed_stages) && wire.next_allowed_stages.length === 0
      && wire.activation_settlement !== 'AWAITING_PUBLICATION'
    transaction.lastReceipt = wire
    transaction.unresolved = false
    state.wire = wire
    return {
      wire,
      receipt: Object.freeze({
        stage,
        routeId: context.route.id,
        target: context.target,
        revisionDigest: context.route.revisionDigest,
        scopeDigest: context.scope.digest,
        transactionDigest: context.transactionDigest,
        fencingDigest: context.resourceLease.fencingDigest,
        digest: wire.receiptDigest,
      }),
    }
  }

  private async transaction(state: LeaseState, context: ModelLifecycleStageContext): Promise<TransactionState> {
    const digest = bareDigest(context.transactionDigest)
    const scopeDigest = bareDigest(context.scope.digest)
    const existing = state.transactions.get(digest)
    if (existing !== undefined) {
      if (existing.kind !== context.transactionKind || existing.scopeDigest !== scopeDigest) {
        throw new ServerManagerAdapterError('CONTRACT_INVALID')
      }
      await existing.begin
      return existing
    }
    const transaction = {} as TransactionState
    const begin = this.invoke('begin', {
      ...this.boundRequest(state),
      idempotency_key: this.key(),
      timeout_ms: Math.min(this.operationTimeoutMs, Math.max(1, Math.floor(context.deadlineAt - this.now()))),
      transaction_digest: digest,
      transaction_kind: context.transactionKind,
      scope_digest: scopeDigest,
      cancellation_generation: state.wire.generation,
    }, context.signal).then((receipt) => {
      this.validateTransactionReceipt(receipt, state, transaction, 'TRANSACTION_BEGUN')
      state.wire = receipt
    })
    Object.assign(transaction, {
      digest,
      kind: context.transactionKind,
      scopeDigest,
      begin,
      cleanCancelable: true,
      terminal: false,
    })
    state.transactions.set(digest, transaction)
    // A lost begin reply may have left a durable host transaction. Retain its
    // rejected promise so cleanup cannot mistake it for an undispatched request.
    await begin
    return transaction
  }

  private async invoke(
    operation: ServerManagerOperation,
    request: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<WireReceipt> {
    try {
      const value = await this.transport.invoke(operation, Object.freeze(request), signal)
      assertRecord(value)
      verifyReceiptDigest(value)
      return value as unknown as WireReceipt
    } catch (error: unknown) {
      if (error instanceof ServerManagerAdapterError || error instanceof ResourceLeaseError) throw error
      if ((operation === 'acquire' || operation === 'expand') && error instanceof ServerManagerTransportError
        && error.code === 'TARGET_UNAVAILABLE') {
        throw new ResourceLeaseError('RESOURCE_TARGET_UNAVAILABLE')
      }
      throw new ServerManagerAdapterError('TRANSPORT_UNAVAILABLE')
    }
  }

  private validateLeaseReceipt(
    receipt: WireReceipt,
    expectedState: string,
    targets: readonly ResourceLeaseTarget[],
    targetDescriptors: readonly WireTarget[],
    previous?: WireReceipt,
  ): void {
    if (receipt.schema !== RECEIPT_SCHEMA || receipt.state !== expectedState
      || receipt.issuerRef !== this.issuerRef || receipt.holderRef !== this.holderRef
      || receipt.admission_digest !== this.admissionDigest || !receipt.no_secret
      || !Array.isArray(receipt.targets) || !sameTargets(receipt.targets, targets)
      || receipt.coverage_digest !== canonicalDigest({ targets: sortedTargets(targetDescriptors) })
      || !finiteInteger(receipt.expiresAt, 1) || !finiteInteger(receipt.renewAfterMs, 1)
      || !finiteInteger(receipt.fence, 1) || !finiteInteger(receipt.generation, 0)) {
      throw new ServerManagerAdapterError('CONTRACT_INVALID')
    }
    assertBareDigest(receipt.lease_id)
    assertBareDigest(receipt.coverage_digest)
    assertBareDigest(receipt.admission_digest)
    assertPrefixedDigest(receipt.fencingDigest)
    assertPrefixedDigest(receipt.receiptDigest)
    if (!receipt.leaseRef || (previous !== undefined && (
      receipt.leaseRef !== previous.leaseRef
      || receipt.lease_id !== previous.lease_id
      || receipt.fence !== previous.fence
      || receipt.generation !== previous.generation
      || receipt.fencingDigest !== previous.fencingDigest
      || receipt.receiptDigest === previous.receiptDigest
    ))) throw new ServerManagerAdapterError('CONTRACT_INVALID')
  }

  private validateTransactionReceipt(
    receipt: WireReceipt,
    state: LeaseState,
    transaction: TransactionState,
    expectedState?: string,
  ): void {
    this.validateLeaseReceipt(receipt, expectedState ?? receipt.state, state.grant.targets, state.targetDescriptors, state.wire)
    const nextStages = receipt.next_allowed_stages
    if (receipt.transaction_digest !== transaction.digest
      || receipt.transaction_kind !== transaction.kind
      || receipt.scope_digest !== transaction.scopeDigest
      || !Array.isArray(nextStages)
      || new Set(nextStages).size !== nextStages.length
      || !nextStages.every(value => typeof value === 'string' && LIFECYCLE_STAGES.has(value as ModelLifecycleStage))) {
      throw new ServerManagerAdapterError('CONTRACT_INVALID')
    }
    assertBareDigest(receipt.transaction_digest)
    assertBareDigest(receipt.scope_digest)
    assertBareDigest(receipt.state_machine_digest)
    if (receipt.stage_receipt !== undefined) {
      assertBareDigest(receipt.stage_receipt.evidence_digest)
      if (typeof receipt.stage_receipt.error_class !== 'string') {
        throw new ServerManagerAdapterError('CONTRACT_INVALID')
      }
      const detail = receipt.stage_receipt.failure_detail
      if (detail !== undefined
        && (!['HOST_LEASE_ASSERTION', 'DEVICE_RECOVERY_PRECHECK', 'DEVICE_RECOVERY_DISPATCH'].includes(detail.substage)
          || !['NOT_STARTED', 'STARTED', 'UNKNOWN'].includes(detail.reset_invocation)
          || (detail.remote_code !== undefined
            && (!Number.isSafeInteger(detail.remote_code) || detail.remote_code < 0 || detail.remote_code > 255)))) {
        throw new ServerManagerAdapterError('CONTRACT_INVALID')
      }
    }
  }

  private validateStageReceipt(
    receipt: WireReceipt,
    state: LeaseState,
    transaction: TransactionState,
    context: ModelLifecycleStageContext,
    stage: ModelLifecycleStage,
  ): void {
    this.validateTransactionReceipt(receipt, state, transaction)
    const stageReceipt = receipt.stage_receipt
    const nextStages = receipt.next_allowed_stages
    if (stageReceipt === undefined || nextStages === undefined
      || stageReceipt.stage !== stage
      || receipt.route_id !== context.route.id
      || receipt.target_class !== context.target
      || receipt.exact_revision_digest !== bareDigest(context.route.revisionDigest)
      || !['PASS', 'FAIL', 'QUARANTINED'].includes(stageReceipt.status)) {
      throw new ServerManagerAdapterError('CONTRACT_INVALID')
    }
    const expectedState = stageReceipt.status === 'PASS'
      ? 'STAGE_SUCCEEDED'
      : nextStages.length > 0 ? 'STAGE_FAILED_RECOVERY_REQUIRED' : 'FAILED_FINAL'
    if (receipt.state !== expectedState) throw new ServerManagerAdapterError('CONTRACT_INVALID')
  }

  private toGrant(receipt: WireReceipt, startedAt: number, previous: ResourceLeaseGrant | undefined): ResourceLeaseGrant {
    const expiresAt = receipt.expiresAt - this.maxClockSkewMs
    const conservativeDeadline = Math.min(expiresAt, startedAt + this.leaseTtlMs, startedAt + this.operationTimeoutMs)
    const remaining = conservativeDeadline - this.now()
    if (!finiteInteger(conservativeDeadline, 1) || remaining <= 1
      || receipt.renewAfterMs >= remaining
      || (previous !== undefined && conservativeDeadline <= previous.expiresAt)) {
      throw new ResourceLeaseError(previous === undefined ? 'RESOURCE_LEASE_UNAVAILABLE' : 'RESOURCE_LEASE_LOST')
    }
    return Object.freeze({
      leaseRef: ResourceLeaseRef(receipt.leaseRef),
      issuerRef: ResourceLeaseIssuerRef(receipt.issuerRef),
      holderRef: ResourceLeaseHolderRef(receipt.holderRef),
      targets: Object.freeze([...receipt.targets]),
      fencingDigest: receipt.fencingDigest,
      receiptDigest: receipt.receiptDigest,
      expiresAt: conservativeDeadline,
      renewAfterMs: receipt.renewAfterMs,
    })
  }

  private lease(grant: ResourceLeaseGrant): LeaseState {
    const state = this.leases.get(grant.leaseRef)
    if (state === undefined
      || state.grant.receiptDigest !== grant.receiptDigest
      || state.grant.fencingDigest !== grant.fencingDigest
      || !sameTargets(state.grant.targets, grant.targets)) {
      throw new ResourceLeaseError('RESOURCE_LEASE_LOST')
    }
    return state
  }

  private target(target: ResourceLeaseTarget): WireTarget {
    const identity = this.targetIdentities[target]
    if (identity === undefined) throw new ResourceLeaseError('RESOURCE_LEASE_UNAVAILABLE')
    return Object.freeze({
      class: target,
      identity_digest: identity.identityDigest,
      currentness_digest: identity.currentnessDigest,
    })
  }

  private boundRequest(state: LeaseState): Record<string, unknown> {
    return { lease_id: state.wire.lease_id, fence: state.wire.fence }
  }

  private key(): string {
    const key = this.idempotencyKey()
    assertBareDigest(key)
    return key
  }

  private digest(value: unknown): string {
    assertBareDigest(value)
    return value
  }

  private nonempty(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ServerManagerAdapterError('CONTRACT_INVALID')
    }
    return value
  }
}
