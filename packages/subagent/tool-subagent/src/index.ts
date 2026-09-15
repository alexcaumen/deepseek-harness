/**
 * Model-facing delegation through one configured `ctx.subagents` provider.
 * Provider lifecycle controls tool registration and context-sensitive schema
 * wording. Foreground calls always dispose the run after collection.
 * Background policy is selected by this plugin's configuration: one-shot
 * calls own a plain Task, while continuable calls use
 * `ctx.subagents.startContinuable()`.
 * @module @deepseek-ai/dsh-tool-subagent
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import {
  assertSubagentMaxDepth,
  delegationAllowsTool,
  parentAgentOptionsForDelegation,
  settleRun,
} from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerListSubagentModels } from './list-models.ts'
import {
  AllowedModelRouteSchema,
  applyDeclaredDefaultReasoningEffort,
  assertAllowedModelRoutes,
  assertAllowedModelSelection,
  hasDelegationModelRequest,
  preflightChildLlmRoute,
  requestedAgentOptions,
} from './model-selection.ts'
import type { AllowedModelRoute, DelegationModelRequest, ModelSelectionPolicy } from './model-selection.ts'
import {
  recordSubagentModelSelection,
  subagentModelSelectionPolicy,
} from './model-selection-state.ts'

export const name = 'tool-subagent'
export const inject = ['tools', 'subagents', 'systemPrompt']

/** Prompt order after bounded delegation policy and before child reporting. */
const SUBAGENT_SECTION_ORDER = 116.5

/** Config: which registered provider this tool delegates to, plus child defaults. */
export interface Config {
  /** The `ctx.subagents` provider name to start runs on (e.g. `spawn`, `acp`). */
  provider: string
  /**
   * Model-facing tool name (default `subagent`). Each loaded instance must use
   * a distinct name.
   */
  toolName?: string
  /**
   * Exact provider/model routes the model may select for new Sessions. The
   * decision is captured per Session; omission keeps the fixed-route schema.
   */
  modelSelectionPolicy?: {
    /** Non-empty exact-route allowlist. */
    allowedModels: AllowedModelRoute[]
    /** Use the shared LLM registry, or trust the configured subagent provider. */
    preflight?: 'llm' | 'provider'
    /** Unique discovery tool owned by this delegation tool instance. */
    discoveryToolName?: string
  }
  /**
   * Expose `run_in_background` (default true). Disabled instances omit the
   * parameter and reject forced background calls.
   */
  enableRunInBackground?: boolean
  /**
   * Background execution policy (default `one-shot`). `one-shot` defaults calls
   * to foreground; `continuable` defaults them to background, requires a provider
   * with the `prepareContinuable` capability, and returns the durable child id.
   * Follow-up adapters remain independently optional.
   */
  backgroundMode?: 'one-shot' | 'continuable'
  /**
   * Agent options applied to every child; omitted fields use child-loop defaults.
   */
  agentOptions?: AgentOptions
  /**
   * Per-child persona that shadows `deployment:persona`. Requires the
   * provider's `persona` capability; omission preserves the deployment persona.
   */
  persona?: string
  /**
   * Tool filter applied to every child. Filtered tools disappear from its
   * prompt and reject execution. Requires the provider's `toolFilter`
   * capability; unknown names fail startup.
   */
  toolFilter?: {
    /** Global tool names the child keeps; everything else is removed. */
    allow?: string[]
    /** Global tool names removed from the child. */
    deny?: string[]
  }
  /**
   * Maximum child depth: a non-negative safe integer (default `3`; `0` forbids
   * delegation entirely), or `'provider-managed'` to send no cap. A numeric cap
   * requires the provider's `depthLimit` capability (mount fails loud
   * otherwise). The provider checks the calling agent's current depth at every
   * start; the tool remains model-visible so runtime policy owns rejection.
   * `'provider-managed'` is for an out-of-process provider whose recursion
   * budget belongs to the child runtime or its own deployment.
   */
  maxDepth?: number | 'provider-managed'
}

export const Config = z.object({
  provider: z.string().required(),
  toolName: z.string().default('subagent'),
  modelSelectionPolicy: (z.object({
    allowedModels: z.array(AllowedModelRouteSchema).min(1).required(),
    preflight: z.union(['llm', 'provider'] as const),
    discoveryToolName: z.string().min(1),
  }) as unknown as z<NonNullable<Config['modelSelectionPolicy']>>).default(undefined as unknown as {
    allowedModels: AllowedModelRoute[]
    preflight?: 'llm' | 'provider'
    discoveryToolName?: string
  }),
  enableRunInBackground: z.boolean().default(true),
  backgroundMode: z.union(['one-shot', 'continuable'] as const).default('one-shot'),
  // Prevent Schemastery from materializing omitted agentOptions as `{}`.
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1) as z<ReturnType<typeof ReasoningEffortId>>,
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  }).default(undefined as unknown as {
    provider: string
    model: string
    reasoningEffort: ReturnType<typeof ReasoningEffortId>
    maxTokens: number
  }),
  persona: z.string(),
  // Preserve omission; Schemastery's `{ allow: [] }` default would deny every tool.
  toolFilter: z.object({
    allow: z.array(z.string()).default(undefined as unknown as string[]),
    deny: z.array(z.string()).default(undefined as unknown as string[]),
  }).default(undefined as unknown as { allow: string[]; deny: string[] }),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]).default(3),
}) as unknown as z<Config>

/** Render text blocks from the canonical JSON block array without trusting arbitrary values. */
function outputValueText(values: JsonValue[]): string {
  return values
    .filter((value): value is { type: 'text'; text: string } =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && value.type === 'text' && typeof value.text === 'string')
    .map(value => value.text)
    .join('')
}

/** Settle pending startup without rejecting the task producer contract. */
async function settleStart(start: Promise<SubagentRun>, signal: AbortSignal): Promise<JobOutcome> {
  try {
    return await settleRun(await start)
  } catch (error: unknown) {
    // Product providers aggregate startup and rollback failures. Cancellation
    // must not turn a failed cleanup into a cleanly killed Job.
    return signal.aborted && !(error instanceof AggregateError)
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) }
  }
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    // Merge-extensible union: a backend may add stop reasons. Treat an unknown
    // terminal reason as a failure rather than reporting partial output as success.
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/**
 * Append provider-authored failure detail and the child's preserved partial
 * answer to a stop-reason error, keeping diagnostic text separate from the
 * child's assistant output.
 * @param error - the stop-reason headline.
 * @param result - the child's terminal result.
 * @returns the headline, diagnostic, and partial text that are present.
 */
function withDiagnosticAndPartialText(error: string, result: SubagentResult): string {
  const diagnostic = result.diagnostic === undefined
    ? ''
    : `\nDiagnostic: ${result.diagnostic}`
  const text = result.output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  const partial = text.length === 0
    ? ''
    : `\nPartial output before the run ended:\n${text}`
  return `${error}${diagnostic}${partial}`
}

type ForegroundToolResult = {
  readonly kind: 'foreground'
  readonly runId: SubagentRun['id']
  readonly output: JsonValue[]
}

/**
 * Collect and release one foreground run without letting disposal replace an
 * independent result failure.
 */
async function settleForegroundRun(run: SubagentRun): Promise<ForegroundToolResult> {
  const [execution] = await Promise.allSettled([
    run.result.then((result): ForegroundToolResult => {
      const error = stopReasonError(result)
      if (error !== undefined) {
        // The registry converts this throw to isError; partial output is not
        // success, but the preserved partial answer still reaches the parent.
        throw new Error(withDiagnosticAndPartialText(error, result))
      }
      return {
        kind: 'foreground',
        runId: run.id,
        // Content blocks already cross durable JSON boundaries elsewhere;
        // the registry performs the authoritative lossless snapshot here.
        output: result.output as unknown as JsonValue[],
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/**
 * Model-facing wording from the provider's conversation-history descriptor
 * ({@link SubagentProvider.inheritsParentContext}).
 * A fresh child needs a standalone prompt; a forked child already sees the
 * conversation's completed turns — telling the model to restate everything
 * (or, worse, that the child "does not see this conversation") would be false
 * for a fork.
 * @param inheritsConversation - whether the child's conversation is seeded
 *   with the parent's completed turns; this says nothing about tool, service,
 *   scope, or authority inheritance.
 * @returns the tool `description` and the `prompt` parameter description.
 */
function providerWording(inheritsConversation: boolean): { description: string; promptDescription: string } {
  if (inheritsConversation) {
    return {
      description:
        'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all '
        + 'completed turns so far (it does not see the current in-flight turn). Use this when the subtask '
        + 'builds on this conversation\'s context — a follow-up analysis, '
        + 'a review, a continuation — without consuming this conversation\'s context for the work itself. '
        + 'You receive its result, not its intermediate steps.',
      promptDescription:
        'The task for the subagent. It already sees this conversation\'s completed turns, so build on them '
        + 'freely and state only what is new.',
    }
  }
  return {
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
      + 'to offload focused, independent work — research, a scoped '
      + 'implementation, an analysis — so it does not consume this conversation\'s context. The subagent '
      + 'returns its result, not its intermediate steps. Give it a '
      + 'complete, standalone prompt: it does not see this conversation.',
    promptDescription:
      'The complete, self-contained task for the subagent. It does not share this '
      + 'conversation\'s context, so include everything it needs.',
  }
}

interface DelegationRunRequest {
  readonly run_in_background?: boolean
}

interface DelegationRunSpec {
  readonly runInBackground: boolean
}

/** Resolve the model's optional scheduling request into one execution route. */
function resolveDelegationRun(
  request: DelegationRunRequest,
  options: { readonly backgroundEnabled: boolean; readonly continuable: boolean },
): DelegationRunSpec {
  if (!options.backgroundEnabled) {
    // The validator permits undeclared keys, so schema omission also needs
    // execution-time enforcement.
    if (request.run_in_background === true) {
      throw new Error('run_in_background is disabled for this tool instance (enableRunInBackground: false)')
    }
    return { runInBackground: false }
  }
  return {
    // Continuable work is independently scheduled unless the caller explicitly
    // needs the result before its next action. One-shot policy keeps its existing
    // foreground default because its background result requires Task collection.
    runInBackground: request.run_in_background ?? options.continuable,
  }
}

/** Reject transports without implementation-backed route-option support. */
function assertModelSelectableProvider(provider: SubagentProvider): void {
  if (provider.capabilities.agentOptions !== true) {
    throw new Error(
      `tool-subagent: provider "${provider.name}" does not advertise the agentOptions capability`,
    )
  }
}

export function apply(ctx: Context, config: Config): void {
  // Direct apply() bypasses Schemastery's numeric constraints. A direct-apply
  // omission stays capless (the schema default only runs through the loader).
  if (config.maxDepth !== 'provider-managed') assertSubagentMaxDepth(config.maxDepth)
  // Reject an empty explicit filter at load instead of failing every delegation.
  if (config.toolFilter !== undefined && config.toolFilter.allow === undefined && config.toolFilter.deny === undefined) {
    throw new Error('tool-subagent: `toolFilter` is configured but names neither `allow` nor `deny` — remove the key or fill the filter')
  }
  if (config.modelSelectionPolicy !== undefined) {
    assertAllowedModelRoutes(config.modelSelectionPolicy.allowedModels)
    if (config.modelSelectionPolicy.preflight === 'provider'
      && config.modelSelectionPolicy.allowedModels.some(route => route.reasoningEfforts === undefined)) {
      throw new Error('provider-managed subagent model selection requires declared reasoning efforts for every route')
    }
  }
  const backgroundEnabled = config.enableRunInBackground !== false
  const continuable = (config.backgroundMode ?? 'one-shot') === 'continuable'
  const toolName = config.toolName ?? 'subagent'
  const configuredPolicy: ModelSelectionPolicy | undefined = config.modelSelectionPolicy === undefined
    ? undefined
    : { routes: config.modelSelectionPolicy.allowedModels.map(route => ({ ...route })) }
  const modelPreflight = config.modelSelectionPolicy?.preflight ?? 'llm'
  const discoveryToolName = config.modelSelectionPolicy?.discoveryToolName ?? 'list_subagent_models'

  const assertSubagentProviderConfiguration = (
    provider: SubagentProvider,
    modelSelectionEnabled: boolean,
  ): void => {
    if (typeof config.maxDepth === 'number' && !provider.capabilities.depthLimit) {
      throw new Error(
        `tool-subagent: provider "${provider.name}" cannot enforce maxDepth (no depthLimit capability) — `
        + 'set maxDepth: \'provider-managed\' to leave the recursion budget to the provider',
      )
    }
    if (modelSelectionEnabled) assertModelSelectableProvider(provider)
    if (continuable && provider.prepareContinuable === undefined) {
      throw new Error(
        `tool-subagent: provider "${provider.name}" does not support \`backgroundMode: continuable\``,
      )
    }
  }

  const install = (runtimeCtx: Context, modelSelectionPolicy: ModelSelectionPolicy | undefined): void => {
    const modelSelectionEnabled = modelSelectionPolicy !== undefined
    if (modelSelectionPolicy !== undefined) {
      registerListSubagentModels(
        runtimeCtx,
        modelSelectionPolicy,
        discoveryToolName,
        modelPreflight === 'provider',
      )
    }
    // Load order and HMR replacement can change provider availability while
    // this fiber remains active.
    let mounted: { provider: SubagentProvider; disposeTool: () => void } | undefined
    const mount = (provider: SubagentProvider): void => {
      assertSubagentProviderConfiguration(provider, modelSelectionEnabled)
      const wording = providerWording(provider.inheritsParentContext)
      const providerRouteDefaults = provider.agentRouteDefaults
      const choiceDescription = !modelSelectionEnabled
        ? ''
        : ` Child LLM selection is optional. Omit \`provider\`, \`model\`, and \`reasoning_effort\` to use configured child defaults. Supply \`provider\` and \`model\` together after using \`${discoveryToolName}\` to inspect authorized routes and efforts. Changing the effective route without naming an effort uses the selected model's default effort.`
          + (provider.inheritsParentContext
            ? ' Changing the route can prevent provider-side reuse of the inherited conversation prefix.'
            : '')
      const disposeTool = runtimeCtx.tools.register(defineTool({
        name: toolName,
        description: wording.description + (backgroundEnabled
          ? continuable
            ? ' This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends the parent a notice containing its outcome and any final assistant message; `send_message` starts a later turn in the same child conversation. Set `run_in_background: false` only when your next action depends on receiving the result.'
            : ' This call waits for the result by default. Set `run_in_background: true` to return a job id; collect with `job_output` and stop with `job_kill`.'
          : ' This call waits for the subagent and returns its result.') + choiceDescription,
        parameters: {
          description: {
            type: 'string',
            required: true,
            description: 'A short (3-5 word) description of the delegated task, for display.',
          },
          prompt: {
            type: 'string',
            required: true,
            description: wording.promptDescription,
          },
          ...modelSelectionEnabled ? {
            provider: {
              type: 'string' as const,
              description: 'LLM provider route for the child. Supply together with model; omit both to use child defaults.',
            },
            model: {
              type: 'string' as const,
              description: 'Exact model id. Supply together with provider; omit both to use child defaults.',
            },
            reasoning_effort: {
              type: 'string' as const,
              description: 'Adapter-owned reasoning effort for the effective child route.',
            },
          } : {},
          ...backgroundEnabled ? {
            run_in_background: {
              type: 'boolean' as const,
              description: continuable
                ? 'Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.'
                : 'Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill.',
            },
          } : {},
        },
        output: {
          schema: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'background' },
                  jobId: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'continuable' },
                  subagentId: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'foreground' },
                  runId: { type: 'string', required: true },
                  output: { type: 'array', required: true, items: { type: 'json' } },
                },
              },
            ],
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.kind === 'background'
              ? `started background subagent job ${value.jobId}`
              : value.kind === 'continuable'
                ? `started subagent ${value.subagentId}`
                : outputValueText(value.output),
          }],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const parent = exec.agent
          if (!parent) {
            throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')
          }

          const modelRequest = args as DelegationModelRequest
          let childAgentOptions = config.agentOptions
          if (hasDelegationModelRequest(modelRequest)) {
            const parentOptions = parentAgentOptionsForDelegation(parent)
            const configuredOptions = providerRouteDefaults === undefined
              ? config.agentOptions
              : { ...providerRouteDefaults, ...config.agentOptions }
            childAgentOptions = requestedAgentOptions(
              parentOptions,
              configuredOptions,
              modelRequest,
              modelSelectionEnabled,
            )
            assertAllowedModelSelection(
              modelSelectionPolicy,
              parentOptions,
              childAgentOptions,
              modelRequest,
            )
            childAgentOptions = applyDeclaredDefaultReasoningEffort(
              modelSelectionPolicy,
              childAgentOptions,
              modelRequest,
            )
            if (modelPreflight === 'llm') {
              const llm = runtimeCtx.get('llm')
              if (llm === undefined) {
                throw new Error('cannot resolve the selected child LLM route because the `llm` service is unavailable')
              }
              await preflightChildLlmRoute(
                llm,
                parentOptions,
                childAgentOptions,
                exec.signal,
                providerRouteDefaults === undefined,
              )
            }
            if (runtimeCtx.subagents.getProvider(config.provider) !== provider) {
              throw new Error(`subagent provider "${config.provider}" changed while resolving the child LLM route; retry the delegation`)
            }
          }
          exec.signal.throwIfAborted()
          const maxDepth = typeof config.maxDepth === 'number' ? config.maxDepth : undefined
          const request = {
            label: args.description,
            prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
            parent,
            ...childAgentOptions !== undefined ? { agentOptions: childAgentOptions } : {},
            ...config.persona !== undefined ? { persona: config.persona } : {},
            ...config.toolFilter !== undefined ? { toolFilter: config.toolFilter } : {},
            ...maxDepth !== undefined ? { maxDepth } : {},
          }

          const runSpec = resolveDelegationRun(args, { backgroundEnabled, continuable })
          if (runSpec.runInBackground) {
            if (continuable) {
              const started = await runtimeCtx.subagents.startContinuable({
                provider: config.provider,
                label: args.description,
                request,
                signal: exec.signal,
              })
              return { kind: 'continuable' as const, subagentId: started.childId }
            }
            const jobs = runtimeCtx.get('jobs')
            if (jobs === undefined) {
              throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
            }
            const id = jobs.start({
              kind: 'subagent',
              label: args.description,
              owner: parent,
              run: () => {
                const controller = new AbortController()
                const start = runtimeCtx.subagents.start(config.provider, { ...request, signal: controller.signal })
                return {
                  cancel: (reason?: string) => {
                    controller.abort(reason ?? 'background subagent task killed')
                  },
                  done: settleStart(start, controller.signal),
                }
              },
            })
            return { kind: 'background' as const, jobId: id }
          }

          const run: SubagentRun = await runtimeCtx.subagents.start(config.provider, {
            ...request,
            signal: exec.signal,
          })
          return settleForegroundRun(run)
        },
      }))
      mounted = { provider, disposeTool }
    }

    runtimeCtx.on('subagent/provider-added', (provider) => {
      if (provider.name === config.provider && mounted === undefined) mount(provider)
    })
    runtimeCtx.on('subagent/provider-removed', (name) => {
      if (name !== config.provider || mounted === undefined) return
      mounted.disposeTool()
      mounted = undefined
    })
    const present = runtimeCtx.subagents.getProvider(config.provider)
    if (present !== undefined) {
      mount(present)
    } else {
      runtimeCtx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${toolName}" tool will register when it appears`)
    }
    if (backgroundEnabled && continuable) {
      runtimeCtx.systemPrompt.section({
        name: `tool:${toolName}`,
        order: SUBAGENT_SECTION_ORDER,
        text: context => mounted === undefined || runtimeCtx.tools.get(toolName, context.scope) === undefined
          ? ''
          : `Use ${toolName} in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set \`run_in_background: false\` only when your next action depends on that subagent's result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message.`,
      })
    }
  }

  if (configuredPolicy === undefined) {
    install(ctx, undefined)
    return
  }

  const selectForAgent = (agent: NonNullable<Context['agent']>): ModelSelectionPolicy | undefined => {
    const freshSession = agent.session.firstLiveSeq === 0
      && agent.session.events[0]?.type !== 'session/end-seed'
    let allowedModels = subagentModelSelectionPolicy(agent.session, toolName)
    if (allowedModels === undefined) {
      const parentId = agent.session.header.origin === 'subagent'
        ? agent.session.header.parentSession
        : undefined
      if (parentId !== undefined) {
        const parent = ctx.get('agents')?.get(parentId)
        allowedModels = parent === undefined
          ? undefined
          : subagentModelSelectionPolicy(parent.session, toolName)
      } else if (freshSession) {
        allowedModels = configuredPolicy.routes.map(route => ({ ...route }))
      }
    }
    if (allowedModels !== undefined) {
      recordSubagentModelSelection(
        agent.session,
        allowedModels,
        toolName,
        discoveryToolName,
        config.provider,
      )
    }
    return allowedModels === undefined ? undefined : { routes: allowedModels }
  }

  const agent = ctx.agent
  if (agent !== undefined) {
    install(ctx, selectForAgent(agent))
    return
  }
  const compositionScope = scopeOf(ctx)
  if (compositionScope === undefined) {
    throw new Error('tool-subagent: `modelSelectionPolicy` requires an Agent or preset scope')
  }
  const agents = ctx.get('agents')
  if (agents === undefined) {
    throw new Error('tool-subagent: scoped model selection requires the Agent registry')
  }
  const scopedInstalls = new WeakMap<Agent, ReturnType<Context['inject']>>()
  const scopedAgents = new Set<Agent>()
  const installing = new WeakSet<Agent>()
  const belongsToComposition = (candidate: Agent): boolean =>
    scopeChainOf(scopeOf(candidate.ctx)).includes(compositionScope)
  const installScoped = (candidate: Agent): void => {
    if (scopedInstalls.has(candidate) || installing.has(candidate)
      || !belongsToComposition(candidate)
      || !delegationAllowsTool(candidate, toolName)
      || !delegationAllowsTool(candidate, discoveryToolName)) return
    installing.add(candidate)
    let fiber: ReturnType<Context['inject']>
    try {
      const policy = selectForAgent(candidate)
      fiber = candidate.ctx.inject(['tools', 'subagents', 'systemPrompt'], (runtimeCtx) => {
        install(runtimeCtx, policy)
      })
    } finally {
      installing.delete(candidate)
    }
    scopedInstalls.set(candidate, fiber)
    scopedAgents.add(candidate)
  }
  const removeScoped = (candidate: Agent): void => {
    const fiber = scopedInstalls.get(candidate)
    if (fiber === undefined) return
    scopedInstalls.delete(candidate)
    scopedAgents.delete(candidate)
    void fiber.dispose().catch((error: unknown) => {
      ctx.logger.warn(`tool-subagent: failed to remove Agent "${candidate.id}" definitions: ${String(error)}`)
    })
  }
  const reconcileComposedAgents = (): void => {
    for (const candidate of agents.list()) {
      if (belongsToComposition(candidate)) installScoped(candidate)
      else removeScoped(candidate)
    }
  }
  ctx.on('agent/created', ({ agent: created }) => { installScoped(created) })
  ctx.on('agent/disposed', ({ agent: disposed }) => { removeScoped(disposed) })
  ctx.on('tools/change', reconcileComposedAgents)
  reconcileComposedAgents()
  ctx.effect(() => async () => {
    const pending = [...scopedAgents].flatMap((candidate) => {
      const fiber = scopedInstalls.get(candidate)
      scopedInstalls.delete(candidate)
      return fiber === undefined ? [] : [fiber.dispose()]
    })
    scopedAgents.clear()
    const outcomes = await Promise.allSettled(pending)
    const failures = outcomes.flatMap<unknown>(outcome =>
      outcome.status === 'rejected' ? [outcome.reason as unknown] : [])
    if (failures.length > 0) {
      throw new AggregateError(failures, 'tool-subagent: failed to remove scoped Agent definitions')
    }
  }, 'tool-subagent: scoped Agent definitions')
}
