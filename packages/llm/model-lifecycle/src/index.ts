/**
 * Provider-neutral execution boundary for governed local-model inference.
 *
 * The runtime owns one large-model slot while the LLM service remains the sole
 * provider/model selection authority. Host-specific
 * launch, resource inspection, and health mechanics remain behind registered
 * drivers; no speech endpoint, filesystem path, or credential enters this
 * capability seam.
 * @module @deepseek-ai/dsh-model-lifecycle
 */

import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { ResourceLeaseError, ResourceLeaseSession, type ResourceLeaseGrant, type ResourceLeaseProvider } from './resource-lease.ts'

export { ResourceLeaseError, ResourceLeaseSession, ResourceLeaseRef, ResourceLeaseIssuerRef, ResourceLeaseHolderRef } from './resource-lease.ts'
export type { ResourceLeaseGrant, ResourceLeaseOperationObserver, ResourceLeaseProvider, ResourceLeaseTarget } from './resource-lease.ts'

/** Settings namespace shared with the browser preference mirror. */
export const MODEL_LIFECYCLE_SETTINGS_NAMESPACE = 'model-lifecycle'

/** Persisted user choices accepted by the local-model controller. */
export const MODEL_COMPUTE_PREFERENCES = ['automatic', 'r5300', 'prdg'] as const

/** Scalar settings field carrying the local-model routing choice. */
export const MODEL_COMPUTE_PREFERENCE_FIELD = 'preference'

/** User-visible routing intent for a governed local model. */
export type ModelComputePreference = typeof MODEL_COMPUTE_PREFERENCES[number]

/** Durable local-model routing preference. */
export interface ModelLifecycleConfig {
  /** Preferred compute target; Automatic performs the admitted fallback order. */
  readonly preference?: ModelComputePreference
  /** Minimum time an activated model remains resident before an idle unload. */
  readonly minimumDwellMs?: number
  /** Idle time after the last inference lease before unloading; zero disables it. */
  readonly idleUnloadMs?: number
  /** Maximum duration of one host-driver stage before it is cancelled. */
  readonly stageTimeoutMs?: number
  /** Maximum queued inference requests, excluding the current lease. */
  readonly maxPendingRequests?: number
  /** Maximum wait for the inference slot, separate from host-stage deadlines. */
  readonly queueTimeoutMs?: number
}

interface ResolvedModelLifecycleConfig {
  readonly preference: ModelComputePreference
  readonly minimumDwellMs: number
  readonly idleUnloadMs: number
  readonly stageTimeoutMs: number
  readonly maxPendingRequests: number
  readonly queueTimeoutMs: number
}

/** Loader and Settings schema for the provider-neutral lifecycle controller. */
export const Config: z<ModelLifecycleConfig> = z.object({
  preference: z.union([...MODEL_COMPUTE_PREFERENCES]).default('automatic'),
  minimumDwellMs: z.number().min(0).default(30_000),
  idleUnloadMs: z.number().min(0).default(300_000),
  stageTimeoutMs: z.number().min(1).default(120_000),
  maxPendingRequests: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(32),
  queueTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(120_000),
})

const SETTINGS_NAMESPACE = settingsNamespace(MODEL_LIFECYCLE_SETTINGS_NAMESPACE)

/** Exact execution target selected after capacity admission. */
export type ModelComputeTarget = 'r5300' | 'prdg' | 'ram-cpu'

/** Admission state projected from a current external receipt. */
export type ModelRouteDisposition = 'HIDDEN_HELD' | 'VISIBLE_DISABLED' | 'AVAILABLE'

/** Stable error codes returned without silently selecting another inference route. */
export type ModelLifecycleErrorCode =
  | 'ROUTE_HELD'
  | 'GOVERNANCE_UNAVAILABLE'
  | 'SCOPE_INVALID'
  | 'REASONING_UNSUPPORTED'
  | 'MANUAL_TARGET_UNAVAILABLE'
  | 'NO_CAPACITY'
  | 'PREFLIGHT_FAILED'
  | 'DRAIN_FAILED'
  | 'STOP_FAILED'
  | 'START_FAILED'
  | 'HEALTH_FAILED'
  | 'ROLLBACK_FAILED'
  | 'AUDIT_FAILED'
  | 'STAGE_TIMEOUT'
  | 'RUNTIME_TAINTED'
  | 'RESIDENCY_UNVERIFIED'
  | 'RESOURCE_LEASE_UNAVAILABLE'
  | 'RESOURCE_LEASE_LOST'
  | 'QUEUE_FULL'
  | 'QUEUE_TIMEOUT'
  | 'SESSION_PUBLICATION_FAILED'
  | 'ABORTED'

/** Complete provider/model pair. Provider and model are never updated independently. */
export interface ModelSelectionIdentity {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Immutable route data admitted by an external authority. */
export interface GovernedModelRoute {
  readonly id: string
  readonly selection: ModelSelectionIdentity
  readonly disposition: ModelRouteDisposition
  readonly admissionReceiptDigest: string
  readonly revisionDigest: string
  readonly targets: readonly ModelComputeTarget[]
  readonly allowRamCpuOffload: boolean
  readonly supportedReasoningEfforts?: readonly string[]
  /** Authority-admitted per-stage deadlines; omitted stages use the runtime setting. */
  readonly stageTimeoutsMs?: Readonly<Partial<Record<ModelLifecycleStage, number>>>
}

/** Per-work execution identity resolved by the external governance authority. */
export interface ModelExecutionScope {
  readonly workId: string
  readonly principalId: string
  readonly tenantId: string
  readonly sessionId: string
  readonly digest: string
}

/** Authority result. Governed and held routes never fall through as ordinary providers. */
export type ModelRouteResolution =
  | { readonly kind: 'UNMANAGED_EXTERNAL' }
  | { readonly kind: 'HELD'; readonly routeId: string; readonly reason: string }
  | { readonly kind: 'GOVERNED'; readonly route: GovernedModelRoute; readonly scope: ModelExecutionScope }

/** Coarse provider classification used before entering the serialized local-model queue. */
export type ModelProviderClassification = 'UNMANAGED_EXTERNAL' | 'GOVERNED_LOCAL'

/** Sanitized lifecycle outcome suitable for a canonical persistence adapter. */
export interface ModelLifecycleAuditRecord {
  readonly transactionDigest: string
  readonly scopeDigest: string
  readonly routeId: string
  readonly target?: ModelComputeTarget
  readonly outcome: 'READY' | 'RELEASED' | 'FAILED_ROLLED_BACK' | 'REJECTED' | 'IDLE_UNLOADED' | 'TAINTED'
  readonly receiptDigests: readonly string[]
  readonly errorCode?: ModelLifecycleErrorCode
}

/** Sanitized effective route committed to the exact durable user session. */
export interface ModelEffectiveRouteEventData {
  readonly selection: ModelSelectionIdentity
  readonly routeId: string
  readonly target: ModelComputeTarget
  readonly admissionReceiptDigest: string
  readonly revisionDigest: string
  readonly scopeDigest: string
  readonly transactionDigest: string
  readonly fencingDigest: string
  readonly receiptDigests: readonly string[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Effective governed local-model route, published only after READY. */
    'model-lifecycle/effective-route': ModelEffectiveRouteEventData
  }
}

/** Canonical classifier, scope resolver, and sanitized audit sink. */
export interface ModelLifecycleAuthority {
  classifyProvider(provider: string): ModelProviderClassification
  /**
   * Resolve one exact governed request within the runtime-owned deadline.
   * @param request - Complete provider, model, session, and cancellation intent.
   * @param signal - Runtime-owned cancellation for the authority operation.
   * @returns The externally governed route decision.
   */
  resolve(request: AcquireModelRouteRequest, signal: AbortSignal): Promise<ModelRouteResolution> | ModelRouteResolution
  /**
   * Persist one sanitized lifecycle outcome within the runtime-owned deadline.
   * @param record - Digest-only lifecycle outcome.
   * @param signal - Runtime-owned cancellation for the authority operation.
   * @returns Completion after durable settlement.
   */
  record(record: ModelLifecycleAuditRecord, signal: AbortSignal): Promise<void>
}

const lifecycleStages = ['prestate', 'preflight', 'drain', 'stop', 'verify-stopped', 'start', 'health', 'probe'] as const

/** Lifecycle stages whose receipts must bind the exact transaction. */
export type ModelLifecycleStage = typeof lifecycleStages[number]

/** Server-owned lifecycle state-machine branch selected by the runtime. */
export type ModelLifecycleTransactionKind = 'MODEL_ROUTE' | 'IDLE_UNLOAD' | 'SHUTDOWN'

/** One sanitized, hash-bound stage receipt. */
export interface ModelLifecycleStageReceipt {
  readonly stage: ModelLifecycleStage
  readonly routeId: string
  readonly target: ModelComputeTarget
  readonly revisionDigest: string
  readonly scopeDigest: string
  readonly transactionDigest: string
  readonly fencingDigest: string
  readonly digest: string
}

/** Current occupancy of the target, inspected by the host rather than inferred from app memory. */
export interface ModelLifecyclePrestateReceipt extends ModelLifecycleStageReceipt {
  readonly residency:
    | { readonly kind: 'EMPTY' }
    | { readonly kind: 'RESIDENT'; readonly routeId: string; readonly revisionDigest: string }
    | { readonly kind: 'UNKNOWN' }
}

/** Dynamic resource decision returned by the host driver. */
export type ModelCapacityDecision =
  | { readonly ok: true; readonly receipt: ModelLifecycleStageReceipt }
  | { readonly ok: false; readonly reason: string }

/** Dynamic health decision returned after launch or before same-route reuse. */
export type ModelHealthDecision =
  | { readonly ok: true; readonly receipt: ModelLifecycleStageReceipt }
  | { readonly ok: false; readonly reason: string }

/** Context shared by every host-specific lifecycle stage. */
export interface ModelLifecycleStageContext {
  readonly route: GovernedModelRoute
  readonly target: ModelComputeTarget
  readonly scope: ModelExecutionScope
  readonly transactionKind: ModelLifecycleTransactionKind
  readonly transactionDigest: string
  /** Externally issued resource grant; drivers must validate its fence at the execution endpoint. */
  readonly resourceLease: ResourceLeaseGrant
  /** Absolute deadline for this individual host-driver stage. */
  readonly deadlineAt: number
  readonly signal: AbortSignal
}

/** Previous and next route data required for a bounded queue drain. */
export interface ModelDrainContext extends ModelLifecycleStageContext {
  readonly nextRoute: GovernedModelRoute
  readonly nextTarget: ModelComputeTarget
}

/** Host-specific mechanism. Implementations must not choose fallback targets. */
export interface ModelLifecycleDriver {
  capturePrestate(context: ModelLifecycleStageContext): Promise<ModelLifecyclePrestateReceipt>
  preflight(context: ModelLifecycleStageContext): Promise<ModelCapacityDecision>
  drain(context: ModelDrainContext): Promise<ModelLifecycleStageReceipt>
  stop(context: ModelLifecycleStageContext): Promise<ModelLifecycleStageReceipt>
  verifyStopped(context: ModelLifecycleStageContext): Promise<ModelLifecycleStageReceipt>
  start(context: ModelLifecycleStageContext): Promise<ModelLifecycleStageReceipt>
  health(context: ModelLifecycleStageContext): Promise<ModelHealthDecision>
  probe(context: ModelLifecycleStageContext): Promise<ModelHealthDecision>
}

/** Request at the final LLM dispatch boundary. */
export interface AcquireModelRouteRequest {
  readonly sessionId?: string
  readonly selection: ModelSelectionIdentity
  readonly preference?: ModelComputePreference
  readonly signal?: AbortSignal
}

/** One inference lease that prevents another route from unloading its model. */
export interface ModelRouteLease {
  readonly managed: boolean
  readonly routeId?: string
  readonly target?: ModelComputeTarget
  /** Revocation or expiry aborts inference without attempting stale resource mutations. */
  readonly signal?: AbortSignal
  release(): Promise<void>
}

/** Detached runtime facts safe for diagnostics and tests. */
export interface ModelLifecycleSnapshot {
  readonly phase: 'IDLE' | 'PREPARING' | 'DRAINING' | 'LOADING' | 'READY' | 'IN_USE' | 'FAILED_ROLLED_BACK' | 'TAINTED'
  readonly active?: {
    readonly routeId: string
    readonly target: ModelComputeTarget
    readonly revisionDigest: string
    readonly healthDigest: string
  }
}

interface Registration {
  readonly route: GovernedModelRoute
  readonly driver: ModelLifecycleDriver
}

interface ActiveRoute {
  readonly registration: Registration
  readonly target: ModelComputeTarget
  readonly healthDigest: string
  readonly scope: ModelExecutionScope
  readonly activatedAt: number
}

/** Internal marker that preserves rollback outcome while the host returns to its prior steady phase. */
class RolledBackLifecycleFailure extends Error {
  constructor(readonly failure: unknown) {
    super('model lifecycle transaction rolled back')
    this.name = 'RolledBackLifecycleFailure'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional governed local-model inference boundary. */
    modelLifecycle: ModelLifecycleRuntime
  }
}

/** Typed lifecycle failure with a stable, user-safe code. */
export class ModelLifecycleError extends LlmError {
  constructor(
    override readonly code: ModelLifecycleErrorCode,
    message: string,
  ) {
    super(message, code)
    this.name = 'ModelLifecycleError'
  }
}

class AuthorityOperationTimeout extends Error {
  constructor(label: string) {
    super(`model-lifecycle: ${label} exceeded its deadline`)
    this.name = 'AuthorityOperationTimeout'
  }
}

class AuditPersistenceFailure extends ModelLifecycleError {
  constructor(
    routeId: string,
    readonly settlementUnknown: boolean,
  ) {
    super('AUDIT_FAILED', `Could not persist lifecycle audit for ${routeId}`)
    this.name = 'AuditPersistenceFailure'
  }
}

function routeKey(selection: ModelSelectionIdentity): string {
  return `${selection.provider}\u0000${selection.model}`
}

function assertDigest(name: string, value: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`model-lifecycle: ${name} must be a lowercase sha256 digest`)
  }
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new ModelLifecycleError('ABORTED', 'Local model inference was cancelled')
  }
}

function assertResourceSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new ModelLifecycleError('RESOURCE_LEASE_LOST', 'Local model resource ownership was lost')
  }
}

function lifecycleError(code: ModelLifecycleErrorCode, message: string, cause: unknown): ModelLifecycleError {
  if (cause instanceof ResourceLeaseError) return new ModelLifecycleError(cause.code, cause.message)
  return cause instanceof ModelLifecycleError ? cause : new ModelLifecycleError(code, message)
}

/**
 * Compute the canonical digest binding a governed local-model execution scope.
 * @param scope - Exact work, principal, tenant, and session identity.
 * @returns A lowercase SHA-256 digest suitable for receipts and audit records.
 */
export function createModelExecutionScopeDigest(scope: Omit<ModelExecutionScope, 'digest'>): string {
  return `sha256:${createHash('sha256').update([
    scope.workId,
    scope.principalId,
    scope.tenantId,
    scope.sessionId,
  ].join('\u0000')).digest('hex')}`
}

function assertScope(scope: ModelExecutionScope): void {
  for (const name of ['workId', 'principalId', 'tenantId', 'sessionId'] as const) {
    const value = scope[name]
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ModelLifecycleError('SCOPE_INVALID', `Model scope ${name} is required`)
    }
  }
  if (typeof scope.digest !== 'string') {
    throw new ModelLifecycleError('SCOPE_INVALID', 'Model scope digest is required')
  }
  try {
    assertDigest('scope.digest', scope.digest)
  } catch {
    throw new ModelLifecycleError('SCOPE_INVALID', 'Model scope digest must be a lowercase SHA-256 digest')
  }
  if (scope.digest !== createModelExecutionScopeDigest(scope)) {
    throw new ModelLifecycleError('SCOPE_INVALID', 'Model scope digest does not bind the resolved identity')
  }
}

function assertStageReceipt(
  stage: ModelLifecycleStage,
  receipt: ModelLifecycleStageReceipt,
  context: ModelLifecycleStageContext,
): void {
  assertDigest(`${stage}.digest`, receipt.digest)
  if (
    receipt.stage !== stage
    || receipt.routeId !== context.route.id
    || receipt.target !== context.target
    || receipt.revisionDigest !== context.route.revisionDigest
    || receipt.scopeDigest !== context.scope.digest
    || receipt.transactionDigest !== context.transactionDigest
    || receipt.fencingDigest !== context.resourceLease.fencingDigest
  ) {
    throw new Error(`model-lifecycle: ${stage} receipt is not bound to the active transaction`)
  }
}

function assertHealthReceipt(
  stage: 'health' | 'probe',
  decision: ModelHealthDecision,
  context: ModelLifecycleStageContext,
): void {
  if (decision.ok) assertStageReceipt(stage, decision.receipt, context)
}

function digest(parts: readonly string[]): string {
  return `sha256:${createHash('sha256').update(parts.join('\u0000')).digest('hex')}`
}

function sameRoute(left: GovernedModelRoute, right: GovernedModelRoute): boolean {
  return left.id === right.id
    && routeKey(left.selection) === routeKey(right.selection)
    && left.disposition === right.disposition
    && left.admissionReceiptDigest === right.admissionReceiptDigest
    && left.revisionDigest === right.revisionDigest
    && left.allowRamCpuOffload === right.allowRamCpuOffload
    && sameValues(left.targets, right.targets)
    && sameValues(left.supportedReasoningEfforts, right.supportedReasoningEfforts)
    && sameStageTimeouts(left.stageTimeoutsMs, right.stageTimeoutsMs)
}

function sameStageTimeouts(
  left: GovernedModelRoute['stageTimeoutsMs'],
  right: GovernedModelRoute['stageTimeoutsMs'],
): boolean {
  const entries = Object.entries(left ?? {})
  return entries.length === Object.keys(right ?? {}).length
    && entries.every(([stage, value]) => right?.[stage as ModelLifecycleStage] === value)
}

function sameValues(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function unmanagedLease(): ModelRouteLease {
  return Object.freeze({
    managed: false,
    release: () => Promise.resolve(),
  })
}

/**
 * One in-process transaction coordinator for every governed local route.
 * Registrations supply mechanics; this service owns serialization, target
 * precedence, inference leases, and rollback ordering.
 */
export class ModelLifecycleRuntime extends Service {
  static Config = Config
  static inject = ['sessions']

  private readonly bySelection = new Map<string, Registration>()
  private readonly byRoute = new Map<string, Registration>()
  private active: ActiveRoute | undefined
  private phase: ModelLifecycleSnapshot['phase'] = 'IDLE'
  private slotLocked = false
  private readonly waiters: Array<() => void> = []
  private settings: () => ResolvedModelLifecycleConfig
  private authority: ModelLifecycleAuthority | undefined
  private resources: ResourceLeaseProvider | undefined
  private readonly authorityOperations = new Set<Promise<unknown>>()
  private readonly resourceOperations = new Set<Promise<unknown>>()
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private transactionCounter = 0
  private tainted = false
  private resourceLease: ResourceLeaseSession | undefined
  private readonly requestSignals = new WeakMap<GenerateOptions, AbortSignal>()

  constructor(ctx: Context, config: ModelLifecycleConfig = {}) {
    super(ctx, 'modelLifecycle')
    const entry = Config(config) as ResolvedModelLifecycleConfig
    this.settings = () => entry
    installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, entry, {
      setSource: (source) => { this.settings = source as () => ResolvedModelLifecycleConfig },
      onChange: () => {},
    })
    ctx.on('llm/stream', (options, next) => this.guardStream(options, next), { global: true })
    ctx.on('llm/dispatch-signal', (options, next) => {
      const inherited = next()
      const lease = this.requestSignals.get(options)
      return lease === undefined ? inherited : inherited === undefined ? lease : AbortSignal.any([inherited, lease])
    }, { global: true })
    ctx.effect(
      () => async () => this.shutdownActive(),
      'model-lifecycle: orderly active-route shutdown',
    )
  }

  /**
   * Read the current durable routing intent; actual placement remains a
   * preflight decision.
   * @returns The persisted Automatic, R5300, or PRDG preference.
   */
  currentPreference(): ModelComputePreference {
    return this.settings().preference
  }

  /**
   * Install the sole classifier, scope resolver, and audit sink.
   * @param authority - Canonical governance adapter for this runtime instance.
   * @returns A release function for orderly plugin disposal.
   */
  installAuthority(authority: ModelLifecycleAuthority): () => void {
    if (this.authority !== undefined) throw new Error('model-lifecycle: authority is already installed')
    this.authority = authority
    return () => {
      if (this.active !== undefined || this.byRoute.size > 0 || this.resourceLease !== undefined
        || this.authorityOperations.size > 0) {
        throw new Error('model-lifecycle: authority remains in use')
      }
      if (this.authority === authority) this.authority = undefined
    }
  }

  /**
   * Install the sole deployment-owned shared resource lease provider without
   * granting it route classification, scope resolution, or audit authority.
   * @param resources - Verified external resource lease mechanics.
   * @returns A release function for orderly plugin disposal.
   */
  installResources(resources: ResourceLeaseProvider): () => void {
    if (this.resources !== undefined) {
      throw new Error('model-lifecycle: resources are already installed')
    }
    this.resources = resources
    return () => {
      if (this.byRoute.size > 0 || this.active !== undefined || this.resourceLease !== undefined
        || this.resourceOperations.size > 0) {
        throw new Error('model-lifecycle: resources remain in use')
      }
      if (this.resources === resources) this.resources = undefined
    }
  }

  /**
   * Register one immutable route/driver pair for the lifetime of its owner.
   * @param route - Externally admitted route identity and target manifest.
   * @param driver - Host-specific resource and process mechanism.
   * @returns An async release function that stops an active route before removal.
   */
  register(route: GovernedModelRoute, driver: ModelLifecycleDriver): () => Promise<void> {
    if (route.id.length === 0 || route.selection.provider.length === 0 || route.selection.model.length === 0) {
      throw new Error('model-lifecycle: route id, provider, and model are required')
    }
    assertDigest('admissionReceiptDigest', route.admissionReceiptDigest)
    assertDigest('revisionDigest', route.revisionDigest)
    if (route.targets.length === 0 || new Set(route.targets).size !== route.targets.length) {
      throw new Error(`model-lifecycle: route ${route.id} must declare unique targets`)
    }
    if (route.targets.includes('ram-cpu') && !route.allowRamCpuOffload) {
      throw new Error(`model-lifecycle: route ${route.id} cannot expose ram-cpu without an offload manifest`)
    }
    for (const [stage, timeout] of Object.entries(route.stageTimeoutsMs ?? {})) {
      if (!lifecycleStages.some(candidate => candidate === stage)
        || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
        throw new Error('model-lifecycle: known stages require positive timer-safe integer deadlines')
      }
    }
    const immutableRoute: GovernedModelRoute = Object.freeze({
      ...route,
      selection: Object.freeze({ ...route.selection }),
      targets: Object.freeze([...route.targets]),
      ...route.supportedReasoningEfforts === undefined
        ? {}
        : { supportedReasoningEfforts: Object.freeze([...route.supportedReasoningEfforts]) },
      ...route.stageTimeoutsMs === undefined
        ? {}
        : { stageTimeoutsMs: Object.freeze({ ...route.stageTimeoutsMs }) },
    })
    const key = routeKey(immutableRoute.selection)
    if (this.byRoute.has(route.id) || this.bySelection.has(key)) {
      throw new Error(`model-lifecycle: duplicate governed route ${route.id}`)
    }
    const registration = Object.freeze({ route: immutableRoute, driver })
    this.byRoute.set(route.id, registration)
    this.bySelection.set(key, registration)
    let released = false
    return async () => {
      if (released) return
      released = true
      if (this.byRoute.get(route.id) === registration) this.byRoute.delete(route.id)
      if (this.bySelection.get(key) === registration) this.bySelection.delete(key)
      await this.shutdownActive(registration)
    }
  }

  /**
   * Acquire a governed route for one complete inference, or return an inert
   * lease for an ordinary provider. The lease must remain held until the model
   * stream settles so another request cannot unload the active model mid-turn.
   * @param request - Complete provider/model selection and optional cancellation signal.
   * @returns A lease that the caller must release exactly once.
   */
  async acquireRoute(request: AcquireModelRouteRequest): Promise<ModelRouteLease> {
    const authority = this.authority
    if (authority === undefined) {
      if (this.bySelection.has(routeKey(request.selection))) {
        throw new ModelLifecycleError('GOVERNANCE_UNAVAILABLE', 'Governed local-model authority is unavailable')
      }
      return unmanagedLease()
    }
    let classification: ModelProviderClassification
    try {
      classification = authority.classifyProvider(request.selection.provider)
    } catch (error: unknown) {
      throw lifecycleError('GOVERNANCE_UNAVAILABLE', 'Could not classify the selected model provider', error)
    }
    if (classification === 'UNMANAGED_EXTERNAL') {
      if (this.bySelection.has(routeKey(request.selection))) {
        throw new ModelLifecycleError(
          'ROUTE_HELD',
          'A registered local-model route cannot be classified as unmanaged external',
        )
      }
      return unmanagedLease()
    }
    if (request.sessionId === undefined || this.ctx.sessions.get(SessionId(request.sessionId)) === undefined) {
      throw new ModelLifecycleError(
        'SCOPE_INVALID',
        'Governed local-model inference requires one exact live session',
      )
    }
    const release = await this.acquire(request.signal, true)
    this.cancelIdleUnload()
    let registration: Registration | undefined
    let scope: Readonly<ModelExecutionScope> | undefined
    let transactionDigest: string | undefined
    const activation = { started: false }
    const receipts: ModelLifecycleStageReceipt[] = []
    try {
      if (this.tainted) {
        throw new ModelLifecycleError(
          'RUNTIME_TAINTED',
          'Local-model state is uncertain; host reconciliation or an orderly runtime restart is required',
        )
      }
      let resolution: ModelRouteResolution
      try {
        resolution = await this.runAuthorityOperation(
          'route resolution',
          request.signal,
          signal => authority.resolve(request, signal),
        )
      } catch (error: unknown) {
        throw lifecycleError('GOVERNANCE_UNAVAILABLE', 'Could not resolve the selected local-model route', error)
      }
      if (resolution.kind === 'UNMANAGED_EXTERNAL') {
        throw new ModelLifecycleError('ROUTE_HELD', 'A governed local provider cannot resolve as unmanaged external')
      }
      if (resolution.kind === 'HELD') {
        throw new ModelLifecycleError(
          'ROUTE_HELD',
          `Local model route ${resolution.routeId} is held by governance`,
        )
      }
      assertScope(resolution.scope)
      scope = Object.freeze({ ...resolution.scope })
      if (scope.sessionId !== request.sessionId) {
        throw new ModelLifecycleError('SCOPE_INVALID', 'Resolved model scope does not match the requested session')
      }
      registration = this.byRoute.get(resolution.route.id)
      if (
        registration === undefined
        || !sameRoute(registration.route, resolution.route)
        || routeKey(registration.route.selection) !== routeKey(request.selection)
      ) {
        throw new ModelLifecycleError(
          'ROUTE_HELD',
          `Local model route ${resolution.route.id} has no matching admitted driver`,
        )
      }
      if (registration.route.disposition !== 'AVAILABLE') {
        throw new ModelLifecycleError(
          'ROUTE_HELD',
          `Local model route ${registration.route.id} is not admitted (${registration.route.disposition})`,
        )
      }
      const effort = request.selection.reasoningEffort
      if (effort !== undefined && !registration.route.supportedReasoningEfforts?.includes(effort)) {
        throw new ModelLifecycleError(
          'REASONING_UNSUPPORTED',
          `Reasoning effort ${effort} is not admitted for ${registration.route.id}`,
        )
      }

      this.phase = 'PREPARING'
      transactionDigest = digest([
        registration.route.id,
        registration.route.revisionDigest,
        scope.digest,
        String(Date.now()),
        String(++this.transactionCounter),
      ])
      await this.ensureResourceLease(registration.route.targets, request.signal)
      abortIfRequested(request.signal)
      return await this.activateLocked(
        registration,
        request,
        scope,
        transactionDigest,
        receipts,
        authority,
        release,
        () => { activation.started = true },
      )
    } catch (error: unknown) {
      const rolledBack = error instanceof RolledBackLifecycleFailure
      const failure = rolledBack ? error.failure : error
      const tainted = this.tainted
      if (!rolledBack && !tainted) this.phase = this.active === undefined ? 'IDLE' : 'READY'
      if (
        registration !== undefined
        && scope !== undefined
        && transactionDigest !== undefined
        && !(failure instanceof AuditPersistenceFailure && failure.settlementUnknown)
      ) {
        await this.recordBestEffort(authority, {
          transactionDigest,
          scopeDigest: scope.digest,
          routeId: registration.route.id,
          outcome: tainted ? 'TAINTED' : rolledBack ? 'FAILED_ROLLED_BACK' : 'REJECTED',
          receiptDigests: receipts.map(receipt => receipt.digest),
          errorCode: failure instanceof ModelLifecycleError ? failure.code : 'PREFLIGHT_FAILED',
        })
      }
      if (this.tainted || this.active === undefined) {
        await this.releaseResources(tainted || activation.started ? 'UNCERTAIN' : 'SETTLED')
      }
      release()
      if (!this.tainted && this.active !== undefined) this.scheduleIdleUnload()
      throw lifecycleError('PREFLIGHT_FAILED', 'Local model acquisition failed', failure)
    }
  }

  /**
   * Read detached runtime state without resource paths or private payloads.
   * @returns A sanitized snapshot of phase and active route.
   */
  snapshot(): ModelLifecycleSnapshot {
    const active = this.active
    return {
      phase: this.phase,
      ...active === undefined
        ? {}
        : {
          active: {
            routeId: active.registration.route.id,
            target: active.target,
            revisionDigest: active.registration.route.revisionDigest,
            healthDigest: active.healthDigest,
          },
        },
    }
  }

  /** Guard the final LLM stream so the selected resource cannot change mid-inference. */
  private guardStream(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const acquireRoute = this.acquireRoute.bind(this)
    const requestSignals = this.requestSignals
    return (async function* (): AsyncIterable<StreamChunk> {
      const lease = await acquireRoute({
        selection: {
          provider: options.provider,
          model: options.model,
          ...options.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: String(options.reasoningEffort) },
        },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
      try {
        if (lease.signal !== undefined) requestSignals.set(options, lease.signal)
        assertResourceSignal(lease.signal)
        for await (const chunk of next()) {
          assertResourceSignal(lease.signal)
          yield chunk
        }
        assertResourceSignal(lease.signal)
      } finally {
        requestSignals.delete(options)
        await lease.release()
      }
    })()
  }

  private async activateLocked(
    registration: Registration,
    request: AcquireModelRouteRequest,
    scope: ModelExecutionScope,
    transactionDigest: string,
    receipts: ModelLifecycleStageReceipt[],
    authority: ModelLifecycleAuthority,
    release: () => void,
    onActivationStart: () => void,
  ): Promise<ModelRouteLease> {
    abortIfRequested(request.signal)
    const target = await this.selectTarget(registration, request, scope, transactionDigest, receipts)
    const context = this.stageContext(registration, target, request, scope, transactionDigest)
    let prestate: ModelLifecyclePrestateReceipt
    try {
      prestate = await this.runStage('prestate', context, bounded =>
        registration.driver.capturePrestate(bounded))
      assertStageReceipt('prestate', prestate, context)
      this.assertResidency(prestate, this.active?.target === target ? this.active : undefined)
    } catch (error: unknown) {
      throw lifecycleError('PREFLIGHT_FAILED', `Could not capture prestate for ${registration.route.id}`, error)
    }
    receipts.push(prestate)
    const previous = this.active

    if (previous?.registration === registration && previous.target === target) {
      let healthy: ModelHealthDecision
      try {
        healthy = await this.runStage('health', context, bounded => registration.driver.health(bounded))
        assertHealthReceipt('health', healthy, context)
      } catch (error: unknown) {
        throw lifecycleError('HEALTH_FAILED', `Could not health-check ${registration.route.id}`, error)
      }
      if (!healthy.ok) {
        throw new ModelLifecycleError('HEALTH_FAILED', 'The active local model failed its health check')
      }
      receipts.push(healthy.receipt)
      this.active = { ...previous, scope, healthDigest: healthy.receipt.digest }
      await this.record(authority, {
        transactionDigest,
        scopeDigest: scope.digest,
        routeId: registration.route.id,
        target,
        outcome: 'READY',
        receiptDigests: receipts.map(receipt => receipt.digest),
      })
      this.publishEffectiveRoute(registration, request, target, scope, transactionDigest, receipts)
      return this.routeLease(registration, target, scope, transactionDigest, receipts, authority, release)
    }

    let previousStopAttempted = false
    let previousStoppedVerified = false
    let targetStartAttempted = false
    try {
      if (previous !== undefined) {
        this.phase = 'DRAINING'
        const detachedRequest: AcquireModelRouteRequest = {
          selection: request.selection,
          ...request.sessionId === undefined ? {} : { sessionId: request.sessionId },
          ...request.preference === undefined ? {} : { preference: request.preference },
        }
        const previousContext = this.stageContext(
          previous.registration,
          previous.target,
          detachedRequest,
          scope,
          transactionDigest,
        )
        const drainContext: ModelDrainContext = {
          ...previousContext,
          nextRoute: registration.route,
          nextTarget: target,
        }
        if (previous.target !== target) {
          try {
            const previousPrestate = await this.runStage('prestate', previousContext, bounded =>
              previous.registration.driver.capturePrestate(bounded))
            assertStageReceipt('prestate', previousPrestate, previousContext)
            this.assertResidency(previousPrestate, previous)
            receipts.push(previousPrestate)
          } catch (error: unknown) {
            throw lifecycleError('PREFLIGHT_FAILED', 'Could not verify the previous host model residency', error)
          }
        }
        onActivationStart()
        try {
          const receipt = await this.runStage('drain', drainContext, bounded =>
            previous.registration.driver.drain(bounded))
          assertStageReceipt('drain', receipt, previousContext)
          receipts.push(receipt)
        } catch (error: unknown) {
          throw lifecycleError('DRAIN_FAILED', `Could not drain ${previous.registration.route.id}`, error)
        }
        abortIfRequested(request.signal)
        previousStopAttempted = true
        let stopError: unknown
        try {
          const stop = await this.runStage('stop', previousContext, bounded =>
            previous.registration.driver.stop(bounded))
          assertStageReceipt('stop', stop, previousContext)
          receipts.push(stop)
        } catch (error: unknown) {
          stopError = error
        }
        try {
          const verified = await this.runStage('verify-stopped', previousContext, bounded =>
            previous.registration.driver.verifyStopped(bounded))
          assertStageReceipt('verify-stopped', verified, previousContext)
          receipts.push(verified)
          previousStoppedVerified = true
          this.active = undefined
        } catch (error: unknown) {
          throw lifecycleError('STOP_FAILED', `Could not stop ${previous.registration.route.id}`, error)
        }
        if (stopError !== undefined) {
          throw lifecycleError('STOP_FAILED', `Could not stop ${previous.registration.route.id}`, stopError)
        }
      }

      abortIfRequested(request.signal)
      if (previous === undefined) onActivationStart()
      this.phase = 'LOADING'
      targetStartAttempted = true
      const detachedContext = this.stageContext(registration, target, {
        selection: request.selection,
        ...request.sessionId === undefined ? {} : { sessionId: request.sessionId },
        ...request.preference === undefined ? {} : { preference: request.preference },
      }, scope, transactionDigest)
      try {
        const receipt = await this.runStage('start', detachedContext, bounded => registration.driver.start(bounded))
        assertStageReceipt('start', receipt, detachedContext)
        receipts.push(receipt)
      } catch (error: unknown) {
        throw lifecycleError('START_FAILED', `Could not start ${registration.route.id}`, error)
      }
      abortIfRequested(request.signal)
      let healthy: ModelHealthDecision
      try {
        healthy = await this.runStage('health', detachedContext, bounded => registration.driver.health(bounded))
        assertHealthReceipt('health', healthy, detachedContext)
      } catch (error: unknown) {
        throw lifecycleError('HEALTH_FAILED', `Could not health-check ${registration.route.id}`, error)
      }
      if (!healthy.ok) {
        throw new ModelLifecycleError('HEALTH_FAILED', `Local model ${registration.route.id} failed its health check`)
      }
      receipts.push(healthy.receipt)
      abortIfRequested(request.signal)
      let probe: ModelHealthDecision
      try {
        probe = await this.runStage('probe', detachedContext, bounded => registration.driver.probe(bounded))
        assertHealthReceipt('probe', probe, detachedContext)
      } catch (error: unknown) {
        throw lifecycleError('HEALTH_FAILED', `Could not capability-probe ${registration.route.id}`, error)
      }
      if (!probe.ok) {
        throw new ModelLifecycleError('HEALTH_FAILED', `Local model ${registration.route.id} failed its capability probe`)
      }
      receipts.push(probe.receipt)
      abortIfRequested(request.signal)
      this.active = {
        registration,
        target,
        healthDigest: probe.receipt.digest,
        scope,
        activatedAt: Date.now(),
      }
      await this.record(authority, {
        transactionDigest,
        scopeDigest: scope.digest,
        routeId: registration.route.id,
        target,
        outcome: 'READY',
        receiptDigests: receipts.map(receipt => receipt.digest),
      })
      this.publishEffectiveRoute(registration, request, target, scope, transactionDigest, receipts)
      return this.routeLease(registration, target, scope, transactionDigest, receipts, authority, release)
    } catch (error: unknown) {
      if (error instanceof AuditPersistenceFailure && error.settlementUnknown) {
        // The READY write may still settle after its local deadline. Preserve the
        // physically ready route under quarantine instead of creating a false
        // durable READY record by rolling the host back underneath it.
        this.tainted = true
        this.phase = 'TAINTED'
        throw error
      }
      if (this.resourceLease?.signal.aborted === true || (error instanceof ModelLifecycleError && error.code === 'STAGE_TIMEOUT')) {
        this.active = undefined
        this.tainted = true
        this.phase = 'TAINTED'
        throw error
      }
      if (previousStopAttempted && !previousStoppedVerified) {
        this.active = undefined
        this.tainted = true
        this.phase = 'TAINTED'
        throw error
      }
      if (targetStartAttempted || previousStopAttempted) {
        try {
          await this.restore(
            previous,
            registration,
            target,
            request,
            scope,
            transactionDigest,
            receipts,
            targetStartAttempted,
            previousStoppedVerified,
          )
          if (!this.tainted) this.phase = previous === undefined ? 'IDLE' : 'FAILED_ROLLED_BACK'
        } catch {
          this.active = undefined
          this.tainted = true
          this.phase = 'TAINTED'
          throw new ModelLifecycleError(
            'ROLLBACK_FAILED',
            'Local model switch failed and rollback could not restore the previous route',
          )
        }
        throw new RolledBackLifecycleFailure(error)
      }
      throw error
    }
  }

  private routeLease(
    registration: Registration,
    target: ModelComputeTarget,
    scope: ModelExecutionScope,
    transactionDigest: string,
    receipts: readonly ModelLifecycleStageReceipt[],
    authority: ModelLifecycleAuthority,
    release: () => void,
  ): ModelRouteLease {
    this.currentResourceGrant(target)
    const resourceLease = this.resourceLease
    if (resourceLease === undefined) throw new ModelLifecycleError('RESOURCE_LEASE_LOST', 'Local model resource ownership was lost')
    this.phase = 'IN_USE'
    let released = false
    return Object.freeze({
      managed: true,
      routeId: registration.route.id,
      target,
      signal: resourceLease.signal,
      release: async () => {
        if (released) return
        released = true
        try {
          await this.record(authority, {
            transactionDigest,
            scopeDigest: scope.digest,
            routeId: registration.route.id,
            target,
            outcome: 'RELEASED',
            receiptDigests: receipts.map(receipt => receipt.digest),
          })
        } catch {
          // The completed inference remains valid. record() already fail-closes
          // later managed acquisitions by tainting the lifecycle authority.
        } finally {
          if (!this.tainted) {
            this.phase = 'READY'
            this.scheduleIdleUnload()
          }
          if (this.tainted) await this.releaseResources('UNCERTAIN')
          release()
        }
      },
    })
  }

  private publishEffectiveRoute(
    registration: Registration,
    request: AcquireModelRouteRequest,
    target: ModelComputeTarget,
    scope: ModelExecutionScope,
    transactionDigest: string,
    receipts: readonly ModelLifecycleStageReceipt[],
  ): void {
    try {
      const session = this.ctx.sessions.get(SessionId(scope.sessionId))
      if (request.sessionId === undefined || request.sessionId !== scope.sessionId || session === undefined) {
        throw new Error('resolved session is no longer live')
      }
      const resourceLease = this.currentResourceGrant(target)
      session.append('model-lifecycle/effective-route', {
        selection: {
          provider: request.selection.provider,
          model: request.selection.model,
          ...request.selection.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: request.selection.reasoningEffort },
        },
        routeId: registration.route.id,
        target,
        admissionReceiptDigest: registration.route.admissionReceiptDigest,
        revisionDigest: registration.route.revisionDigest,
        scopeDigest: scope.digest,
        transactionDigest,
        fencingDigest: resourceLease.fencingDigest,
        receiptDigests: receipts.map(receipt => receipt.digest),
      })
    } catch (error: unknown) {
      throw lifecycleError(
        'SESSION_PUBLICATION_FAILED',
        `Could not publish effective model route for ${registration.route.id}`,
        error,
      )
    }
  }

  private async selectTarget(
    registration: Registration,
    request: AcquireModelRouteRequest,
    scope: ModelExecutionScope,
    transactionDigest: string,
    receipts: ModelLifecycleStageReceipt[],
  ): Promise<ModelComputeTarget> {
    const preference = request.preference ?? this.currentPreference()
    const automaticTargets: readonly ModelComputeTarget[] = registration.route.allowRamCpuOffload
      ? ['r5300', 'prdg', 'ram-cpu']
      : ['r5300', 'prdg']
    const candidates: readonly ModelComputeTarget[] = preference === 'automatic'
      ? automaticTargets.filter(target => registration.route.targets.includes(target))
      : [preference]

    const rejected: string[] = []
    for (const target of candidates) {
      if (!registration.route.targets.includes(target)) {
        rejected.push(`${target}: not declared by the route manifest`)
        continue
      }
      abortIfRequested(request.signal)
      let decision: ModelCapacityDecision
      try {
        const context = this.stageContext(registration, target, request, scope, transactionDigest)
        decision = await this.runStage('preflight', context, bounded => registration.driver.preflight(bounded))
        if (decision.ok) {
          assertStageReceipt('preflight', decision.receipt, context)
          receipts.push(decision.receipt)
        }
      } catch (error: unknown) {
        throw lifecycleError('PREFLIGHT_FAILED', `Could not preflight ${registration.route.id} on ${target}`, error)
      }
      if (decision.ok) return target
      rejected.push(target)
      if (preference !== 'automatic') {
        throw new ModelLifecycleError(
          'MANUAL_TARGET_UNAVAILABLE',
          `Manual target ${target} is unavailable for ${registration.route.id}`,
        )
      }
    }
    throw new ModelLifecycleError(
      preference === 'automatic' ? 'NO_CAPACITY' : 'MANUAL_TARGET_UNAVAILABLE',
      `No admitted compute target is available for ${registration.route.id} (${rejected.join(', ')})`,
    )
  }

  private stageContext(
    registration: Registration,
    target: ModelComputeTarget,
    request: AcquireModelRouteRequest,
    scope: ModelExecutionScope,
    transactionDigest: string,
    transactionKind: ModelLifecycleTransactionKind = 'MODEL_ROUTE',
  ): ModelLifecycleStageContext {
    return {
      route: registration.route,
      target,
      scope,
      transactionKind,
      transactionDigest,
      resourceLease: this.currentResourceGrant(target),
      deadlineAt: Date.now() + this.settings().stageTimeoutMs,
      signal: request.signal ?? new AbortController().signal,
    }
  }

  private async runStage<T, TContext extends ModelLifecycleStageContext>(
    stage: ModelLifecycleStage,
    context: TContext,
    operation: (boundedContext: TContext) => Promise<T>,
  ): Promise<T> {
    const resourceLease = this.resourceLease
    const currentGrant = this.currentResourceGrant(context.target)
    abortIfRequested(context.signal)
    const timeoutMs = context.route.stageTimeoutsMs?.[stage] ?? this.settings().stageTimeoutMs
    const controller = new AbortController()
    const boundedContext = {
      ...context,
      deadlineAt: Date.now() + timeoutMs,
      resourceLease: currentGrant,
      signal: controller.signal,
    } as TContext

    return await new Promise<T>((resolve, reject) => {
      let settled = false
      const timer: { current?: ReturnType<typeof setTimeout> } = {}
      const cleanup = () => {
        if (timer.current !== undefined) clearTimeout(timer.current)
        context.signal.removeEventListener('abort', onAbort)
        resourceLease?.signal.removeEventListener('abort', onResourceLost)
      }
      const rejectOnce = (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error instanceof Error ? error : new Error(`model-lifecycle: ${stage} failed`))
      }
      const onAbort = () => {
        controller.abort(context.signal.reason)
        rejectOnce(new ModelLifecycleError('ABORTED', 'Local model inference was cancelled'))
      }
      const onResourceLost = () => {
        const error = new ModelLifecycleError('RESOURCE_LEASE_LOST', 'Local model resource ownership was lost')
        controller.abort(error)
        rejectOnce(error)
      }

      context.signal.addEventListener('abort', onAbort, { once: true })
      resourceLease?.signal.addEventListener('abort', onResourceLost, { once: true })
      if (resourceLease?.signal.aborted === true) {
        onResourceLost()
        return
      }
      if (context.signal.aborted) {
        onAbort()
        return
      }
      timer.current = setTimeout(() => {
        controller.abort(new Error(`model-lifecycle: ${stage} timed out`))
        rejectOnce(new ModelLifecycleError(
          'STAGE_TIMEOUT',
          `Local model ${stage} exceeded its ${timeoutMs} ms deadline`,
        ))
      }, timeoutMs)
      ;(timer.current as { unref?: () => void }).unref?.()

      void Promise.resolve()
        .then(() => operation(boundedContext))
        .then((value) => {
          if (settled) return
          try {
            this.currentResourceGrant(context.target)
          } catch (error: unknown) {
            rejectOnce(error)
            return
          }
          settled = true
          cleanup()
          resolve(value)
        }, rejectOnce)
    })
  }

  private async ensureResourceLease(targets: readonly ModelComputeTarget[], signal?: AbortSignal): Promise<void> {
    if (this.resourceLease !== undefined) {
      for (const target of targets) this.currentResourceGrant(target)
      return
    }
    const resources = this.resources
    if (resources === undefined) {
      throw new ModelLifecycleError('RESOURCE_LEASE_UNAVAILABLE', 'Shared local-model resource authority is unavailable')
    }
    const candidates = [...new Set([...this.byRoute.values()]
      .filter(registration => registration.route.disposition === 'AVAILABLE')
      .flatMap(registration => [...registration.route.targets]))]
    try {
      const lease = await ResourceLeaseSession.acquire(
        resources,
        candidates,
        this.settings().stageTimeoutMs,
        signal,
        (operation) => { this.trackOperation(this.resourceOperations, operation) },
      )
      this.resourceLease = lease
      lease.signal.addEventListener('abort', () => {
        if (this.resourceLease !== lease) return
        this.tainted = true
        this.phase = 'TAINTED'
        this.cancelIdleUnload()
      }, { once: true })
      for (const target of targets) this.currentResourceGrant(target)
    } catch (error: unknown) {
      throw lifecycleError('RESOURCE_LEASE_UNAVAILABLE', 'Could not acquire shared local-model resources', error)
    }
  }

  private currentResourceGrant(target: ModelComputeTarget): ResourceLeaseGrant {
    try {
      const grant = this.resourceLease?.current()
      if (grant === undefined || !grant.targets.includes(target)) {
        throw new ModelLifecycleError('RESOURCE_LEASE_UNAVAILABLE', 'The shared resource lease does not cover the selected target')
      }
      return grant
    } catch (error: unknown) {
      throw lifecycleError('RESOURCE_LEASE_LOST', 'Local model resource ownership was lost', error)
    }
  }

  private async releaseResources(outcome: 'SETTLED' | 'UNCERTAIN'): Promise<void> {
    const lease = this.resourceLease
    this.resourceLease = undefined
    try {
      await lease?.close(outcome)
    } catch {
      this.tainted = true
      this.phase = 'TAINTED'
    }
  }

  /** A fresh process never adopts or stops an independently resident model from a cached receipt. */
  private assertResidency(receipt: ModelLifecyclePrestateReceipt, expected: ActiveRoute | undefined): void {
    const resident = receipt.residency
    const matches = expected === undefined
      ? resident.kind === 'EMPTY'
      : resident.kind === 'RESIDENT'
        && resident.routeId === expected.registration.route.id
        && resident.revisionDigest === expected.registration.route.revisionDigest
    if (matches) return
    this.tainted = true
    this.phase = 'TAINTED'
    this.cancelIdleUnload()
    throw new ModelLifecycleError(
      'RESIDENCY_UNVERIFIED',
      'The host model residency differs from this runtime; owner reconciliation is required before resource changes',
    )
  }

  private async restore(
    previous: ActiveRoute | undefined,
    targetRegistration: Registration,
    target: ModelComputeTarget,
    request: AcquireModelRouteRequest,
    scope: ModelExecutionScope,
    transactionDigest: string,
    receipts: ModelLifecycleStageReceipt[],
    targetStartAttempted: boolean,
    previousStoppedVerified: boolean,
  ): Promise<void> {
    const failures: unknown[] = []
    const cleanupRequest: AcquireModelRouteRequest = {
      selection: request.selection,
      ...request.sessionId === undefined ? {} : { sessionId: request.sessionId },
      ...request.preference === undefined ? {} : { preference: request.preference },
    }
    if (targetStartAttempted) {
      const targetContext = this.stageContext(targetRegistration, target, cleanupRequest, scope, transactionDigest)
      try {
        const stopped = await this.runStage('stop', targetContext, bounded =>
          targetRegistration.driver.stop(bounded))
        assertStageReceipt('stop', stopped, targetContext)
        receipts.push(stopped)
        const verified = await this.runStage('verify-stopped', targetContext, bounded =>
          targetRegistration.driver.verifyStopped(bounded))
        assertStageReceipt('verify-stopped', verified, targetContext)
        receipts.push(verified)
      } catch (error: unknown) {
        failures.push(error)
      }
      this.active = undefined
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'target cleanup did not reach a verified stopped state')
    }
    if (previous !== undefined && previousStoppedVerified) {
      const previousContext = this.stageContext(
        previous.registration,
        previous.target,
        cleanupRequest,
        scope,
        transactionDigest,
      )
      try {
        const started = await this.runStage('start', previousContext, bounded =>
          previous.registration.driver.start(bounded))
        assertStageReceipt('start', started, previousContext)
        receipts.push(started)
        const health = await this.runStage('health', previousContext, bounded =>
          previous.registration.driver.health(bounded))
        assertHealthReceipt('health', health, previousContext)
        if (!health.ok) throw new Error(`restored route failed health: ${health.reason}`)
        receipts.push(health.receipt)
        const probe = await this.runStage('probe', previousContext, bounded =>
          previous.registration.driver.probe(bounded))
        assertHealthReceipt('probe', probe, previousContext)
        if (!probe.ok) throw new Error(`restored route failed capability probe: ${probe.reason}`)
        receipts.push(probe.receipt)
        this.active = { ...previous, healthDigest: probe.receipt.digest }
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'model lifecycle rollback failed')
  }

  private async record(authority: ModelLifecycleAuthority, record: ModelLifecycleAuditRecord): Promise<void> {
    const immutableRecord = Object.freeze({
      ...record,
      receiptDigests: Object.freeze([...record.receiptDigests]),
    })
    const compensationRecord = record.outcome === 'READY'
      ? Object.freeze({
        ...immutableRecord,
        outcome: 'TAINTED' as const,
        errorCode: 'AUDIT_FAILED' as const,
      })
      : undefined
    try {
      await this.runAuthorityOperation(
        'audit persistence',
        undefined,
        signal => authority.record(immutableRecord, signal),
        compensationRecord === undefined
          ? undefined
          : () => this.recordCompensationBestEffort(authority, compensationRecord),
      )
    } catch (error: unknown) {
      this.tainted = true
      this.cancelIdleUnload()
      this.phase = 'TAINTED'
      throw new AuditPersistenceFailure(record.routeId, error instanceof AuthorityOperationTimeout)
    }
  }

  private async recordCompensationBestEffort(
    authority: ModelLifecycleAuthority,
    record: ModelLifecycleAuditRecord,
  ): Promise<void> {
    try {
      await this.runAuthorityOperation(
        'audit compensation',
        undefined,
        signal => authority.record(record, signal),
      )
    } catch {
      // The slot is already quarantined; deployment reconciliation owns a failed audit sink.
    }
  }

  private async recordBestEffort(authority: ModelLifecycleAuthority, record: ModelLifecycleAuditRecord): Promise<void> {
    try {
      await this.record(authority, record)
    } catch {
      // The original lifecycle failure remains authoritative; no private data is logged here.
    }
  }

  /** Bound non-host authority calls so a failed adapter cannot hold the global queue forever. */
  private async runAuthorityOperation<T>(
    label: string,
    signal: AbortSignal | undefined,
    operation: (boundedSignal: AbortSignal) => Promise<T> | T,
    onLateSettle?: () => Promise<void> | void,
  ): Promise<T> {
    abortIfRequested(signal)
    const timeoutMs = this.settings().stageTimeoutMs
    const controller = new AbortController()
    return await new Promise<T>((resolve, reject) => {
      let settled = false
      const timer: { current?: ReturnType<typeof setTimeout> } = {}
      const cleanup = () => {
        if (timer.current !== undefined) clearTimeout(timer.current)
        signal?.removeEventListener('abort', onAbort)
      }
      const settle = (callback: () => void): void => {
        if (settled) return
        settled = true
        cleanup()
        callback()
      }
      const onAbort = () => {
        controller.abort(signal?.reason)
        settle(() => { reject(new ModelLifecycleError('ABORTED', 'Local model inference was cancelled')) })
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted === true) {
        onAbort()
        return
      }
      timer.current = setTimeout(() => {
        controller.abort(new Error(`model-lifecycle: ${label} timed out`))
        settle(() => { reject(new AuthorityOperationTimeout(label)) })
      }, timeoutMs)
      ;(timer.current as { unref?: () => void }).unref?.()
      const actual = Promise.resolve().then(() => {
        if (settled) throw new Error(`model-lifecycle: ${label} was cancelled before invocation`)
        return operation(controller.signal)
      })
      this.trackOperation(this.authorityOperations, actual)
      void actual
        .then(
          (value) => {
            if (settled) {
              const compensation = Promise.resolve().then(() => onLateSettle?.())
              this.trackOperation(this.authorityOperations, compensation)
              void compensation.catch(() => {})
              return
            }
            settle(() => { resolve(value) })
          },
          (error: unknown) => {
            if (settled) {
              const compensation = Promise.resolve().then(() => onLateSettle?.())
              this.trackOperation(this.authorityOperations, compensation)
              void compensation.catch(() => {})
              return
            }
            settle(() => { reject(error instanceof Error ? error : new Error(`model-lifecycle: ${label} failed`)) })
          },
        )
    })
  }

  private trackOperation(set: Set<Promise<unknown>>, operation: Promise<unknown>): void {
    set.add(operation)
    void operation.then(
      () => { set.delete(operation) },
      () => { set.delete(operation) },
    )
  }

  private cancelIdleUnload(): void {
    if (this.idleTimer === undefined) return
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private async shutdownActive(expectedRegistration?: Registration): Promise<void> {
    this.cancelIdleUnload()
    const release = await this.acquire(undefined)
    this.cancelIdleUnload()
    const active = this.active
    if (this.tainted || active === undefined || (
      expectedRegistration !== undefined
      && active.registration !== expectedRegistration
    )) {
      if (this.tainted || active === undefined) await this.releaseResources('UNCERTAIN')
      release()
      return
    }

    const authority = this.authority
    const transactionDigest = digest([
      active.registration.route.id,
      active.registration.route.revisionDigest,
      active.scope.digest,
      'shutdown',
      String(Date.now()),
      String(++this.transactionCounter),
    ])
    const request: AcquireModelRouteRequest = {
      sessionId: active.scope.sessionId,
      selection: active.registration.route.selection,
    }
    const receipts: ModelLifecycleStageReceipt[] = []
    const failures: unknown[] = []

    try {
      const context = this.stageContext(
        active.registration,
        active.target,
        request,
        active.scope,
        transactionDigest,
        'SHUTDOWN',
      )
      try {
        const prestate = await this.runStage('prestate', context, bounded =>
          active.registration.driver.capturePrestate(bounded))
        assertStageReceipt('prestate', prestate, context)
        this.assertResidency(prestate, active)
        receipts.push(prestate)
      } catch (error: unknown) {
        this.tainted = true
        this.phase = 'TAINTED'
        const failure = lifecycleError('PREFLIGHT_FAILED', 'Could not verify model residency before shutdown', error)
        if (authority !== undefined) {
          await this.recordBestEffort(authority, {
            transactionDigest,
            scopeDigest: active.scope.digest,
            routeId: active.registration.route.id,
            target: active.target,
            outcome: 'TAINTED',
            receiptDigests: receipts.map(receipt => receipt.digest),
            errorCode: failure.code,
          })
        }
        throw failure
      }

      this.phase = 'DRAINING'
      try {
        const stopped = await this.runStage('stop', context, bounded =>
          active.registration.driver.stop(bounded))
        assertStageReceipt('stop', stopped, context)
        receipts.push(stopped)
      } catch (error: unknown) {
        failures.push(error)
      }

      let verifiedStopped = false
      try {
        const verified = await this.runStage('verify-stopped', context, bounded =>
          active.registration.driver.verifyStopped(bounded))
        assertStageReceipt('verify-stopped', verified, context)
        receipts.push(verified)
        verifiedStopped = true
      } catch (error: unknown) {
        failures.push(error)
      }

      if (verifiedStopped) this.active = undefined
      if (failures.length > 0 || !verifiedStopped) {
        this.tainted = true
        this.phase = 'TAINTED'
        if (authority !== undefined) {
          await this.recordBestEffort(authority, {
            transactionDigest,
            scopeDigest: active.scope.digest,
            routeId: active.registration.route.id,
            target: active.target,
            outcome: 'TAINTED',
            receiptDigests: receipts.map(receipt => receipt.digest),
            errorCode: 'STOP_FAILED',
          })
        }
        throw new ModelLifecycleError(
          'STOP_FAILED',
          'Could not verify an orderly shutdown of the active local model',
        )
      }

      this.phase = 'IDLE'
      if (authority !== undefined) {
        await this.record(authority, {
          transactionDigest,
          scopeDigest: active.scope.digest,
          routeId: active.registration.route.id,
          target: active.target,
          outcome: 'IDLE_UNLOADED',
          receiptDigests: receipts.map(receipt => receipt.digest),
        })
      }
    } finally {
      if (this.tainted || this.active === undefined) await this.releaseResources(this.tainted ? 'UNCERTAIN' : 'SETTLED')
      release()
    }
  }

  private scheduleIdleUnload(): void {
    this.cancelIdleUnload()
    const active = this.active
    const { idleUnloadMs, minimumDwellMs } = this.settings()
    if (active === undefined || idleUnloadMs === 0) return
    const dwellRemaining = Math.max(0, active.activatedAt + minimumDwellMs - Date.now())
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      void this.unloadIdle(active)
    }, Math.max(idleUnloadMs, dwellRemaining))
    ;(this.idleTimer as { unref?: () => void }).unref?.()
  }

  private async unloadIdle(expected: ActiveRoute): Promise<void> {
    const release = await this.acquire(undefined)
    if (this.active !== expected || (this.phase !== 'READY' && this.phase !== 'FAILED_ROLLED_BACK')) {
      release()
      return
    }
    const authority = this.authority
    if (authority === undefined) {
      release()
      return
    }
    const transactionDigest = digest([
      expected.registration.route.id,
      expected.registration.route.revisionDigest,
      expected.scope.digest,
      'idle-unload',
      String(Date.now()),
      String(++this.transactionCounter),
    ])
    const request: AcquireModelRouteRequest = {
      sessionId: expected.scope.sessionId,
      selection: expected.registration.route.selection,
    }
    let context: ModelLifecycleStageContext | undefined
    const receipts: ModelLifecycleStageReceipt[] = []
    let stopAttempted = false
    let stoppedVerified = false
    let unloadVerified = false
    try {
      context = this.stageContext(
        expected.registration,
        expected.target,
        request,
        expected.scope,
        transactionDigest,
        'IDLE_UNLOAD',
      )
      const prestate = await this.runStage('prestate', context, bounded =>
        expected.registration.driver.capturePrestate(bounded))
      assertStageReceipt('prestate', prestate, context)
      this.assertResidency(prestate, expected)
      receipts.push(prestate)
      this.phase = 'DRAINING'
      stopAttempted = true
      const stopped = await this.runStage('stop', context, bounded => expected.registration.driver.stop(bounded))
      assertStageReceipt('stop', stopped, context)
      receipts.push(stopped)
      const verified = await this.runStage('verify-stopped', context, bounded =>
        expected.registration.driver.verifyStopped(bounded))
      assertStageReceipt('verify-stopped', verified, context)
      receipts.push(verified)
      stoppedVerified = true
      this.active = undefined
      this.phase = 'IDLE'
      unloadVerified = true
      await this.record(authority, {
        transactionDigest,
        scopeDigest: expected.scope.digest,
        routeId: expected.registration.route.id,
        target: expected.target,
        outcome: 'IDLE_UNLOADED',
        receiptDigests: receipts.map(receipt => receipt.digest),
      })
    } catch (error: unknown) {
      if (this.resourceLease?.signal.aborted === true || (error instanceof ModelLifecycleError && error.code === 'STAGE_TIMEOUT')) {
        this.active = undefined
        this.tainted = true
      } else if (context !== undefined && !unloadVerified && stopAttempted) {
        if (!stoppedVerified) {
          try {
            const verified = await this.runStage('verify-stopped', context, bounded =>
              expected.registration.driver.verifyStopped(bounded))
            assertStageReceipt('verify-stopped', verified, context)
            receipts.push(verified)
            stoppedVerified = true
          } catch {
            this.active = undefined
            this.tainted = true
          }
        }
        if (stoppedVerified && !this.tainted) {
          this.active = undefined
          try {
            const started = await this.runStage('start', context, bounded =>
              expected.registration.driver.start(bounded))
            assertStageReceipt('start', started, context)
            receipts.push(started)
            const health = await this.runStage('health', context, bounded =>
              expected.registration.driver.health(bounded))
            assertHealthReceipt('health', health, context)
            if (!health.ok) throw new Error(`idle-unload restore failed health: ${health.reason}`)
            receipts.push(health.receipt)
            const probe = await this.runStage('probe', context, bounded => expected.registration.driver.probe(bounded))
            assertHealthReceipt('probe', probe, context)
            if (!probe.ok) throw new Error(`idle-unload restore failed probe: ${probe.reason}`)
            receipts.push(probe.receipt)
            this.active = { ...expected, healthDigest: probe.receipt.digest }
          } catch {
            this.active = undefined
            this.tainted = true
          }
        }
      }
      this.phase = this.tainted ? 'TAINTED' : this.active === undefined ? 'IDLE' : 'READY'
      await this.recordBestEffort(authority, {
        transactionDigest,
        scopeDigest: expected.scope.digest,
        routeId: expected.registration.route.id,
        target: expected.target,
        outcome: this.tainted ? 'TAINTED' : 'REJECTED',
        receiptDigests: receipts.map(receipt => receipt.digest),
        errorCode: error instanceof ModelLifecycleError ? error.code : 'STOP_FAILED',
      })
    } finally {
      if (this.tainted || this.active === undefined) await this.releaseResources(this.tainted ? 'UNCERTAIN' : 'SETTLED')
      release()
    }
  }

  private async acquire(signal: AbortSignal | undefined, inference = false): Promise<() => void> {
    abortIfRequested(signal)
    if (!this.slotLocked) {
      this.slotLocked = true
    } else {
      const { maxPendingRequests, queueTimeoutMs } = this.settings()
      if (inference && this.waiters.length >= maxPendingRequests) {
        throw new ModelLifecycleError('QUEUE_FULL', 'Local model queue is full; retry after a request completes')
      }
      // Remove cancelled/expired entries immediately; chained promises retain them until the active stream ends.
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const cleanup = (): void => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        }
        const grant = (): void => {
          cleanup()
          resolve()
        }
        const cancel = (error: ModelLifecycleError): void => {
          const index = this.waiters.indexOf(grant)
          if (index < 0) return
          this.waiters.splice(index, 1)
          cleanup()
          reject(error)
        }
        const onAbort = (): void => {
          cancel(new ModelLifecycleError('ABORTED', 'Local model inference was cancelled'))
        }
        this.waiters.push(grant)
        if (inference) timer = setTimeout(() => {
          cancel(new ModelLifecycleError('QUEUE_TIMEOUT', 'Local model queue wait timed out; the active request was not stopped'))
        }, queueTimeoutMs)
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted === true) onAbort()
      })
    }
    try {
      abortIfRequested(signal)
    } catch (error: unknown) {
      this.releaseSlot()
      throw error
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.releaseSlot()
    }
  }

  private releaseSlot(): void {
    const next = this.waiters.shift()
    if (next === undefined) this.slotLocked = false
    else next()
  }
}

export default ModelLifecycleRuntime
