import { describe, expect, it } from 'vitest'
import { resolveConnectionConfig } from '../src/recovery-config.ts'

describe('connection recovery config', () => {
  it('provides bounded production defaults', () => {
    expect(resolveConnectionConfig()).toEqual({
      backoffBaseMs: 500,
      backoffFactor: 2,
      backoffMaxMs: 10_000,
      generationReadyWarnMs: 3_000,
      generationReadyTimeoutMs: 15_000,
    })
  })

  it.each([
    { backoffBaseMs: 0 },
    { backoffMaxMs: -1 },
    { generationReadyWarnMs: 1.5 },
    { generationReadyTimeoutMs: Number.MAX_SAFE_INTEGER },
    { backoffFactor: 0 },
    { backoffFactor: Number.POSITIVE_INFINITY },
  ])('rejects malformed recovery input %#', (config) => {
    expect(() => resolveConnectionConfig(config)).toThrow(/connection recovery/)
  })
})
