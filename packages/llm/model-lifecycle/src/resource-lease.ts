/**
 * STAGING-ONLY local lease consumer, not a canonical wire protocol or authority.
 * The provider verifies issuer, holder, physical coverage, and fencing before
 * returning grants. This helper neither mints nor admits grants. Cancellation
 * and release do not prove that remote jobs stopped. Providers must cooperate
 * with AbortSignal: an outstanding call that ignores cancellation can outlive
 * its deadline, with its eventual settlement consumed here. A late acquisition
 * additionally receives one bounded UNCERTAIN release attempt.
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Logical target labels; the provider binds them to physical resources. */
export type ResourceLeaseTarget = 'r5300' | 'prdg' | 'ram-cpu'

/** Opaque lease reference decoded by the provider adapter. */
export type ResourceLeaseRef = Branded<'ResourceLeaseRef'>
/** Opaque issuing-authority reference decoded by the provider adapter. */
export type ResourceLeaseIssuerRef = Branded<'ResourceLeaseIssuerRef'>
/** Opaque holder reference decoded by the provider adapter. */
export type ResourceLeaseHolderRef = Branded<'ResourceLeaseHolderRef'>

/**
 * Type a provider-decoded reference; this does not authorize a lease.
 * @param value - Provider-decoded reference.
 * @returns The nominal lease reference.
 */
export const ResourceLeaseRef = (value: string): ResourceLeaseRef => value as ResourceLeaseRef
/**
 * Type a provider-decoded issuer; this does not verify its authority.
 * @param value - Provider-decoded issuer reference.
 * @returns The nominal issuer reference.
 */
export const ResourceLeaseIssuerRef = (value: string): ResourceLeaseIssuerRef => value as ResourceLeaseIssuerRef
/**
 * Type a provider-decoded holder; this does not authenticate the caller.
 * @param value - Provider-decoded holder reference.
 * @returns The nominal holder reference.
 */
export const ResourceLeaseHolderRef = (value: string): ResourceLeaseHolderRef => value as ResourceLeaseHolderRef

/** Provider-verified grant; digests use lowercase `sha256:<64 hex>` notation. */
export interface ResourceLeaseGrant {
  readonly leaseRef: ResourceLeaseRef
  readonly issuerRef: ResourceLeaseIssuerRef
  readonly holderRef: ResourceLeaseHolderRef
  readonly targets: readonly ResourceLeaseTarget[]
  readonly fencingDigest: string
  readonly receiptDigest: string
  /** Absolute Unix expiry in milliseconds. */
  readonly expiresAt: number
  /** Delay from receipt until the next renewal attempt. */
  readonly renewAfterMs: number
}

/** Provider adapter for already-authorized grants, not consumer-side policy. */
export interface ResourceLeaseProvider {
  /**
   * Obtain a verified grant covering exactly the requested targets.
   * @param request - Nonempty, duplicate-free target coverage.
   * @param signal - Cancellation when the local operation deadline expires.
   * @returns An externally authorized grant.
   */
  acquire(request: { targets: readonly ResourceLeaseTarget[] }, signal: AbortSignal): Promise<ResourceLeaseGrant>
  /**
   * Extend expiry with a new receipt, preserving identity, fencing and coverage.
   * @param grant - Last accepted immutable grant.
   * @param signal - Cancellation on timeout, expiry, or session close.
   * @returns A grant whose expiry strictly advances the previous expiry.
   */
  renew(grant: ResourceLeaseGrant, signal: AbortSignal): Promise<ResourceLeaseGrant>
  /**
   * Release a grant without implying that this operation stops remote jobs.
   * @param grant - Last accepted grant, or an unconsumed acquisition result.
   * @param outcome - SETTLED attests local owned work is quiescent; otherwise UNCERTAIN.
   * @param signal - Cancellation when the release deadline expires.
   */
  release(grant: ResourceLeaseGrant, outcome: 'SETTLED' | 'UNCERTAIN', signal: AbortSignal): Promise<void>
}

/** Observe the actual settlement of one provider call, including late results. */
export type ResourceLeaseOperationObserver = (operation: Promise<unknown>) => void

/** Sanitized failure without provider messages, causes, references, or digests. */
export class ResourceLeaseError extends Error {
  constructor(readonly code: 'RESOURCE_LEASE_UNAVAILABLE' | 'RESOURCE_LEASE_LOST') {
    super(code === 'RESOURCE_LEASE_UNAVAILABLE' ? 'Resource lease is unavailable' : 'Resource lease was lost')
    this.name = 'ResourceLeaseError'
  }
}

const MAX_TIMER_MS = 2_147_483_647
const DIGEST = /^sha256:[a-f0-9]{64}$/u

function timerSafe(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS
}

function validTargets(targets: readonly ResourceLeaseTarget[]): boolean {
  return Array.isArray(targets) && targets.length > 0
    && targets.every(target => target === 'r5300' || target === 'prdg' || target === 'ram-cpu')
    && new Set(targets).size === targets.length
}

function copyGrant(grant: ResourceLeaseGrant): ResourceLeaseGrant {
  const targets = grant.targets
  if (!Array.isArray(grant.targets)) throw new ResourceLeaseError('RESOURCE_LEASE_UNAVAILABLE')
  return Object.freeze({
    leaseRef: grant.leaseRef,
    issuerRef: grant.issuerRef,
    holderRef: grant.holderRef,
    targets: Object.freeze([...targets]),
    fencingDigest: grant.fencingDigest,
    receiptDigest: grant.receiptDigest,
    expiresAt: grant.expiresAt,
    renewAfterMs: grant.renewAfterMs,
  })
}

function validateGrant(
  value: ResourceLeaseGrant,
  targets: readonly ResourceLeaseTarget[],
  previous?: ResourceLeaseGrant,
): ResourceLeaseGrant {
  const grant = copyGrant(value)
  const remaining = grant.expiresAt - Date.now()
  if (
    ![grant.leaseRef, grant.issuerRef, grant.holderRef].every(ref => typeof ref === 'string' && ref.trim().length > 0)
    || ![grant.fencingDigest, grant.receiptDigest].every(digest => typeof digest === 'string' && DIGEST.test(digest))
    || !validTargets(grant.targets)
    || grant.targets.length !== targets.length
    || !targets.every(target => grant.targets.includes(target))
    || !Number.isSafeInteger(grant.expiresAt) || !timerSafe(remaining)
    || !timerSafe(grant.renewAfterMs) || grant.renewAfterMs >= remaining
    || (previous !== undefined && (
      grant.leaseRef !== previous.leaseRef || grant.issuerRef !== previous.issuerRef
      || grant.holderRef !== previous.holderRef || grant.fencingDigest !== previous.fencingDigest
      || grant.expiresAt <= previous.expiresAt || grant.receiptDigest === previous.receiptDigest
    ))
  ) throw new ResourceLeaseError(previous === undefined ? 'RESOURCE_LEASE_UNAVAILABLE' : 'RESOURCE_LEASE_LOST')
  return grant
}

function boundedCall<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  code: ResourceLeaseError['code'],
  signal?: AbortSignal,
  onLateValue?: (value: T) => Promise<void>,
  observe?: ResourceLeaseOperationObserver,
): Promise<T> {
  const error = new ResourceLeaseError(code)
  if (signal?.aborted === true) return Promise.reject(error)
  const controller = new AbortController()
  const deadline = Date.now() + timeoutMs
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(cancel, Math.ceil(timeoutMs))
    function cleanup(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
    function cancel(): void {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
      controller.abort(error)
    }
    signal?.addEventListener('abort', cancel, { once: true })
    // Both late resolutions and rejections remain observed after local timeout.
    void Promise.resolve().then(() => {
      if (settled) throw error
      const actual = Promise.resolve().then(() => operation(controller.signal))
      observe?.(actual)
      return actual
    }).then(async (value) => {
      if (Date.now() >= deadline) cancel()
      if (settled) {
        await onLateValue?.(value)
        return
      }
      settled = true
      cleanup()
      resolve(value)
    }, cancel).catch(cancel)
  })
}

async function releaseBestEffort(
  provider: ResourceLeaseProvider,
  grant: ResourceLeaseGrant,
  outcome: 'SETTLED' | 'UNCERTAIN',
  timeoutMs: number,
  observe?: ResourceLeaseOperationObserver,
): Promise<void> {
  try {
    await boundedCall(
      signal => provider.release(copyGrant(grant), outcome, signal),
      timeoutMs,
      'RESOURCE_LEASE_LOST',
      undefined,
      undefined,
      observe,
    )
  } catch {
    // Release failures and timeouts are contained; remote cleanup is unproven.
  }
}

/**
 * One staging-only local consumer. Call close even after loss to attempt release.
 * Owns renewal and expiry timers, not remote execution or resource admission.
 */
export class ResourceLeaseSession {
  private readonly lifetime = new AbortController()
  /** Aborted with a sanitized ResourceLeaseError on loss or local close. */
  readonly signal = this.lifetime.signal
  private renewalTimer: ReturnType<typeof setTimeout> | undefined
  private expiryTimer: ReturnType<typeof setTimeout> | undefined
  private renewal: Promise<void> | undefined
  private renewalMayBeInFlight = false
  private closing: Promise<void> | undefined

  private constructor(
    private readonly provider: ResourceLeaseProvider,
    private grant: ResourceLeaseGrant,
    private readonly operationTimeoutMs: number,
    private readonly observe?: ResourceLeaseOperationObserver,
  ) {
    this.schedule()
  }

  /**
   * Acquire and validate a provider-verified grant with bounded waiting.
   * @param provider - External authorization and lease mechanics adapter.
   * @param targets - Exact nonempty, duplicate-free coverage required locally.
   * @param operationTimeoutMs - Positive timer-safe bound for each provider call.
   * @param signal - Optional caller cancellation propagated to acquisition.
   * @param observe - Optional observer for the provider call's actual settlement.
   * @returns An immutable-grant session, or a sanitized UNAVAILABLE rejection.
   */
  static async acquire(
    provider: ResourceLeaseProvider,
    targets: readonly ResourceLeaseTarget[],
    operationTimeoutMs: number,
    signal?: AbortSignal,
    observe?: ResourceLeaseOperationObserver,
  ): Promise<ResourceLeaseSession> {
    if (!validTargets(targets) || !timerSafe(operationTimeoutMs)) {
      throw new ResourceLeaseError('RESOURCE_LEASE_UNAVAILABLE')
    }
    const request = Object.freeze({ targets: Object.freeze([...targets]) })
    const value = await boundedCall(
      signal => provider.acquire(request, signal),
      operationTimeoutMs,
      'RESOURCE_LEASE_UNAVAILABLE',
      signal,
      late => releaseBestEffort(provider, late, 'UNCERTAIN', operationTimeoutMs, observe),
      observe,
    )
    try {
      const grant = validateGrant(value, request.targets)
      const session = new ResourceLeaseSession(provider, grant, operationTimeoutMs, observe)
      session.current()
      return session
    } catch {
      // An unusable acquisition result can still own a remote reservation.
      await releaseBestEffort(provider, value, 'UNCERTAIN', operationTimeoutMs, observe)
      throw new ResourceLeaseError('RESOURCE_LEASE_UNAVAILABLE')
    }
  }

  /**
   * Read the last accepted grant; expiry is checked even before timers dispatch.
   * @returns The frozen current grant, or throws a sanitized LOST error.
   */
  current(): ResourceLeaseGrant {
    if (Date.now() >= this.grant.expiresAt) this.lose()
    if (this.signal.aborted) throw this.signal.reason
    return this.grant
  }

  /**
   * Cancel owned timers and renewal, then await one bounded best-effort release.
   * Repeated calls share the first close promise and outcome; loss forces
   * UNCERTAIN. Provider failures are suppressed, not evidence of remote cleanup.
   * Only provider calls ignoring their AbortSignal can remain outstanding.
   * SETTLED attests local quiescence, not empty remote memory or permission to
   * reassign targets. Deployment must reconcile physical residency and fences.
   * @param outcome - SETTLED only after all locally owned work is quiescent.
   * @returns Completion of local teardown and the bounded release attempt.
   */
  close(outcome: 'SETTLED' | 'UNCERTAIN'): Promise<void> {
    if (this.closing !== undefined) return this.closing
    const releaseOutcome = this.signal.aborted || Date.now() >= this.grant.expiresAt || this.renewalMayBeInFlight
      ? 'UNCERTAIN'
      : outcome
    this.closing = Promise.resolve().then(async () => {
      await this.renewal
      await releaseBestEffort(this.provider, this.grant, releaseOutcome, this.operationTimeoutMs, this.observe)
    })
    this.lose()
    return this.closing
  }

  private lose(): void {
    clearTimeout(this.renewalTimer)
    clearTimeout(this.expiryTimer)
    this.lifetime.abort(new ResourceLeaseError('RESOURCE_LEASE_LOST'))
  }

  private schedule(): void {
    clearTimeout(this.renewalTimer)
    clearTimeout(this.expiryTimer)
    this.renewalMayBeInFlight = false
    const remaining = this.grant.expiresAt - Date.now()
    if (!timerSafe(remaining) || remaining <= this.grant.renewAfterMs) {
      this.lose()
      return
    }
    this.expiryTimer = setTimeout(() => { this.lose() }, Math.ceil(remaining))
    this.renewalTimer = setTimeout(() => {
      this.renewalMayBeInFlight = true
      this.renewal = this.renew()
    }, Math.ceil(this.grant.renewAfterMs))
  }

  private async renew(): Promise<void> {
    try {
      const previous = this.current()
      const value = await boundedCall(
        signal => this.provider.renew(previous, signal),
        this.operationTimeoutMs,
        'RESOURCE_LEASE_LOST',
        this.signal,
        late => releaseBestEffort(
          this.provider,
          late,
          'UNCERTAIN',
          this.operationTimeoutMs,
          this.observe,
        ),
        this.observe,
      )
      this.current()
      this.grant = validateGrant(value, previous.targets, previous)
      this.schedule()
    } catch {
      // Provider and validation failures share the same sanitized loss signal.
      this.lose()
    }
  }
}
