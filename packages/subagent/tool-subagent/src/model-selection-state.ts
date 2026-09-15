/** Durable per-session state for model-selectable subagent delegation. */

import type { Session } from '@deepseek-ai/dsh-session'
import { assertAllowedModelRoutes, type AllowedModelRoute } from './model-selection.ts'

const MODEL_SELECTION_POLICY_EVENT = 'subagent/model-selection-policy'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Exact child routes authorized for this Session's model-selectable
     * delegation definition. Log-only: it has no surface operation and never
     * enters model history.
     */
    'subagent/model-selection-policy': {
      /** Stable delegation definition id; legacy events without it belong to `subagent`. */
      definitionId?: string
      /** Discovery tool paired with this definition; legacy events use `list_subagent_models`. */
      discoveryToolName?: string
      /** Host subagent provider whose presence makes the definition executable. */
      providerName?: string
      /** Exact routes this Session may select explicitly for a child. */
      allowedModels: AllowedModelRoute[]
    }
  }
}

/** One immutable model-selection definition recovered from Session history. */
export interface PersistedModelSelectionPolicy {
  readonly definitionId: string
  readonly discoveryToolName: string
  readonly providerName?: string
  readonly allowedModels: AllowedModelRoute[]
}

const LEGACY_DEFINITION_ID = 'subagent'
const LEGACY_DISCOVERY_TOOL = 'list_subagent_models'

function nonBlank(value: string, field: string): void {
  if (value.length === 0) throw new Error(`subagent model selection ${field} must be non-empty`)
}

function cloneRoutes(routes: readonly AllowedModelRoute[]): AllowedModelRoute[] {
  return routes.map(route => ({
    ...route,
    ...route.reasoningEfforts === undefined
      ? {}
      : { reasoningEfforts: [...route.reasoningEfforts] },
  }))
}

/** Read every first-recorded definition without allowing later events to replace policy. */
export function subagentModelSelectionPolicies(session: Session): PersistedModelSelectionPolicy[] {
  const policies = new Map<string, PersistedModelSelectionPolicy>()
  for (const event of session.events) {
    if (event.type !== MODEL_SELECTION_POLICY_EVENT) continue
    const definitionId = event.data.definitionId ?? LEGACY_DEFINITION_ID
    if (policies.has(definitionId)) continue
    const discoveryToolName = event.data.discoveryToolName ?? LEGACY_DISCOVERY_TOOL
    const providerName = event.data.providerName
    nonBlank(definitionId, 'definition id')
    nonBlank(discoveryToolName, 'discovery tool name')
    if (providerName !== undefined) nonBlank(providerName, 'provider name')
    assertAllowedModelRoutes(event.data.allowedModels)
    policies.set(definitionId, {
      definitionId,
      discoveryToolName,
      ...providerName === undefined ? {} : { providerName },
      allowedModels: cloneRoutes(event.data.allowedModels),
    })
  }
  return [...policies.values()]
}

/**
 * Read the exact route list captured for a model-selectable definition.
 * @param session - Session whose durable policy is read.
 * @returns a detached route list, or undefined for the fixed-route definition.
 */
export function subagentModelSelectionPolicy(
  session: Session,
  definitionId = LEGACY_DEFINITION_ID,
): AllowedModelRoute[] | undefined {
  nonBlank(definitionId, 'definition id')
  return subagentModelSelectionPolicies(session)
    .find(policy => policy.definitionId === definitionId)?.allowedModels
}

/**
 * Append one immutable route policy before its definition can reach a model.
 * @param session - Session receiving the policy.
 * @param allowedModels - exact routes authorized for this Session.
 */
export function recordSubagentModelSelection(
  session: Session,
  allowedModels: readonly AllowedModelRoute[],
  definitionId = LEGACY_DEFINITION_ID,
  discoveryToolName = LEGACY_DISCOVERY_TOOL,
  providerName?: string,
): void {
  nonBlank(definitionId, 'definition id')
  nonBlank(discoveryToolName, 'discovery tool name')
  if (providerName !== undefined) nonBlank(providerName, 'provider name')
  if (subagentModelSelectionPolicy(session, definitionId) !== undefined) return
  assertAllowedModelRoutes(allowedModels)
  session.append(MODEL_SELECTION_POLICY_EVENT, {
    definitionId,
    discoveryToolName,
    ...providerName === undefined ? {} : { providerName },
    allowedModels: cloneRoutes(allowedModels),
  })
}
