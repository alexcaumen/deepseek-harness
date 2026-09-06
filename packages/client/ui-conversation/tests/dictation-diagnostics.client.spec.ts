import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportDictationOutcome } from '../src/client/skeleton/dictation-diagnostics.ts'

afterEach(() => { vi.useRealTimers() })

describe('payload-free desktop dictation diagnostics', () => {
  it.each([
    'success', 'canceled', 'network-error', 'http-error', 'invalid-response',
    'empty-result', 'permission-error', 'capture-error',
  ] as const)('reports only fixed fields for %s', (outcome) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-06T01:02:03.456Z'))
    const reportDictation = vi.fn()
    reportDictationOutcome(outcome, Date.now() - 123, undefined, { __GIANA_DESKTOP__: { reportDictation } })
    expect(reportDictation).toHaveBeenCalledExactlyOnceWith({
      kind: 'dictation', route: 'speech.transcribe', outcome,
      at: '2026-09-06T01:02:03.456Z', elapsedMs: 123,
    })
  })

  it.each([
    [100, 100], [599, 599], [99, undefined], [600, undefined],
    [200.5, undefined], [NaN, undefined], [Infinity, undefined],
  ])('only includes an integer HTTP status in range: %s', (status, expected) => {
    const reportDictation = vi.fn()
    reportDictationOutcome('http-error', Date.now(), status, { __GIANA_DESKTOP__: { reportDictation } })
    const record = reportDictation.mock.calls[0]![0]
    if (expected === undefined) expect(record).not.toHaveProperty('httpStatus')
    else expect(record.httpStatus).toBe(expected)
  })

  it.each([
    [-100, 0], [123.6, 124], [3_600_001, 3_600_000], [NaN, 0],
  ])('rounds and bounds an elapsed duration of %s', (duration, expected) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-06T01:02:03.456Z'))
    const reportDictation = vi.fn()
    reportDictationOutcome('success', Date.now() - duration, undefined, { __GIANA_DESKTOP__: { reportDictation } })
    expect(reportDictation.mock.calls[0]![0].elapsedMs).toBe(expected)
  })

  it('reports a bounded record without raw content or route URLs', () => {
    const reportDictation = vi.fn()
    reportDictationOutcome('http-error', Date.now() - 20, 503, { __GIANA_DESKTOP__: { reportDictation } })
    const record = reportDictation.mock.calls[0]![0]
    expect(Object.keys(record).sort()).toEqual(['at', 'elapsedMs', 'httpStatus', 'kind', 'outcome', 'route'])
    expect(record).toMatchObject({ kind: 'dictation', route: 'speech.transcribe', outcome: 'http-error', httpStatus: 503 })
    expect(record.elapsedMs).toBeGreaterThanOrEqual(20)
    expect(record.elapsedMs).toBeLessThan(3_600_001)
    expect(Number.isFinite(Date.parse(record.at))).toBe(true)
  })
  it('handles absent, throwing and rejecting bridges without changing the UI', async () => {
    reportDictationOutcome('network-error', NaN, undefined, {})
    reportDictationOutcome('network-error', NaN, undefined, { __GIANA_DESKTOP__: { reportDictation: () => { throw new Error('sink down') } } })
    reportDictationOutcome('network-error', NaN, undefined, { __GIANA_DESKTOP__: { reportDictation: () => Promise.reject(new Error('sink down')) } })
    await Promise.resolve()
  })
  it('omits invalid statuses and clamps impossible duration values', () => {
    const reportDictation = vi.fn()
    reportDictationOutcome('success', NaN, 900, { __GIANA_DESKTOP__: { reportDictation } })
    expect(reportDictation.mock.calls[0]![0]).toMatchObject({ elapsedMs: 0 })
    expect(reportDictation.mock.calls[0]![0]).not.toHaveProperty('httpStatus')
  })
})
