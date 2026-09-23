/** Limits for automatically retained browser history, not the durable session log. */
export interface HistoryBudgetConfig {
  /** Event count at which completed steps become eligible for eviction. */
  maxHistoryEvents?: number
  /** Serialized UTF-16 character budget, including tool views. This is not heap bytes. */
  maxHistoryChars?: number
}

/** Validated browser history limits. */
export interface HistoryBudget {
  maxHistoryEvents: number
  maxHistoryChars: number
}

/** Resolve programmatic options once before creating session objects.
 * @param config - optional targets; normal browser boot uses defaults.
 * @returns positive finite limits.
 */
export function resolveHistoryBudget(config: HistoryBudgetConfig = {}): HistoryBudget {
  const resolved = {
    maxHistoryEvents: config.maxHistoryEvents ?? 20_000,
    maxHistoryChars: config.maxHistoryChars ?? 8_000_000,
  }
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${key} must be a positive integer`)
  }
  return resolved
}
