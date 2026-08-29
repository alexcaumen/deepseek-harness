/**
 * Canonical GianaOS participants with native Giana Code tool access over ACP.
 * @module @grinviro/dsh-llm-gianaos-acp
 */

import { accessSync, constants, statSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { isAbsolute } from 'node:path'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent as AcpAgent,
  type Client,
  type ContentBlock as AcpContentBlock,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { McpToolRuntimeCapability } from '@deepseek-ai/dsh-mcp-server-tool-runtime'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'

export const name = 'llm-gianaos-acp'
export const inject = ['llm', 'subprocess', 'agents', 'sessions', 'mcpToolRuntime']

const DEFAULT_CONTEXT_WINDOW = 1_000_000
const DEFAULT_MAX_TOKENS = 131_072

export interface GianaOsAcpBindingEventData {
  /** Canonical GianaOS principal represented by this remote ACP session. */
  principalId: string
  /** Opaque ACP session identifier. It is not an identity or credential. */
  remoteSessionId: string
  /** Adapter contract revision used to create the binding. */
  routeRevision: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Non-secret projection pointer to the canonical GianaOS ACP session. */
    'gianaos/acp-binding': GianaOsAcpBindingEventData
  }
}

export interface Config {
  /** Stable provider identifier exposed to model selection and session history. */
  providerId: string
  /** Human-readable provider label shown in the model selector. */
  providerName: string
  /** Stable model identifier used by the GianaOS ACP route. */
  modelId: string
  /** Human-readable model label shown in the model selector. */
  modelName: string
  /** Short description of the canonical GianaOS participant binding. */
  description: string
  /** Canonical GianaOS principal represented by the remote ACP session. */
  principalId: string
  /** Versioned adapter contract used to create and validate the binding. */
  routeRevision: string
  /** Executable used to launch the remote ACP bridge. */
  launchCommand: string
  /** Arguments passed to the remote ACP bridge executable. */
  launchArguments: string[]
  /** Script that resolves and starts the canonical remote ACP runtime. */
  launchScript: string
  /** Local workspace associated with the ACP launch context. */
  localWorkspace: string
  /** Remote workspace exposed to the canonical GianaOS runtime. */
  remoteWorkspace: string
  /** Loopback MCP endpoint used for the remote tool-runtime capability. */
  remoteToolRuntimeUrl: string
  /** Permission disposition applied when the ACP bridge requests access. */
  permission: 'allow' | 'reject'
  /** Maximum input context accepted by the bound model route. */
  contextWindow: number
  /** Maximum output tokens requested from the bound model route. */
  maxTokens: number
}

export const Config: z<Config> = z.object({
  providerId: z.string().default('gianaos'),
  providerName: z.string().default('GianaOS'),
  modelId: z.string().default('putri'),
  modelName: z.string().default('Putri'),
  description: z.string().default('Canonical GianaOS participant with native Giana Code capabilities'),
  principalId: z.string().default('giana.putri'),
  routeRevision: z.string().default('giana-code-acp-native-v1'),
  launchCommand: z.string().required(),
  launchArguments: z.array(z.string()).default([]),
  launchScript: z.string().required(),
  localWorkspace: z.string().required(),
  remoteWorkspace: z.string().default('/var/lib/gianaos'),
  remoteToolRuntimeUrl: z.string().default('http://127.0.0.1:18643/mcp/tool-runtime'),
  permission: z.union(['allow', 'reject'] as const).default('allow'),
  contextWindow: z.natural().min(1).default(DEFAULT_CONTEXT_WINDOW),
  maxTokens: z.natural().min(1).default(DEFAULT_MAX_TOKENS),
})

export interface AcpTurnEvent {
  kind: 'text' | 'reasoning'
  text: string
}

class AcpTurnEventQueue implements AsyncIterable<AcpTurnEvent> {
  private readonly pending: AcpTurnEvent[] = []
  private waiter?: () => void
  private closed = false

  push(event: AcpTurnEvent): void {
    if (this.closed || event.text === '') return
    this.pending.push(event)
    this.wake()
  }

  close(): void {
    this.closed = true
    this.wake()
  }

  private wake(): void {
    const waiter = this.waiter
    delete this.waiter
    waiter?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AcpTurnEvent> {
    while (!this.closed || this.pending.length > 0) {
      const event = this.pending.shift()
      if (event !== undefined) {
        yield event
        continue
      }
      await new Promise<void>((resolve) => { this.waiter = resolve })
    }
  }
}

interface AcpTurnBuffer {
  events: AcpTurnEventQueue
  seenToolCalls: Set<string>
}

/**
 * Serializes remote ACP prompts even when a local stream consumer abandons an
 * async generator during cancellation. The lease is released by the remote
 * prompt settlement, not by local iteration, so a replacement turn cannot race
 * the canonical runtime's transition back to idle.
 */
export class AcpTurnBarrier {
  private tail: Promise<void> = Promise.resolve()

  async enter(signal?: AbortSignal): Promise<() => void> {
    const previous = this.tail
    let releaseSlot!: () => void
    const slot = new Promise<void>((resolve) => { releaseSlot = resolve })
    this.tail = previous.then(() => slot)
    await previous
    if (signal?.aborted === true) {
      releaseSlot()
      throw signal.reason instanceof Error ? signal.reason : new Error('ACP turn cancelled before dispatch')
    }
    let released = false
    return () => {
      if (released) return
      released = true
      releaseSlot()
    }
  }
}

interface AcpSession {
  child: SubprocessHandle
  connection: ClientSideConnection
  remoteSessionId: string
  agent: Agent
  localSession: Session
  capability: McpToolRuntimeCapability
  turnBarrier: AcpTurnBarrier
  currentTurn?: AcpTurnBuffer
  disposed: boolean
  disposal?: Promise<void>
}

function isReadableDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory() && (accessSync(path, constants.R_OK | constants.X_OK), true)
  } catch {
    return false
  }
}

function assertAbsoluteFile(label: string, path: string): void {
  if (!isAbsolute(path)) throw new Error(`llm-gianaos-acp: ${label} must be absolute`)
  try {
    accessSync(path, constants.R_OK)
  } catch {
    throw new Error(`llm-gianaos-acp: ${label} is not readable`)
  }
}

function assertAbsoluteDirectory(label: string, path: string): void {
  if (!isAbsolute(path) || !isReadableDirectory(path)) {
    throw new Error(`llm-gianaos-acp: ${label} must be an accessible absolute directory`)
  }
}

function assertRemoteWorkspace(path: string): void {
  if (!path.startsWith('/') || path.includes('\u0000')) {
    throw new Error('llm-gianaos-acp: remoteWorkspace must be an absolute POSIX path')
  }
}

function assertRemoteToolRuntimeUrl(value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username !== '' || url.password !== '') {
    throw new Error('llm-gianaos-acp: remoteToolRuntimeUrl must use credential-free numeric loopback HTTP')
  }
}

function assertCapabilityProjection(localEndpoint: string, remoteEndpoint: string): void {
  const local = new URL(localEndpoint)
  const remote = new URL(remoteEndpoint)
  if (local.protocol !== 'http:'
    || local.hostname !== '127.0.0.1'
    || local.port !== remote.port
    || local.pathname !== remote.pathname) {
    throw new Error('llm-gianaos-acp: remote tool runtime does not project the issued local capability')
  }
}

function contentText(content: AcpContentBlock): string {
  return content.type === 'text' ? content.text : ''
}

function messageText(message: Message): string {
  const blocks: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') blocks.push(block.text)
  }
  return blocks.join('\n').trim()
}

function latestDirectUserMessage(messages: readonly Message[]): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user' && message.source?.kind === 'user') return message
  }
  return undefined
}

/** Project the latest direct human input to ACP without copying history or persona state. */
export async function latestUserPromptContent(
  messages: readonly Message[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<AcpContentBlock[]> {
  const message = latestDirectUserMessage(messages)
  if (message === undefined) return []

  const content: AcpContentBlock[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      if (block.text !== '') content.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type !== 'image') continue
    if (attachments === undefined) {
      throw new LlmError('Putri image input requires the Giana Code attachment store', 'MISSING_ATTACHMENT_STORE')
    }
    const stored = await attachments.readImage(block.attachment, signal)
    content.push({
      type: 'image',
      data: Buffer.from(stored.data).toString('base64'),
      mimeType: stored.ref.mediaType,
    })
  }
  return content
}

/** Latest direct human input only; GianaOS owns persona, history, and memory. */
export function latestUserPrompt(messages: readonly Message[]): string {
  const message = latestDirectUserMessage(messages)
  return message === undefined ? '' : messageText(message)
}

export function latestAcpBinding(session: Session, principalId: string): GianaOsAcpBindingEventData | undefined {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type !== 'gianaos/acp-binding') continue
    const binding = event.data as GianaOsAcpBindingEventData
    if (binding.principalId === principalId) return binding
  }
  return undefined
}

export function localSessionTitle(options: GenerateOptions, fallback: string): string {
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
      // A malformed auxiliary frame safely falls back to compact source text.
    }
  }
  const compact = source.replace(/\s+/g, ' ').trim()
  return (compact === '' ? `${fallback} session` : compact).slice(0, 72)
}

export function projectToolActivity(
  kind: 'tool_call' | 'tool_call_update',
  toolCallId: string,
  seenToolCalls: Set<string>,
): string {
  if (seenToolCalls.has(toolCallId)) return ''
  seenToolCalls.add(toolCallId)
  return kind === 'tool_call'
    ? 'Giana Code tool started.\n'
    : 'Giana Code tool activity updated.\n'
}

/** Convert one ACP turn's delta stream into one durable block per content kind. */
export async function* projectAcpTurnEvents(
  events: AsyncIterable<AcpTurnEvent>,
): AsyncIterable<StreamChunk> {
  const blocks = new Map<AcpTurnEvent['kind'], { index: number; text: string }>()
  let nextIndex = 0

  for await (const event of events) {
    let block = blocks.get(event.kind)
    if (block === undefined) {
      block = { index: nextIndex, text: '' }
      nextIndex += 1
      blocks.set(event.kind, block)
      yield { type: 'block-start', index: block.index, blockType: event.kind }
    }
    block.text += event.text
    if (event.kind === 'reasoning') {
      yield { type: 'reasoning-delta', index: block.index, text: event.text }
    } else {
      yield { type: 'text-delta', index: block.index, text: event.text }
    }
  }

  for (const [kind, block] of blocks) {
    const content = kind === 'reasoning'
      ? { type: 'reasoning' as const, text: block.text }
      : { type: 'text' as const, text: block.text }
    yield { type: 'block-end', index: block.index, block: content }
  }
}

function finishKind(reason: StopReason): 'stop' | 'max-tokens' | 'aborted' | 'error' {
  switch (reason) {
    case 'end_turn': return 'stop'
    case 'max_tokens': return 'max-tokens'
    case 'cancelled': return 'aborted'
    default: return 'error'
  }
}

async function disposeAcpSession(session: AcpSession): Promise<void> {
  if (session.disposal !== undefined) return session.disposal
  session.disposed = true
  session.disposal = (async () => {
    await session.capability.revoke().catch(() => {})
    try {
      session.child.stdin?.end()
    } catch {
      // The transport may already have closed while cancellation was propagating.
    }
    const exited = await session.child.waitForExit(AbortSignal.timeout(3_000)).catch(() => false)
    if (!exited) {
      session.child.terminate()
      await session.child.waitForExit().catch(() => {})
    }
  })()
  return session.disposal
}

class GianaOsAcpAdapter extends LlmAdapter {
  private readonly sessions = new Map<string, AcpSession>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.config.providerName }
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{
      provider: this.config.providerId,
      id: this.config.modelId,
      name: this.config.modelName,
      description: this.config.description,
      inputModalities: ['text', 'image'] as const,
    }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (model !== this.config.modelId) {
      return Promise.reject(new LlmError(`${this.config.providerName} has no participant named "${model}"`, 'UNKNOWN_GIANAOS_PARTICIPANT'))
    }
    return Promise.resolve({
      provider,
      id: this.config.modelId,
      name: this.config.modelName,
      description: this.config.description,
      inputModalities: ['text', 'image'],
      context: { contextWindow: this.config.contextWindow },
      defaultMaxTokens: this.config.maxTokens,
    })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose === 'session-title') {
      const title = localSessionTitle(options, this.config.modelName)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: title }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (options.model !== this.config.modelId) {
      throw new LlmError(`${this.config.providerName} has no participant named "${options.model}"`, 'UNKNOWN_GIANAOS_PARTICIPANT')
    }
    if (options.sessionId === undefined) {
      throw new LlmError('Putri requires an exact live Giana Code session', 'MISSING_GIANA_CODE_SESSION')
    }

    const agent = this.ctx.agents.get(options.sessionId)
    const localSession = this.ctx.sessions.get(options.sessionId)
    if (agent === undefined || localSession === undefined || agent.session !== localSession || agent.id !== localSession.id) {
      throw new LlmError('Putri requires one exact live Giana Code agent/session identity', 'STALE_GIANA_CODE_SESSION')
    }

    const key = String(options.sessionId)
    let session = this.sessions.get(key)
    if (session !== undefined && (session.disposed || session.agent !== agent || session.localSession !== localSession)) {
      await disposeAcpSession(session)
      this.sessions.delete(key)
      session = undefined
    }
    if (session === undefined) {
      session = await this.startSession(agent, localSession)
      this.sessions.set(key, session)
    }

    const prompt = await latestUserPromptContent(options.messages, this.ctx.get('attachments'), options.signal)
    if (prompt.length === 0) throw new LlmError('Putri received no direct human message', 'MISSING_HUMAN_MESSAGE')

    const releaseRemoteTurn = await session.turnBarrier.enter(options.signal)
    const turn: AcpTurnBuffer = { events: new AcpTurnEventQueue(), seenToolCalls: new Set() }
    session.currentTurn = turn
    const abort = (): void => {
      void session?.connection.cancel({ sessionId: session.remoteSessionId }).catch(() => {})
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted === true) abort()
    let remotePrompt: ReturnType<AcpSession['connection']['prompt']>
    try {
      remotePrompt = session.connection.prompt({
        sessionId: session.remoteSessionId,
        prompt,
      })
    } catch (error: unknown) {
      releaseRemoteTurn()
      throw error
    }
    const promptOutcome = remotePrompt.then(result => ({ ok: true as const, stopReason: result.stopReason }),
      (error: unknown) => ({ ok: false as const, error })).finally(() => {
      turn.events.close()
      releaseRemoteTurn()
    })

    try {
      yield* projectAcpTurnEvents(turn.events)
    } finally {
      options.signal?.removeEventListener('abort', abort)
      if (session.currentTurn === turn) delete session.currentTurn
      if (options.signal?.aborted === true) {
        // ACP cancel is advisory: the remote prompt may acknowledge cancellation
        // before its single-step runtime has returned to idle. Reusing that pipe
        // makes the replacement prompt look like a concurrent request, so the
        // canonical runtime queues every later message. Retire only the transport;
        // startSession reloads the same durable remote session on the next turn.
        await disposeAcpSession(session)
        if (this.sessions.get(key) === session) this.sessions.delete(key)
      }
    }

    const outcome = await promptOutcome
    if (!outcome.ok) {
      await disposeAcpSession(session)
      this.sessions.delete(key)
      const error = outcome.error
      throw new LlmError(
        error instanceof Error ? `Putri ACP failed: ${error.message}` : 'Putri ACP failed',
        options.signal?.aborted === true ? 'ABORTED' : 'GIANAOS_ACP_ERROR',
        error instanceof Error ? { cause: error } : undefined,
      )
    }

    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
    const kind = finishKind(outcome.stopReason)
    if (kind === 'stop' || kind === 'max-tokens') {
      yield { type: 'finish', reason: { kind } }
    } else {
      yield {
        type: 'finish',
        reason: {
          kind,
          failure: {
            message: kind === 'aborted' ? 'Putri request was cancelled' : `Putri stopped with ${outcome.stopReason}`,
            code: kind === 'aborted' ? 'ABORTED' : 'GIANAOS_ACP_STOPPED',
          },
        },
      }
    }
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.allSettled(sessions.map(disposeAcpSession))
  }

  private async startSession(agent: Agent, localSession: Session): Promise<AcpSession> {
    const capability = this.ctx.mcpToolRuntime.issue(agent)
    assertCapabilityProjection(capability.endpoint, this.config.remoteToolRuntimeUrl)
    const child = this.ctx.subprocess.spawn({
      argv: [
        this.config.launchCommand,
        ...this.config.launchArguments,
        this.config.launchScript,
      ],
      cwd: this.config.localWorkspace,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: 3_000,
      env: {},
    })
    if (child.stdin === undefined || child.stdout === undefined) {
      await capability.revoke().catch(() => {})
      throw new LlmError('Putri ACP subprocess lost its protocol pipes', 'GIANAOS_ACP_PIPE_ERROR')
    }

    let currentSession: AcpSession | undefined
    const permission = this.config.permission
    const makeClient = (_agent: AcpAgent): Client => ({
      sessionUpdate(params: SessionNotification): Promise<void> {
        const update = params.update
        const turn = currentSession?.currentTurn
        if (turn === undefined) return Promise.resolve()
        if (update.sessionUpdate === 'agent_message_chunk') {
          const text = contentText(update.content)
          turn.events.push({ kind: 'text', text })
        } else if (update.sessionUpdate === 'agent_thought_chunk') {
          const text = contentText(update.content)
          turn.events.push({ kind: 'reasoning', text })
        } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          const text = projectToolActivity(update.sessionUpdate, update.toolCallId, turn.seenToolCalls)
          turn.events.push({ kind: 'reasoning', text })
        }
        return Promise.resolve()
      },
      requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        if (permission === 'allow') {
          const allowed = params.options.find(option => option.kind === 'allow_once')
            ?? params.options.find(option => option.kind === 'allow_always')
          if (allowed !== undefined) {
            return Promise.resolve({ outcome: { outcome: 'selected', optionId: allowed.optionId } })
          }
        }
        return Promise.resolve({ outcome: { outcome: 'cancelled' } })
      },
    })
    const connection = new ClientSideConnection(
      makeClient,
      ndJsonStream(
        NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    )

    try {
      const initialized = await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'Giana Code', version: '0.1.1-rc.2' },
      })
      // GianaOS R2.004 already accepts and registers HTTP MCP servers in
      // newSession/loadSession, but its current initialize response omits the
      // matching capability advertisement. Keep the projection explicit here
      // until the canonical runtime advertises that source-backed behavior.
      const mcpServers = [{
        type: 'http' as const,
        name: 'giana-code-tool-runtime',
        url: this.config.remoteToolRuntimeUrl,
        headers: [{ name: 'Authorization', value: `Bearer ${capability.token}` }],
      }]
      const binding = latestAcpBinding(localSession, this.config.principalId)
      let remoteSessionId: string
      if (binding !== undefined) {
        if (binding.routeRevision !== this.config.routeRevision) {
          throw new Error('stored Putri ACP binding uses a different route revision')
        }
        if (initialized.agentCapabilities?.loadSession !== true) {
          throw new Error('canonical GianaOS ACP route cannot restore the stored session')
        }
        await connection.loadSession({
          cwd: this.config.remoteWorkspace,
          mcpServers,
          sessionId: binding.remoteSessionId,
        })
        remoteSessionId = binding.remoteSessionId
      } else {
        const remote = await connection.newSession({ cwd: this.config.remoteWorkspace, mcpServers })
        remoteSessionId = remote.sessionId
        localSession.append('gianaos/acp-binding', {
          principalId: this.config.principalId,
          remoteSessionId,
          routeRevision: this.config.routeRevision,
        })
      }
      currentSession = {
        child,
        connection,
        remoteSessionId,
        agent,
        localSession,
        capability,
        turnBarrier: new AcpTurnBarrier(),
        disposed: false,
      }
      return currentSession
    } catch (error: unknown) {
      await capability.revoke().catch(() => {})
      child.terminate()
      await child.waitForExit().catch(() => {})
      throw error
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  assertAbsoluteFile('launchCommand', config.launchCommand)
  assertAbsoluteFile('launchScript', config.launchScript)
  assertAbsoluteDirectory('localWorkspace', config.localWorkspace)
  assertRemoteWorkspace(config.remoteWorkspace)
  assertRemoteToolRuntimeUrl(config.remoteToolRuntimeUrl)
  if (config.providerId.trim() === '' || config.modelId.trim() === '' || config.principalId.trim() === '') {
    throw new Error('llm-gianaos-acp: providerId, modelId, and principalId must not be empty')
  }

  const adapter = new GianaOsAcpAdapter(ctx, config)
  ctx.llm.registerAdapter([config.providerId], adapter)
  ctx.effect(() => () => adapter.dispose(), 'llm-gianaos-acp.sessions()')
}
