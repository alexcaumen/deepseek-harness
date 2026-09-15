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
      /** Exact routes this Session may select explicitly for a child. */
      allowedModels: AllowedModelRoute[]
    }
  }
}

/**
 * Read the exact route list captured for a model-selectable definition.
 * @param session - Session whose durable policy is read.
 * @returns a detached route list, or undefined for the fixed-route definition.
 */
export function subagentModelSelectionPolicy(session: Session): AllowedModelRoute[] | undefined {
  const event = session.events.find(candidate => candidate.type === MODEL_SELECTION_POLICY_EVENT)
  if (event?.type !== MODEL_SELECTION_POLICY_EVENT) return undefined
  const { allowedModels } = event.data
  assertAllowedModelRoutes(allowedModels)
  return allowedModels.map(route => ({ ...route }))
}

/**
 * Append one immutable route policy before its definition can reach a model.
 * @param session - Session receiving the policy.
 * @param allowedModels - exact routes authorized for this Session.
 */
export function recordSubagentModelSelection(
  session: Session,
  allowedModels: readonly AllowedModelRoute[],
): void {
  if (subagentModelSelectionPolicy(session) !== undefined) return
  assertAllowedModelRoutes(allowedModels)
  session.append(MODEL_SELECTION_POLICY_EVENT, {
    allowedModels: allowedModels.map(route => ({ ...route })),
  })
}
