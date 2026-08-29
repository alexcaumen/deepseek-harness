/**
 * A thin telephone surface from DeepSeek Harness to a canonical GianaOS
 * principal. The remote GianaOS runtime owns identity, Soul, memory, session
 * history, tools, approvals, workers, and the final reply. Harness stores only
 * its local transcript projection and never injects a second system persona.
 *
 * With the PRDG workspace bridge enabled the surface additionally announces its
 * bounded local capability and executes the operations the principal asks for,
 * returning hash-bound evidence inside the same canonical session. The
 * principal still writes every reply; the bridge only supplies evidence.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
  type FinishReason,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { parseSse } from '@deepseek-ai/dsh-llm-deepseek/src/sse.ts'
import { translate } from '@deepseek-ai/dsh-llm-deepseek/src/translate.ts'
import {
  bindWorkspace,
  composeTurnInput,
  EvidenceLedger,
  mintTurnFence,
  proposeCanonicalKnowledge,
  renderSurfaceEnvelope,
  runBridgeHop,
  sha256,
  toolCallFenceStart,
  type CanonicalKnowledgeProposal,
  type CodingTool,
  type ExecutorConfig,
  type ObjectiveState,
  type ScriptGrant,
  type TurnFence,
  type WorkspaceBinding,
} from '@grinviro/dsh-llm-gianaos-workspace-bridge'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'llm-gianaos-telephone'
export const inject = ['llm', 'credentials']

const DEFAULT_CONTEXT_WINDOW = 1_000_000
const DEFAULT_MAX_TOKENS = 131_072

/** One operator-granted PRDG workspace. */
export interface WorkspaceGrantConfig {
  /** Stable identifier used by bounded bridge requests. */
  id: string
  /** Absolute workspace root authorized for this grant. */
  root: string
  /** SHA-256 identity binding for the authorized workspace. */
  identitySha256: string
  /** Whether bounded edit operations are permitted in this workspace. */
  writable: boolean
}

/** One operator-granted named script selectable by `test` or `build`. */
export interface ScriptGrantConfig {
  /** Stable identifier exposed to bounded test or build requests. */
  id: string
  /** Exact executable or command selected by this grant. */
  command: string
  /** Fixed arguments appended to the granted command. */
  args: string[]
  /** Tool class allowed to invoke this script. */
  tool: 'test' | 'build'
  /** Workspace grant that owns this script. */
  workspaceId: string
}

export interface Config {
  /** Stable provider identifier exposed to DSH. */
  providerId: string
  /** Human-readable provider group name. */
  providerName: string
  /** Stable model identifier exposed by the telephone route. */
  modelId: string
  /** Human-readable model name shown in the selector. */
  modelName: string
  /** Model capability description shown by DSH. */
  description: string
  /** Canonical non-secret GianaOS telephone base URL. */
  baseURL: string
  /** Remote model identifier sent through the telephone route. */
  remoteModel: string
  /** Environment-variable name used for no-export credential lookup. */
  credentialEnv: string
  /** Prefix used when projecting DSH session identities. */
  sessionPrefix: string
  /** Canonical GianaOS principal required by this route. */
  principalId: string
  /** Enables the bounded PRDG workspace bridge. */
  bridgeEnabled: boolean
  /** Coding tool classes allowed through the bounded bridge. */
  bridgeTools: CodingTool[]
  /** Exact workspace grants available to the bridge. */
  bridgeWorkspaces: WorkspaceGrantConfig[]
  /** Exact named test and build scripts available to the bridge. */
  bridgeScripts: ScriptGrantConfig[]
  /** Maximum bridge hops allowed for one model turn. */
  bridgeMaxHops: number
  /** Maximum combined output bytes returned by one bridge hop. */
  bridgeMaxOutputBytes: number
  /** Maximum bytes accepted by one bounded edit operation. */
  bridgeMaxEditBytes: number
  /** Timeout applied to each bounded command invocation. */
  bridgeCommandTimeoutMs: number
  /** Monotonic authorization epoch used to reject stale grants. */
  authorizationEpoch: number
  /** Header name that binds requests to the canonical route. */
  canonicalRouteHeader: string
}

export const Config: z<Config> = z.object({
  providerId: z.string().default('gianaos'),
  providerName: z.string().default('GianaOS'),
  modelId: z.string().default('putri'),
  modelName: z.string().default('Putri'),
  description: z.string().default('Canonical Putri through the GianaOS telephone front door'),
  baseURL: z.string().default('http://127.0.0.1:18642/v1'),
  remoteModel: z.string().default('putri'),
  credentialEnv: z.string().default('PUTRI_API_KEY'),
  sessionPrefix: z.string().default('deepseek-harness'),
  principalId: z.string().default('giana.putri'),
  bridgeEnabled: z.boolean().default(false),
  bridgeTools: z.array(z.union(['read', 'edit', 'test', 'build', 'terminal'] as const)).default(['read']),
  bridgeWorkspaces: z.array(z.object({
    id: z.string().required(),
    root: z.string().required(),
    identitySha256: z.string().required(),
    writable: z.boolean().default(false),
  })).default([]),
  bridgeScripts: z.array(z.object({
    id: z.string().required(),
    command: z.string().required(),
    args: z.array(z.string()).default([]),
    tool: z.union(['test', 'build'] as const).required(),
    workspaceId: z.string().required(),
  })).default([]),
  bridgeMaxHops: z.number().default(4),
  bridgeMaxOutputBytes: z.number().default(65_536),
  bridgeMaxEditBytes: z.number().default(262_144),
  bridgeCommandTimeoutMs: z.number().default(300_000),
  authorizationEpoch: z.number().default(1),
  canonicalRouteHeader: z.string().default(''),
})

function messageText(message: Message): string {
  const text: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') text.push(block.text)
    if (block.type === 'tool-result') {
      for (const item of block.content) if (item.type === 'text') text.push(item.text)
    }
  }
  return text.join('\n').trim()
}

export function lastHumanMessage(messages: readonly Message[]): string {
  const message = [...messages].reverse().find(candidate => (
    candidate.role === 'user' && candidate.source.kind === 'user'
  ))
  return message === undefined ? '' : messageText(message)
}

export function telephoneSessionId(prefix: string, sessionId: unknown): string {
  const suffix = sessionId === undefined ? `oneshot-${crypto.randomUUID()}` : String(sessionId)
  return `${prefix}:${suffix}`.slice(0, 240)
}

function localSessionTitle(options: GenerateOptions, fallback: string): string {
  const framed = [...options.messages].reverse().map(messageText).find(Boolean) ?? ''
  const marker = 'Generate the session title from this JSON array of human messages:\n'
  let source = framed
  if (framed.startsWith(marker)) {
    try {
      const messages: unknown = JSON.parse(framed.slice(marker.length))
      if (Array.isArray(messages)) {
        const text = [...messages].reverse().find((item): item is { text: string } => (
          typeof item === 'object' && item !== null && typeof (item as { text?: unknown }).text === 'string'
        ))?.text
        if (text !== undefined) source = text
      }
    } catch {
      // The compact deterministic fallback below handles malformed title framing.
    }
  }
  const compact = source.replace(/\s+/g, ' ').trim()
  return (compact === '' ? `${fallback} session` : compact).slice(0, 72)
}

export interface TelephoneAdapterOptions {
  config: Config
  resolveCredential: () => Promise<string>
  /**
   * Receives the distilled proposal for a turn that produced bounded evidence.
   * Persisting it is the canonical GianaOS memory writer's decision; this
   * surface never writes canonical memory and never forwards a raw transcript.
   */
  onKnowledgeProposal?: (proposal: CanonicalKnowledgeProposal) => void
}

/** Accumulated per-hop stream state; text is needed whole to parse a request block. */
interface HopSink {
  text: string
  usage?: TokenUsage
  finish?: FinishReason
}

/**
 * Build the executor configuration from operator config, refusing a workspace
 * grant that is malformed or points at a forbidden root.
 * @param config - the plugin configuration.
 * @returns the executor configuration, or undefined when nothing is granted.
 */
function executorConfig(config: Config): ExecutorConfig | undefined {
  if (!config.bridgeEnabled) return undefined
  const workspaces: WorkspaceBinding[] = config.bridgeWorkspaces.map(grant => bindWorkspace({
    id: grant.id,
    root: grant.root,
    identitySha256: grant.identitySha256,
    writable: grant.writable,
  }))
  if (workspaces.length === 0) return undefined
  const scripts: ScriptGrant[] = config.bridgeScripts.map(grant => Object.freeze({
    id: grant.id,
    command: grant.command,
    args: Object.freeze([...grant.args]),
    tool: grant.tool,
    workspaceId: grant.workspaceId,
  }))
  return Object.freeze({
    workspaces: Object.freeze(workspaces),
    allowedTools: new Set(config.bridgeTools),
    scripts: Object.freeze(scripts),
    limits: Object.freeze({
      maxOutputBytes: config.bridgeMaxOutputBytes,
      commandTimeoutMs: config.bridgeCommandTimeoutMs,
      maxEditBytes: config.bridgeMaxEditBytes,
    }),
  })
}

/**
 * Forward one hop's text deltas while suppressing the machine request block.
 *
 * Suppression starts at the opening fence, so the principal's prose still
 * streams at full speed and only the surface machinery is withheld.
 * @param source - translated chunks for one hop.
 * @param sink - accumulator receiving the full text, usage, and finish reason.
 * @returns text deltas safe to show the operator.
 */
async function* visibleHopDeltas(
  source: AsyncIterable<StreamChunk>,
  sink: HopSink,
): AsyncGenerator<string> {
  let emitted = 0
  for await (const chunk of source) {
    if (chunk.type === 'text-delta') {
      sink.text += chunk.text
      const fenceStart = toolCallFenceStart(sink.text)
      const visibleEnd = fenceStart === -1 ? sink.text.length : fenceStart
      if (visibleEnd > emitted) {
        yield sink.text.slice(emitted, visibleEnd)
        emitted = visibleEnd
      }
      continue
    }
    if (chunk.type === 'usage') {
      sink.usage = chunk.usage
      continue
    }
    if (chunk.type === 'finish') sink.finish = chunk.reason
  }
}

/**
 * One operator-visible line summarizing a completed bridge hop.
 * @param tool - the requested tool.
 * @param status - the evidence status.
 * @param detail - the path, script, or refusal detail.
 * @param durationMs - executor wall-clock time.
 * @returns the marker line.
 */
function hopMarker(tool: string, status: string, detail: string, durationMs: number): string {
  return `\n\n[prdg-bridge] ${tool} ${status}${detail === '' ? '' : ` ${detail}`} (${durationMs} ms)\n\n`
}

export class GianaOsTelephoneAdapter extends LlmAdapter {
  constructor(private readonly options: TelephoneAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.options.config.providerName }
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const config = this.options.config
    return Promise.resolve([{
      provider: config.providerId,
      id: config.modelId,
      name: config.modelName,
      description: config.description,
      inputModalities: ['text'],
    }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const config = this.options.config
    if (model !== config.modelId) {
      return Promise.reject(new LlmError(`${config.providerName} has no principal named "${model}"`, 'UNKNOWN_GIANAOS_PRINCIPAL'))
    }
    return Promise.resolve({
      provider,
      id: config.modelId,
      name: config.modelName,
      description: config.description,
      inputModalities: ['text'],
      context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
    })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const config = this.options.config
    if (options.purpose === 'session-title') {
      const title = localSessionTitle(options, config.modelName)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: title }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (options.model !== config.modelId) {
      throw new LlmError(`${config.providerName} has no principal named "${options.model}"`, 'UNKNOWN_GIANAOS_PRINCIPAL')
    }

    const prompt = lastHumanMessage(options.messages)
    if (prompt === '') throw new LlmError('GianaOS telephone request has no human message', 'EMPTY_TELEPHONE_REQUEST')
    const credential = await this.options.resolveCredential()
    const session = telephoneSessionId(config.sessionPrefix, options.sessionId)
    const executor = executorConfig(config)

    if (executor === undefined) {
      yield* translate(parseSse(await this.postTurn(prompt, session, credential, options.signal)))
      return
    }

    let fence: TurnFence = mintTurnFence({
      principalId: config.principalId,
      canonicalSessionId: session,
      surfaceId: 'deepseek-harness',
      sourceWatermark: sha256(prompt),
      conversationWatermark: sha256(session),
      cancelGeneration: 0,
      supersessionGeneration: 0,
      authorizationEpoch: config.authorizationEpoch,
    }, config.bridgeMaxHops)

    const ledger = new EvidenceLedger()
    const envelope = renderSurfaceEnvelope(fence, {
      workspaces: executor.workspaces,
      allowedTools: executor.allowedTools,
      scripts: executor.scripts,
    })

    let turnInput = composeTurnInput(prompt, envelope)
    let visibleText = ''
    const totals: TokenUsage = { inputTokens: 0, outputTokens: 0 }
    let finish: FinishReason = { kind: 'stop' }

    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (let hop = 0; hop <= config.bridgeMaxHops; hop += 1) {
      const body = await this.postTurn(turnInput, session, credential, options.signal)
      const sink: HopSink = { text: '' }
      for await (const text of visibleHopDeltas(translate(parseSse(body)), sink)) {
        visibleText += text
        yield { type: 'text-delta', index: 0, text }
      }
      totals.inputTokens += sink.usage?.inputTokens ?? 0
      totals.outputTokens += sink.usage?.outputTokens ?? 0
      if (sink.finish !== undefined) finish = sink.finish

      // Cancellation observed now, not when the fence was minted, so work the
      // operator stopped mid-turn cannot still reach the executor.
      const objective: ObjectiveState = {
        cancelGeneration: options.signal?.aborted === true
          ? fence.cancelGeneration + 1
          : fence.cancelGeneration,
        supersessionGeneration: fence.supersessionGeneration,
      }
      const completed = await runBridgeHop(sink.text, {
        fence,
        objective,
        executor,
        ledger,
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
      if (completed === undefined) break

      const evidence = completed.evidence
      const detail = evidence.path ?? evidence.refusal ?? ''
      const marker = hopMarker(evidence.tool, evidence.status, detail, completed.durationMs)
      visibleText += marker
      yield { type: 'text-delta', index: 0, text: marker }

      fence = completed.fence
      turnInput = completed.evidenceMessage
    }

    const proposal = proposeCanonicalKnowledge(fence, ledger)
    if (proposal !== undefined) {
      // The proposal is offered to the canonical memory writer by the principal
      // herself; this surface records the references and writes nothing.
      this.options.onKnowledgeProposal?.(proposal)
    }

    yield { type: 'block-end', index: 0, block: { type: 'text', text: visibleText } }
    yield { type: 'usage', usage: totals }
    yield { type: 'finish', reason: finish }
  }

  /**
   * Post one canonical turn to the GianaOS front door.
   *
   * Every hop reuses the same privacy-scoped session headers, so evidence
   * returns inside the canonical session the operator's message opened.
   * @param content - the turn input text.
   * @param session - the privacy-scoped surface session id.
   * @param credential - the resolved managed credential.
   * @param signal - cancellation for the turn.
   * @returns the response body stream; a bodiless response is refused here.
   */
  private async postTurn(
    content: string,
    session: string,
    credential: string,
    signal: AbortSignal | undefined,
  ): Promise<NonNullable<Response['body']>> {
    const config = this.options.config
    let response: Response
    try {
      response = await fetch(`${config.baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-hermes-session-id': session,
          'x-gianaos-session-id': session,
          'x-hermes-session-key': session,
          ...(config.canonicalRouteHeader ? { 'x-giana-route': config.canonicalRouteHeader } : {}),
          ...attributionHeaders(),
        },
        body: JSON.stringify({
          model: config.remoteModel,
          messages: [{ role: 'user', content }],
          stream: true,
          stream_options: { include_usage: true },
        }),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted === true) {
        throw new LlmError('GianaOS telephone request was cancelled', 'ABORTED', { cause: error })
      }
      throw new LlmError('GianaOS telephone transport is unavailable', 'GIANAOS_TELEPHONE_TRANSPORT', { cause: error })
    }

    if (!response.ok) {
      let detail = `HTTP ${response.status}`
      try {
        const body = await response.json() as { error?: { message?: string } }
        if (body.error?.message) detail = body.error.message
      } catch {
        // HTTP status remains the authoritative failure when the body is not JSON.
      }
      throw new LlmError(`GianaOS telephone refused the request: ${detail}`, 'GIANAOS_TELEPHONE_HTTP')
    }
    if (response.body === null) throw new LlmError('GianaOS telephone returned no stream', 'EMPTY_RESPONSE')
    return response.body
  }
}

export function apply(ctx: Context, config: Config): void {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/v1\/?$/.test(config.baseURL)) {
    throw new Error('llm-gianaos-telephone: baseURL must remain a loopback /v1 endpoint')
  }
  const adapter = new GianaOsTelephoneAdapter({
    config,
    resolveCredential: async () => {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) {
        throw new LlmError(`${config.providerName} requires the managed credentials service`, 'MISSING_CREDENTIAL_SERVICE')
      }
      const resolved = await credentials.resolve(credentialRef(config.credentialEnv))
      if (resolved === undefined || resolved.value.trim() === '') {
        throw new LlmError(`${config.providerName} credential projection is unavailable`, 'MISSING_CREDENTIAL')
      }
      return resolved.value
    },
  })
  ctx.llm.registerAdapter([config.providerId], adapter)
}
