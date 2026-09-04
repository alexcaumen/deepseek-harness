/** Browser-safe mirror of the Host-owned model-lifecycle settings section. */

/** Must match the namespace owned by @deepseek-ai/dsh-model-lifecycle. */
export const MODEL_LIFECYCLE_SETTINGS_NAMESPACE = 'model-lifecycle'

/** Must match the scalar field owned by the Host lifecycle controller. */
export const MODEL_COMPUTE_PREFERENCE_FIELD = 'preference'

/** Supported browser choices for the Host-owned compute-routing preference. */
export const MODEL_COMPUTE_PREFERENCES = ['automatic', 'r5300', 'prdg'] as const

/** One user-visible compute-routing preference. */
export type ModelComputePreference = typeof MODEL_COMPUTE_PREFERENCES[number]

/** Decoded model-lifecycle settings projected to the browser. */
export interface ModelLifecycleSettings {
  readonly preference: ModelComputePreference
}

/**
 * Narrow the untrusted settings wire section before it reaches the row.
 * @param section - Untrusted settings payload returned by the Host.
 * @returns A validated lifecycle preference, or undefined for an invalid payload.
 */
export function decodeModelLifecycleSettings(section: unknown): ModelLifecycleSettings | undefined {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return undefined
  const preference = (section as Record<string, unknown>)[MODEL_COMPUTE_PREFERENCE_FIELD]
  return typeof preference === 'string' && MODEL_COMPUTE_PREFERENCES.includes(preference as ModelComputePreference)
    ? { preference: preference as ModelComputePreference }
    : undefined
}
