/** Authorized child LLM route selection for the subagent tool. */

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { markModelDefaultReasoning, usesModelDefaultReasoning } from '@deepseek-ai/dsh-subagent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

/** One exact child LLM route authorized for model-facing selection. */
export interface AllowedModelRoute {
  /** Registered LLM provider id. */
  readonly provider: string
  /** Provider-owned exact model id. */
  readonly model: string
  /** Deployment-declared efforts for provider-managed routes. */
  readonly reasoningEfforts?: string[]
  /** Default effort shown for a provider-managed route. */
  readonly defaultReasoningEffort?: string
}

/** Schema shared by tool configuration and durable policy state. */
export const AllowedModelRouteSchema: z<AllowedModelRoute> = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
  reasoningEfforts: z.array(z.string().min(1)).default(undefined as unknown as string[]),
  defaultReasoningEffort: z.string().min(1),
})

/** Route-selection authority captured for one Session. */
export interface ModelSelectionPolicy {
  /** Exact provider/model routes authorized for explicit selection. */
  readonly routes: readonly AllowedModelRoute[]
}

/** Stable identity for one exact route. */
export function modelRouteKey(route: AllowedModelRoute): string {
  return `${route.provider}\0${route.model}`
}

/**
 * Validate an exact-route allowlist at configuration and durable-read boundaries.
 * @param routes - candidate exact routes.
 */
export function assertAllowedModelRoutes(routes: unknown): asserts routes is readonly AllowedModelRoute[] {
  if (!Array.isArray(routes)) {
    throw new Error('subagent model selection requires an array of routes')
  }
  const seen = new Set<string>()
  const candidates: readonly unknown[] = routes
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)
      || !('provider' in candidate) || typeof candidate.provider !== 'string'
      || !('model' in candidate) || typeof candidate.model !== 'string'
      || candidate.provider.length === 0 || candidate.model.length === 0) {
      throw new Error('subagent model selection requires non-empty provider and model ids')
    }
    const route = { provider: candidate.provider, model: candidate.model }
    const key = modelRouteKey(route)
    if (seen.has(key)) {
      throw new Error(`subagent model selection repeats route "${route.provider}/${route.model}"`)
    }
    seen.add(key)
    const efforts = 'reasoningEfforts' in candidate ? candidate.reasoningEfforts : undefined
    const defaultEffort = 'defaultReasoningEffort' in candidate
      ? candidate.defaultReasoningEffort
      : undefined
    if (efforts !== undefined) {
      if (!Array.isArray(efforts) || efforts.length === 0
        || efforts.some(effort => typeof effort !== 'string' || effort.length === 0)
        || new Set(efforts).size !== efforts.length) {
        throw new Error(`subagent model selection route "${route.provider}/${route.model}" has invalid reasoning efforts`)
      }
      if (defaultEffort !== undefined
        && (typeof defaultEffort !== 'string' || !efforts.includes(defaultEffort))) {
        throw new Error(`subagent model selection route "${route.provider}/${route.model}" has an invalid default reasoning effort`)
      }
    } else if (defaultEffort !== undefined) {
      throw new Error(`subagent model selection route "${route.provider}/${route.model}" declares a default without reasoning efforts`)
    }
  }
  if (routes.length === 0) {
    throw new Error('subagent model selection requires at least one allowed route')
  }
}

/** Model-facing child LLM route fields. */
export interface DelegationModelRequest {
  readonly provider?: string
  readonly model?: string
  readonly reasoning_effort?: string
}

/** Whether a call supplies any model-facing child LLM value. */
export function hasDelegationModelRequest(request: DelegationModelRequest): boolean {
  return request.provider !== undefined
    || request.model !== undefined
    || request.reasoning_effort !== undefined
}

/** Reject an empty model-facing value at the tool JSON boundary. */
function assertNonEmpty(value: string | undefined, field: keyof DelegationModelRequest): void {
  if (value !== undefined && value.length === 0) {
    throw new Error(`child LLM \`${field}\` must be non-empty`)
  }
}

/** Merge one route layer while clearing effort when the route changes. */
function mergeRouteOptions(base: AgentOptions, over: AgentOptions): AgentOptions {
  const merged = { ...base, ...over }
  const routeChanged = merged.provider !== base.provider || merged.model !== base.model
  if (over.reasoningEffort === undefined && (routeChanged || usesModelDefaultReasoning(base))) {
    delete merged.reasoningEffort
    markModelDefaultReasoning(merged)
  }
  return merged
}

/**
 * Resolve model-supplied fields over configured and parent child defaults.
 * Provider and model form one route and must be supplied together.
 * @param parentOptions - current parent values.
 * @param configured - tool-instance child defaults.
 * @param request - model-facing route override.
 * @param enabled - whether this Session has a durable selection policy.
 * @returns child Agent options, preserving omission for a fixed-route call.
 */
export function requestedAgentOptions(
  parentOptions: AgentOptions,
  configured: AgentOptions | undefined,
  request: DelegationModelRequest,
  enabled: boolean,
): AgentOptions | undefined {
  if (!hasDelegationModelRequest(request)) return configured
  if (!enabled) {
    throw new Error('child model selection is disabled for this Session')
  }
  assertNonEmpty(request.provider, 'provider')
  assertNonEmpty(request.model, 'model')
  assertNonEmpty(request.reasoning_effort, 'reasoning_effort')
  if ((request.provider === undefined) !== (request.model === undefined)) {
    throw new Error('child LLM `provider` and `model` must be supplied together')
  }

  let resolved = configured === undefined
    ? { ...parentOptions }
    : mergeRouteOptions(parentOptions, configured)
  if (request.provider !== undefined && request.model !== undefined) {
    resolved = mergeRouteOptions(resolved, { provider: request.provider, model: request.model })
  }
  if (request.reasoning_effort !== undefined) {
    // Route merging may mark this exact object as intentionally using the
    // selected model's default effort. An explicit caller choice supersedes
    // that marker, so materialize a fresh identity before attaching it.
    resolved = {
      ...resolved,
      reasoningEffort: ReasoningEffortId(request.reasoning_effort),
    }
  }
  return resolved
}

/**
 * Enforce the Session allowlist at the operation that creates the child.
 * Calls that select nothing retain deployment-owned routing outside this policy.
 * @param policy - Session selection authority.
 * @param parentOptions - current parent values.
 * @param requested - effective child options.
 * @param request - model-facing selection fields.
 */
export function assertAllowedModelSelection(
  policy: ModelSelectionPolicy | undefined,
  parentOptions: AgentOptions,
  requested: AgentOptions | undefined,
  request: DelegationModelRequest,
): void {
  if (!hasDelegationModelRequest(request)) return
  if (policy === undefined) {
    throw new Error('child model selection is disabled for this Session')
  }
  const provider = requested?.provider ?? parentOptions.provider
  const model = requested?.model ?? parentOptions.model
  if (provider === undefined || model === undefined) {
    throw new Error('cannot select child LLM values without an effective provider and model')
  }
  const route = policy.routes.find(route => route.provider === provider && route.model === model)
  if (route !== undefined) {
    if (request.reasoning_effort !== undefined && route.reasoningEfforts !== undefined
      && !route.reasoningEfforts.includes(request.reasoning_effort)) {
      throw new Error(
        `reasoning effort "${request.reasoning_effort}" is not allowed for child LLM route "${provider}/${model}"`,
      )
    }
    return
  }
  throw new Error(`child LLM route "${provider}/${model}" is not allowed for this Session`)
}

/** Whether configured Agent options require route preflight. */
export function hasConfiguredLlmSelection(options: AgentOptions | undefined): boolean {
  return options?.provider !== undefined
    || options?.model !== undefined
    || options?.reasoningEffort !== undefined
}

/**
 * Resolve a selected route through its live LLM adapter before child creation.
 * @param llm - live LLM runtime.
 * @param parentOptions - current parent route.
 * @param requested - effective child options.
 * @param signal - tool-call cancellation signal.
 * @param inheritParentReasoningEffort - whether an omitted effort may use the parent effort.
 */
export async function preflightChildLlmRoute(
  llm: LlmRuntime,
  parentOptions: AgentOptions,
  requested: AgentOptions | undefined,
  signal: AbortSignal,
  inheritParentReasoningEffort = true,
): Promise<void> {
  const provider = requested?.provider ?? parentOptions.provider
  const model = requested?.model ?? parentOptions.model
  if (provider === undefined || model === undefined) {
    throw new Error('cannot select child LLM values without an effective provider and model')
  }
  const routeChanged = provider !== parentOptions.provider || model !== parentOptions.model
  const reasoningEffort = usesModelDefaultReasoning(requested)
    ? undefined
    : inheritParentReasoningEffort && !routeChanged
      ? requested?.reasoningEffort ?? parentOptions.reasoningEffort
      : requested?.reasoningEffort
  await llm.resolveCallConfig({
    provider,
    model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }, signal)
}
