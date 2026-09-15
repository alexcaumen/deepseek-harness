/** Browser connection recovery timing and validation. */

/** Timing for generation readiness and automatic reconnection. */
export interface ConnectionRecoveryConfig {
  /** First-retry delay cap in ms; actual delay is 50-100% of the cap. */
  backoffBaseMs?: number
  /** Finite growth factor of at least 1 per failed attempt. */
  backoffFactor?: number
  /** Maximum retry delay cap in ms. */
  backoffMaxMs?: number
  /** Delay before reporting a slow handshake without cancelling it. */
  generationReadyWarnMs?: number
  /** Hard deadline for unary and stream readiness. */
  generationReadyTimeoutMs?: number
}

const MAX_TIMER_MS = 2_147_483_647

const DEFAULTS: Required<ConnectionRecoveryConfig> = {
  backoffBaseMs: 500,
  backoffFactor: 2,
  backoffMaxMs: 10_000,
  generationReadyWarnMs: 3_000,
  generationReadyTimeoutMs: 15_000,
}

function timer(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_TIMER_MS) {
    throw new RangeError(`connection recovery ${name} must be an integer between 1 and ${String(MAX_TIMER_MS)}`)
  }
  return resolved
}

/** Validate recovery input and supply every timing default. */
export function resolveConnectionConfig(config: ConnectionRecoveryConfig = {}): Required<ConnectionRecoveryConfig> {
  const backoffFactor = config.backoffFactor ?? DEFAULTS.backoffFactor
  if (!Number.isFinite(backoffFactor) || backoffFactor < 1) {
    throw new RangeError('connection recovery backoffFactor must be finite and at least 1')
  }
  return {
    backoffBaseMs: timer('backoffBaseMs', config.backoffBaseMs, DEFAULTS.backoffBaseMs),
    backoffFactor,
    backoffMaxMs: timer('backoffMaxMs', config.backoffMaxMs, DEFAULTS.backoffMaxMs),
    generationReadyWarnMs: timer(
      'generationReadyWarnMs', config.generationReadyWarnMs, DEFAULTS.generationReadyWarnMs,
    ),
    generationReadyTimeoutMs: timer(
      'generationReadyTimeoutMs', config.generationReadyTimeoutMs, DEFAULTS.generationReadyTimeoutMs,
    ),
  }
}
