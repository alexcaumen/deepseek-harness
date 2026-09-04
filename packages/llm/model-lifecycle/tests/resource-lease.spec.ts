import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResourceLeaseError, ResourceLeaseSession, ResourceLeaseRef, ResourceLeaseIssuerRef, ResourceLeaseHolderRef } from '../src/resource-lease.ts'
import type { ResourceLeaseGrant, ResourceLeaseProvider, ResourceLeaseTarget } from '../src/resource-lease.ts'

const START = 1_800_000_000_000
const TIMEOUT = 50
const MAX_TIMER_MS = 2_147_483_647
const digest = (digit: string): string => `sha256:${digit.repeat(64)}`
const sessions: ResourceLeaseSession[] = []

function grant(overrides: Partial<ResourceLeaseGrant> = {}): ResourceLeaseGrant {
  return {
    leaseRef: ResourceLeaseRef('lease-1'),
    issuerRef: ResourceLeaseIssuerRef('issuer-1'),
    holderRef: ResourceLeaseHolderRef('holder-1'),
    targets: ['r5300', 'ram-cpu'],
    fencingDigest: digest('a'),
    receiptDigest: digest('b'),
    expiresAt: Date.now() + 1_000,
    renewAfterMs: 100,
    ...overrides,
  }
}

function provider(initial = grant()) {
  let sequence = 0
  return {
    acquire: vi.fn<ResourceLeaseProvider['acquire']>().mockResolvedValue(initial),
    renew: vi.fn<ResourceLeaseProvider['renew']>().mockImplementation(async previous => ({
      ...previous,
      expiresAt: previous.expiresAt + 1_000,
      receiptDigest: `sha256:${(++sequence).toString(16).padStart(64, '0')}`,
    })),
    release: vi.fn<ResourceLeaseProvider['release']>().mockResolvedValue(undefined),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function acquire(
  adapter: ResourceLeaseProvider,
  targets: readonly ResourceLeaseTarget[] = ['r5300', 'ram-cpu'],
  timeoutMs = TIMEOUT,
): Promise<ResourceLeaseSession> {
  const session = await ResourceLeaseSession.acquire(adapter, targets, timeoutMs)
  sessions.push(session)
  return session
}

function expectLost(session: ResourceLeaseSession): void {
  expect(session.signal.aborted).toBe(true)
  expect(session.signal.reason).toBeInstanceOf(ResourceLeaseError)
  expect(session.signal.reason).toMatchObject({ code: 'RESOURCE_LEASE_LOST', message: 'Resource lease was lost' })
  expect(session.signal.reason).not.toHaveProperty('cause')
  expect(() => session.current()).toThrow(session.signal.reason)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})

afterEach(async () => {
  const closing = Promise.all(sessions.splice(0).map(session => session.close('UNCERTAIN')))
  await vi.runAllTimersAsync()
  await closing
  expect(vi.getTimerCount()).toBe(0)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('staging resource lease consumer', () => {
  it('freezes detached grants and requests, renews at provider intervals, and replaces the expiry watchdog', async () => {
    const targets: ResourceLeaseTarget[] = ['r5300', 'ram-cpu']
    const original = { ...grant(), targets: [...targets] }
    const adapter = provider(original)
    const renewed = { ...grant(), targets: ['ram-cpu', 'r5300'] as ResourceLeaseTarget[], expiresAt: START + 2_000, renewAfterMs: 1_100, receiptDigest: digest('c') }
    adapter.renew.mockResolvedValueOnce(renewed)
    const session = await acquire(adapter, targets)
    const first = session.current()
    const request = adapter.acquire.mock.calls[0]![0]
    expect(Object.isFrozen(request)).toBe(true)
    expect(Object.isFrozen(request.targets)).toBe(true)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.targets)).toBe(true)
    targets.push('prdg')
    original.targets.push('prdg')
    original.leaseRef = ResourceLeaseRef('mutated')
    expect(first.leaseRef).toBe('lease-1')
    expect(first.targets).toEqual(['r5300', 'ram-cpu'])

    await vi.advanceTimersByTimeAsync(99)
    expect(adapter.renew).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(adapter.renew).toHaveBeenCalledWith(first, expect.any(AbortSignal))
    const second = session.current()
    expect(second.expiresAt).toBe(START + 2_000)
    expect(Object.isFrozen(second)).toBe(true)
    expect(Object.isFrozen(second.targets)).toBe(true)
    renewed.targets.push('prdg')
    renewed.holderRef = ResourceLeaseHolderRef('mutated')
    expect(second.targets).toEqual(['ram-cpu', 'r5300'])
    expect(second.holderRef).toBe('holder-1')
    await vi.advanceTimersByTimeAsync(1_099)
    expect(session.signal.aborted).toBe(false)
    expect(adapter.renew).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(adapter.renew).toHaveBeenCalledTimes(2)
    const latest = session.current()
    expect(latest.expiresAt).toBe(START + 3_000)
    await session.close('SETTLED')
    expect(adapter.release).toHaveBeenCalledWith(latest, 'SETTLED', expect.any(AbortSignal))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('expires independently while renewal hangs and retains the last grant for uncertain release', async () => {
    const pending = deferred<ResourceLeaseGrant>()
    const adapter = provider()
    adapter.renew.mockReturnValue(pending.promise)
    const session = await acquire(adapter, undefined, 2_000)
    const accepted = session.current()
    await vi.advanceTimersByTimeAsync(100)
    const signal = adapter.renew.mock.calls[0]![1]
    await vi.advanceTimersByTimeAsync(899)
    expect(session.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expectLost(session)
    expect(signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await session.close('SETTLED')
    expect(adapter.release).toHaveBeenCalledWith(accepted, 'UNCERTAIN', expect.any(AbortSignal))
    pending.resolve(grant({ expiresAt: START + 5_000, receiptDigest: digest('c') }))
    await vi.advanceTimersByTimeAsync(0)
    expectLost(session)
    expect(adapter.release).toHaveBeenCalledTimes(1)
    expect(adapter.renew).toHaveBeenCalledTimes(1)
  })

  it('aborts a timed-out renewal before expiry and consumes a late rejection', async () => {
    const pending = deferred<ResourceLeaseGrant>()
    const adapter = provider()
    adapter.renew.mockReturnValue(pending.promise)
    const session = await acquire(adapter)
    await vi.advanceTimersByTimeAsync(149)
    expect(session.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expectLost(session)
    expect(adapter.renew.mock.calls[0]![1].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    pending.reject(new Error('private-provider-details'))
    await vi.advanceTimersByTimeAsync(0)
    await session.close('UNCERTAIN')
  })

  it.each(['throw', 'reject'] as const)('sanitizes a provider renewal %s', async (kind) => {
    const adapter = provider()
    const privateError = new Error('private issuer and credentials')
    adapter.renew.mockImplementation(() => {
      if (kind === 'throw') throw privateError
      return Promise.reject(privateError)
    })
    const session = await acquire(adapter)
    await vi.advanceTimersByTimeAsync(100)
    expectLost(session)
    expect(session.signal.reason).not.toBe(privateError)
    await session.close('SETTLED')
    expect(adapter.release.mock.calls[0]![1]).toBe('UNCERTAIN')
  })

  it.each([
    ['lease identity', { leaseRef: ResourceLeaseRef('lease-2') }],
    ['issuer identity', { issuerRef: ResourceLeaseIssuerRef('issuer-2') }],
    ['holder identity', { holderRef: ResourceLeaseHolderRef('holder-2') }],
    ['fence', { fencingDigest: digest('d') }],
    ['missing target', { targets: ['r5300'] }],
    ['extra target', { targets: ['r5300', 'ram-cpu', 'prdg'] }],
    ['replacement target', { targets: ['r5300', 'prdg'] }],
    ['duplicate target', { targets: ['r5300', 'r5300'] }],
    ['stale expiry', { expiresAt: START + 100 }],
    ['unchanged expiry', { expiresAt: START + 1_000 }],
    ['shorter expiry', { expiresAt: START + 900 }],
    ['unchanged receipt', { receiptDigest: digest('b') }],
    ['invalid digest', { receiptDigest: digest('C') }],
    ['invalid interval', { renewAfterMs: 2_000 }],
  ] satisfies [string, Partial<ResourceLeaseGrant>][])('loses renewal on %s without replacing the accepted grant', async (_name, patch) => {
    const adapter = provider()
    adapter.renew.mockResolvedValue(grant({ expiresAt: START + 2_000, receiptDigest: digest('c'), ...patch }))
    const session = await acquire(adapter)
    const accepted = session.current()
    await vi.advanceTimersByTimeAsync(100)
    expectLost(session)
    await session.close('SETTLED')
    expect(adapter.release).toHaveBeenCalledWith(accepted, 'UNCERTAIN', expect.any(AbortSignal))
  })

  it('rejects a replay after an accepted renewal', async () => {
    const initial = grant()
    const adapter = provider(initial)
    adapter.renew.mockResolvedValueOnce(grant({ expiresAt: START + 2_000, receiptDigest: digest('c') })).mockResolvedValueOnce(initial)
    const session = await acquire(adapter)
    await vi.advanceTimersByTimeAsync(100)
    const accepted = session.current()
    await vi.advanceTimersByTimeAsync(100)
    expectLost(session)
    await session.close('UNCERTAIN')
    expect(adapter.release.mock.calls[0]![0]).toEqual(accepted)
  })

  it('checks expiry synchronously when timers have not dispatched', async () => {
    const adapter = provider()
    const session = await acquire(adapter)
    vi.setSystemTime(START + 1_000)
    expect(() => session.current()).toThrow(ResourceLeaseError)
    expectLost(session)
    expect(vi.getTimerCount()).toBe(0)
    await session.close('SETTLED')
    expect(adapter.release.mock.calls[0]![1]).toBe('UNCERTAIN')
  })

  it('does not let a renewal arriving after old expiry revive a session before watchdog dispatch', async () => {
    const pending = deferred<ResourceLeaseGrant>()
    const adapter = provider()
    adapter.renew.mockReturnValue(pending.promise)
    const session = await acquire(adapter, undefined, 2_000)
    await vi.advanceTimersByTimeAsync(100)
    vi.setSystemTime(START + 1_000)
    pending.resolve(grant({ receiptDigest: digest('c') }))
    await vi.advanceTimersByTimeAsync(0)
    expectLost(session)
  })

  it('closes once, cancels renewal, awaits release and ignores a late renewal result', async () => {
    const renewal = deferred<ResourceLeaseGrant>()
    const release = deferred<undefined>()
    const adapter = provider()
    adapter.renew.mockReturnValue(renewal.promise)
    adapter.release.mockReturnValue(release.promise)
    const session = await acquire(adapter)
    const accepted = session.current()
    await vi.advanceTimersByTimeAsync(100)
    let done = false
    const closing = session.close('SETTLED')
    void closing.then(() => { done = true })
    expect(session.close('UNCERTAIN')).toBe(closing)
    expectLost(session)
    expect(adapter.renew.mock.calls[0]![1].aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(false)
    expect(adapter.release).toHaveBeenCalledWith(accepted, 'SETTLED', expect.any(AbortSignal))
    expect(vi.getTimerCount()).toBe(1)
    renewal.resolve(grant({ expiresAt: START + 2_000, receiptDigest: digest('c') }))
    await vi.advanceTimersByTimeAsync(0)
    release.resolve(undefined)
    await closing
    expect(done).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(adapter.renew).toHaveBeenCalledTimes(1)
    expect(adapter.release).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a hanging release and consumes its late rejection', async () => {
    const pending = deferred<undefined>()
    const adapter = provider()
    adapter.release.mockReturnValue(pending.promise)
    const session = await acquire(adapter)
    const closing = session.close('UNCERTAIN')
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    await closing
    expect(adapter.release.mock.calls[0]![2].aborted).toBe(true)
    pending.reject(new Error('private-release-error'))
    await vi.advanceTimersByTimeAsync(0)
    expect(session.close('SETTLED')).toBe(closing)
    expect(adapter.release).toHaveBeenCalledTimes(1)
  })

  it('cancels scheduled renewal before any provider renewal starts, including reentrant close', async () => {
    const adapter = provider()
    const session = await acquire(adapter)
    let reentrant: Promise<void> | undefined
    session.signal.addEventListener('abort', () => { reentrant = session.close('UNCERTAIN') }, { once: true })
    const closing = session.close('SETTLED')
    expect(reentrant).toBe(closing)
    await closing
    await vi.advanceTimersByTimeAsync(2_000)
    expect(adapter.renew).not.toHaveBeenCalled()
    expect(adapter.release).toHaveBeenCalledTimes(1)
    expect(adapter.release.mock.calls[0]![1]).toBe('SETTLED')
  })

  it('cancels renewal between its timer firing and provider dispatch', async () => {
    const adapter = provider()
    const session = await acquire(adapter)
    vi.advanceTimersByTime(100)
    await session.close('SETTLED')
    expect(adapter.renew).not.toHaveBeenCalled()
    expect(adapter.release).toHaveBeenCalledTimes(1)
    expectLost(session)
  })

  it('rejects acquisition when the clock consumes its renewal window during setup', async () => {
    const adapter = provider(grant({ expiresAt: START + 4, renewAfterMs: 1 }))
    let now = START
    vi.spyOn(Date, 'now').mockImplementation(() => now++)
    await expect(acquire(adapter)).rejects.toHaveProperty('code', 'RESOURCE_LEASE_UNAVAILABLE')
    expect(adapter.release).toHaveBeenCalledTimes(1)
    expect(adapter.release.mock.calls[0]![1]).toBe('UNCERTAIN')
    expect(adapter.renew).not.toHaveBeenCalled()
  })

  it.each([
    null,
    { ...grant(), targets: 'r5300' },
    { ...grant(), targets: ['unknown-target'] },
    { ...grant(), leaseRef: 7 },
    { ...grant(), fencingDigest: 7 },
  ])('sanitizes malformed data at the provider boundary: %j', async (value) => {
    const adapter = provider(value as unknown as ResourceLeaseGrant)
    await expect(acquire(adapter)).rejects.toEqual(new ResourceLeaseError('RESOURCE_LEASE_UNAVAILABLE'))
    expect(adapter.renew).not.toHaveBeenCalled()
  })

  it.each([
    ['empty lease', { leaseRef: ResourceLeaseRef('') }],
    ['blank issuer', { issuerRef: ResourceLeaseIssuerRef('  ') }],
    ['empty holder', { holderRef: ResourceLeaseHolderRef('') }],
    ['uppercase fence', { fencingDigest: digest('A') }],
    ['short receipt', { receiptDigest: 'sha256:abc' }],
    ['unprefixed receipt', { receiptDigest: 'a'.repeat(64) }],
    ['no targets', { targets: [] }],
    ['expired', { expiresAt: START }],
    ['past expiry', { expiresAt: START - 1 }],
    ['infinite expiry', { expiresAt: Infinity }],
    ['fractional expiry', { expiresAt: START + 1_000.5 }],
    ['overflowing expiry', { expiresAt: START + MAX_TIMER_MS + 1 }],
    ['zero renewal interval', { renewAfterMs: 0 }],
    ['negative renewal interval', { renewAfterMs: -1 }],
    ['NaN renewal interval', { renewAfterMs: NaN }],
    ['infinite renewal interval', { renewAfterMs: Infinity }],
    ['renewal at expiry', { renewAfterMs: 1_000 }],
    ['renewal after expiry', { renewAfterMs: 1_001 }],
  ] satisfies [string, Partial<ResourceLeaseGrant>][])('rejects a bad initial grant: %s', async (_name, patch) => {
    const adapter = provider(grant(patch))
    await expect(acquire(adapter)).rejects.toMatchObject({ code: 'RESOURCE_LEASE_UNAVAILABLE', message: 'Resource lease is unavailable' })
    expect(adapter.renew).not.toHaveBeenCalled()
    expect(adapter.release).toHaveBeenCalledTimes(1)
    expect(adapter.release.mock.calls[0]![1]).toBe('UNCERTAIN')
  })

  it.each([
    ['missing', ['r5300']],
    ['extra', ['r5300', 'ram-cpu', 'prdg']],
    ['different', ['r5300', 'prdg']],
    ['duplicate', ['r5300', 'r5300']],
  ] satisfies [string, ResourceLeaseTarget[]][])('rejects %s target coverage on acquisition', async (_name, targets) => {
    const adapter = provider(grant({ targets }))
    await expect(acquire(adapter)).rejects.toHaveProperty('code', 'RESOURCE_LEASE_UNAVAILABLE')
  })

  it('accepts all requested targets in any order without implying they will all be used', async () => {
    const adapter = provider(grant({ targets: ['ram-cpu', 'prdg', 'r5300'] }))
    const session = await acquire(adapter, ['r5300', 'prdg', 'ram-cpu'])
    expect(session.current().targets).toEqual(['ram-cpu', 'prdg', 'r5300'])
    await session.close('SETTLED')
    expect(adapter.release.mock.calls[0]![1]).toBe('SETTLED')
  })

  it.each([{ targets: [] }, { targets: ['r5300', 'r5300'] }] satisfies { targets: ResourceLeaseTarget[] }[])('rejects invalid requested targets $targets before calling provider', async ({ targets }) => {
    const adapter = provider()
    await expect(acquire(adapter, targets)).rejects.toHaveProperty('code', 'RESOURCE_LEASE_UNAVAILABLE')
    expect(adapter.acquire).not.toHaveBeenCalled()
  })

  it.each([0, -1, NaN, Infinity, MAX_TIMER_MS + 1])('rejects an unsafe operation timeout %s before calling provider', async (timeoutMs) => {
    const adapter = provider()
    await expect(acquire(adapter, undefined, timeoutMs)).rejects.toHaveProperty('code', 'RESOURCE_LEASE_UNAVAILABLE')
    expect(adapter.acquire).not.toHaveBeenCalled()
  })

  it.each(['throw', 'reject'] as const)('sanitizes an acquisition %s', async (kind) => {
    const adapter = provider()
    adapter.acquire.mockImplementation(() => {
      const error = new Error('private-acquisition-error')
      if (kind === 'throw') throw error
      return Promise.reject(error)
    })
    await expect(acquire(adapter)).rejects.toEqual(new ResourceLeaseError('RESOURCE_LEASE_UNAVAILABLE'))
    expect(adapter.release).not.toHaveBeenCalled()
  })

  it('times out acquisition and bounds UNCERTAIN cleanup of a late grant even after its expiry', async () => {
    const pending = deferred<ResourceLeaseGrant>()
    const release = deferred<undefined>()
    const adapter = provider()
    adapter.acquire.mockReturnValue(pending.promise)
    adapter.release.mockReturnValue(release.promise)
    const acquiring = expect(acquire(adapter)).rejects.toEqual(new ResourceLeaseError('RESOURCE_LEASE_UNAVAILABLE'))
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    await acquiring
    expect(adapter.acquire.mock.calls[0]![1].aborted).toBe(true)
    expect(adapter.release).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    const late = grant({ expiresAt: START })
    pending.resolve(late)
    await vi.advanceTimersByTimeAsync(0)
    expect(adapter.release).toHaveBeenCalledWith(late, 'UNCERTAIN', expect.any(AbortSignal))
    expect(Object.isFrozen(adapter.release.mock.calls[0]![0])).toBe(true)
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(adapter.release.mock.calls[0]![2].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    release.reject(new Error('private-late-release-error'))
    await vi.advanceTimersByTimeAsync(0)
    expect(adapter.release).toHaveBeenCalledTimes(1)
  })

  it('contains a late acquisition rejection', async () => {
    const pending = deferred<ResourceLeaseGrant>()
    const adapter = provider()
    adapter.acquire.mockReturnValue(pending.promise)
    const acquiring = expect(acquire(adapter)).rejects.toHaveProperty('code', 'RESOURCE_LEASE_UNAVAILABLE')
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    await acquiring
    pending.reject(new Error('private-late-acquisition-error'))
    await vi.advanceTimersByTimeAsync(0)
    expect(adapter.release).not.toHaveBeenCalled()
  })

  it('checks the acquisition deadline on settlement even if its timer has not dispatched', async () => {
    const pending = deferred<ResourceLeaseGrant>()
    const adapter = provider()
    adapter.acquire.mockReturnValue(pending.promise)
    const acquiring = expect(acquire(adapter)).rejects.toHaveProperty('code', 'RESOURCE_LEASE_UNAVAILABLE')
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(START + TIMEOUT)
    pending.resolve(grant())
    await vi.advanceTimersByTimeAsync(0)
    await acquiring
    expect(adapter.release).toHaveBeenCalledTimes(1)
    expect(adapter.release.mock.calls[0]![1]).toBe('UNCERTAIN')
  })
})
