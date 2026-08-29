/**
 * Princess OS routes exposed in the Harness model selector. Each selectable
 * entry is an isolated ACP agent, not an alias for a Harness LLM model.
 *
 * Giana Code remains the workbench and transcript projection. The ACP
 * child owns agent identity, memory, provider policy, tools, and approvals.
 * @module @grinviro/dsh-llm-princess-os
 */

import { accessSync, constants, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'

export const name = 'llm-princess-os'
export const inject = ['llm', 'subprocess']

const DEFAULT_CONTEXT_WINDOW = 1_000_000
const DEFAULT_MAX_TOKENS = 131_072
const ACP_COMPAT_LAUNCHER = fileURLToPath(new URL('../python/acp_compat.py', import.meta.url))

export interface AgentRouteConfig {
  /** Stable Princess OS agent identifier exposed in DSH. */
  id: string
  /** Human-readable Princess OS agent name. */
  name: string
  /** Isolated Hermes home used only by this private agent. */
  hermesHome: string
  /** SHA-256 owner-private Windows binding asserted by the route. */
  ownerPrivateWindowsBindingSha256: string
}

export interface Config {
  /** Stable provider identifier exposed to DSH. */
  providerId: string
  /** Human-readable provider group name. */
  providerName: string
  /** Capability description shown for Princess OS agents. */
  agentDescription: string
  /** Route-level instruction preserving Princess OS isolation. */
  systemInstruction: string
  /** Python executable used to start the ACP compatibility process. */
  pythonCommand: string
  /** Absolute Hermes Agent source root used by the ACP launcher. */
  hermesSource: string
  /** Default isolated workspace presented to Princess OS agents. */
  workspace: string
  /** Environment-variable name used for no-export provider credential lookup. */
  credentialEnv: string
  /** Launch permission for the isolated ACP child process. */
  permission: 'allow' | 'reject'
  /** Princess OS agents available through this provider. */
  agents: AgentRouteConfig[]
}

export const Config: z<Config> = z.object({
  providerId: z.string().default('princess-os'),
  providerName: z.string().default('Princess OS'),
  agentDescription: z.string().default('Princess OS private agent via ACP'),
  systemInstruction: z.string().default([
    'This ACP route belongs to Princess OS.',
    'Giana Code is only the workbench and transcript projection.',
    'Do not claim to be one of the Giana Girls and do not write to any GianaOS profile or canonical database.',
  ].join(' ')),
  pythonCommand: z.string().required(),
  hermesSource: z.string().required(),
  workspace: z.string().required(),
  credentialEnv: z.string().default('DEEPSEEK_API_KEY'),
  permission: z.union(['allow', 'reject'] as const).default('reject'),
  agents: z.array(z.object({
    id: z.string().required(),
    name: z.string().required(),
    hermesHome: z.string().required(),
    ownerPrivateWindowsBindingSha256: z.string().default(''),
  })).required(),
})

interface AcpTurnBuffer {
  text: string
  reasoning: string
  events: AcpTurnEventQueue
}

export interface AcpTurnEvent {
  kind: 'text' | 'reasoning'
  text: string
}

export class AcpTurnEventQueue implements AsyncIterable<AcpTurnEvent> {
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
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }
}

interface AcpSession {
  child: SubprocessHandle
  connection: ClientSideConnection
  remoteSessionId: string
  currentTurn?: AcpTurnBuffer
  seenMessageIds: Set<string>
  turnCount: number
  disposed: boolean
}

function isReadableDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory() && (accessSync(path, constants.R_OK | constants.X_OK), true)
  } catch {
    return false
  }
}

function assertAbsoluteFile(label: string, path: string): void {
  if (!isAbsolute(path)) throw new Error(`llm-princess-os: ${label} must be absolute`)
  try {
    accessSync(path, constants.R_OK)
  } catch {
    throw new Error(`llm-princess-os: ${label} is not readable`)
  }
}

function assertAbsoluteDirectory(label: string, path: string): void {
  if (!isAbsolute(path) || !isReadableDirectory(path)) {
    throw new Error(`llm-princess-os: ${label} must be an accessible absolute directory`)
  }
}

function contentText(content: AcpContentBlock): string {
  return content.type === 'text' ? content.text : ''
}

function messageText(message: Message): string {
  const blocks: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') blocks.push(block.text)
    if (block.type === 'tool-result') {
      for (const item of block.content) if (item.type === 'text') blocks.push(item.text)
    }
  }
  return blocks.join('\n').trim()
}

export function projectConversation(messages: readonly Message[]): string {
  return messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map((message) => {
      const text = messageText(message)
      return text === '' ? '' : `${message.role.toUpperCase()}: ${text}`
    })
    .filter(Boolean)
    .join('\n\n')
}

function importedPrompt(
  options: GenerateOptions,
  session: AcpSession,
  route: AgentRouteConfig,
  config: Config,
): string {
  const unseen = options.messages.filter(message => !session.seenMessageIds.has(String(message.id)))
  for (const message of options.messages) session.seenMessageIds.add(String(message.id))

  if (session.turnCount > 0) {
    const user = [...unseen].reverse().find(message => message.role === 'user')
    const text = user === undefined ? '' : messageText(user)
    if (text !== '') return text
  }

  // The canonical ACP agent already owns its system prompt, memory, skills,
  // tools, and approval policy. Forwarding the Harness system/context here
  // duplicates authority and substantially inflates every cold-start prompt.
  const transcript = projectConversation(options.messages)

  return [
    `You are ${route.name}.`,
    config.systemInstruction,
    transcript === '' ? 'USER: Begin this Princess OS session.' : `WORKBENCH TRANSCRIPT:\n${transcript}`,
  ].filter(Boolean).join('\n\n')
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
      // The deterministic fallback below is sufficient for malformed framing.
    }
  }
  const compact = source.replace(/\s+/g, ' ').trim()
  return (compact === '' ? `${fallback} session` : compact).slice(0, 72)
}

function finishKind(reason: StopReason): 'stop' | 'max-tokens' | 'aborted' | 'error' {
  switch (reason) {
    case 'end_turn': return 'stop'
    case 'max_tokens': return 'max-tokens'
    case 'cancelled': return 'aborted'
    default: return 'error'
  }
}

async function disposeChild(session: AcpSession): Promise<void> {
  if (session.disposed) return
  session.disposed = true
  session.child.stdin?.end()
  const exited = await session.child.waitForExit(AbortSignal.timeout(3_000)).catch(() => false)
  if (!exited) {
    session.child.terminate()
    await session.child.waitForExit().catch(() => {})
  }
}

class PrincessOsAdapter extends LlmAdapter {
  private readonly sessions = new Map<string, AcpSession>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly routes: ReadonlyMap<string, AgentRouteConfig>,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.config.providerName }
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([...this.routes.values()].map(route => ({
      provider: this.config.providerId,
      id: route.id,
      name: route.name,
      description: this.config.agentDescription,
      inputModalities: ['text'] as const,
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const route = this.routes.get(model)
    if (route === undefined) {
      return Promise.reject(new LlmError(`${this.config.providerName} has no agent named "${model}"`, 'UNKNOWN_ACP_AGENT'))
    }
    return Promise.resolve({
      provider,
      id: route.id,
      name: route.name,
      description: this.config.agentDescription,
      inputModalities: ['text'],
      context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
    })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose === 'session-title') {
      const title = localSessionTitle(options, this.config.providerName)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: title }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    const route = this.routes.get(options.model)
    if (route === undefined) throw new LlmError(`${this.config.providerName} has no agent named "${options.model}"`, 'UNKNOWN_ACP_AGENT')
    const key = `${route.id}:${options.sessionId ?? `oneshot-${crypto.randomUUID()}`}`
    let session = this.sessions.get(key)
    if (session === undefined || session.disposed) {
      session = await this.startSession(route)
      this.sessions.set(key, session)
    }

    const turn: AcpTurnBuffer = { text: '', reasoning: '', events: new AcpTurnEventQueue() }
    session.currentTurn = turn
    const abort = (): void => {
      void session?.connection.cancel({ sessionId: session.remoteSessionId }).catch(() => {})
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    const promptOutcome = session.connection.prompt({
      sessionId: session.remoteSessionId,
      prompt: [{ type: 'text', text: importedPrompt(options, session, route, this.config) }],
    }).then((result) => {
      session.turnCount += 1
      return { ok: true as const, stopReason: result.stopReason }
    }, (error: unknown) => ({ ok: false as const, error })).finally(() => {
      turn.events.close()
    })

    let index = 0
    let openBlock: { kind: AcpTurnEvent['kind']; index: number } | undefined
    try {
      for await (const event of turn.events) {
        if (openBlock !== undefined && openBlock.kind !== event.kind) {
          const block = openBlock.kind === 'reasoning'
            ? { type: 'reasoning' as const, text: turn.reasoning }
            : { type: 'text' as const, text: turn.text }
          yield { type: 'block-end', index: openBlock.index, block }
          openBlock = undefined
        }
        if (openBlock === undefined) {
          openBlock = { kind: event.kind, index }
          yield { type: 'block-start', index, blockType: event.kind }
          index += 1
        }
        if (event.kind === 'reasoning') {
          yield { type: 'reasoning-delta', index: openBlock.index, text: event.text }
        } else {
          yield { type: 'text-delta', index: openBlock.index, text: event.text }
        }
      }

      if (openBlock !== undefined) {
        const block = openBlock.kind === 'reasoning'
          ? { type: 'reasoning' as const, text: turn.reasoning }
          : { type: 'text' as const, text: turn.text }
        yield { type: 'block-end', index: openBlock.index, block }
      }
    } finally {
      options.signal?.removeEventListener('abort', abort)
      delete session.currentTurn
    }

    const outcome = await promptOutcome
    if (!outcome.ok) {
      await disposeChild(session)
      this.sessions.delete(key)
      const error = outcome.error
      throw new LlmError(
        error instanceof Error ? `${this.config.providerName} ${route.name} ACP failed: ${error.message}` : `${this.config.providerName} ${route.name} ACP failed`,
        options.signal?.aborted === true ? 'ABORTED' : 'PRINCESS_OS_ACP_ERROR',
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
            message: kind === 'aborted' ? `${this.config.providerName} request was cancelled` : `${this.config.providerName} stopped with ${outcome.stopReason}`,
            code: kind === 'aborted' ? 'ABORTED' : 'ACP_ROUTE_STOPPED',
          },
        },
      }
    }
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.allSettled(sessions.map(disposeChild))
  }

  private async resolveCredential(): Promise<{ value: string }> {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new LlmError(`${this.config.providerName} requires the managed credentials service`, 'MISSING_CREDENTIAL_SERVICE')
    }
    const resolved = await credentials.resolve(this.config.credentialEnv)
    if (resolved === undefined || resolved.value.trim() === '') {
      throw new LlmError(`${this.config.providerName} credential handle ${this.config.credentialEnv} is unavailable`, 'MISSING_CREDENTIAL')
    }
    return resolved
  }

  private async startSession(route: AgentRouteConfig): Promise<AcpSession> {
    const credential = this.config.credentialEnv.trim() === '' ? undefined : await this.resolveCredential()
    const credentialEnv = credential === undefined ? {} : { [this.config.credentialEnv]: credential.value }
    const child = this.ctx.subprocess.spawn({
      argv: [this.config.pythonCommand, ACP_COMPAT_LAUNCHER],
      cwd: this.config.workspace,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: 3_000,
      env: {
        HERMES_HOME: route.hermesHome,
        PYTHONPATH: this.config.hermesSource,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        GIANA_OWNER_PRIVATE_BINDING_REQUIRED: route.ownerPrivateWindowsBindingSha256 === '' ? '0' : '1',
        GIANA_OWNER_PRIVATE_WINDOWS_BINDING_SHA256: route.ownerPrivateWindowsBindingSha256,
        ...credentialEnv,
      },
    })
    if (child.stdin === undefined || child.stdout === undefined) {
      throw new LlmError('Princess OS subprocess lost its ACP pipes', 'PRINCESS_OS_ACP_PIPE_ERROR')
    }

    let currentSession: AcpSession | undefined
    const permission = this.config.permission
    const makeClient = (_agent: AcpAgent): Client => ({
      sessionUpdate(params: SessionNotification): Promise<void> {
        const update = params.update
        if (update.sessionUpdate === 'agent_message_chunk' && currentSession?.currentTurn !== undefined) {
          const text = contentText(update.content)
          currentSession.currentTurn.text += text
          currentSession.currentTurn.events.push({ kind: 'text', text })
        }
        if (update.sessionUpdate === 'agent_thought_chunk' && currentSession?.currentTurn !== undefined) {
          const text = contentText(update.content)
          currentSession.currentTurn.reasoning += text
          currentSession.currentTurn.events.push({ kind: 'reasoning', text })
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
      await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const remote = await connection.newSession({ cwd: this.config.workspace, mcpServers: [] })
      currentSession = {
        child,
        connection,
        remoteSessionId: remote.sessionId,
        seenMessageIds: new Set(),
        turnCount: 0,
        disposed: false,
      }
      return currentSession
    } catch (error: unknown) {
      child.terminate()
      await child.waitForExit().catch(() => {})
      throw error
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  assertAbsoluteFile('pythonCommand', config.pythonCommand)
  assertAbsoluteFile('ACP compatibility launcher', ACP_COMPAT_LAUNCHER)
  assertAbsoluteDirectory('hermesSource', config.hermesSource)
  assertAbsoluteDirectory('workspace', config.workspace)
  if (config.agents.length === 0) throw new Error('llm-princess-os: at least one agent is required')
  const routes = new Map<string, AgentRouteConfig>()
  for (const route of config.agents) {
    if (route.id === '' || route.name === '') throw new Error('llm-princess-os: agent id and name must not be empty')
    if (routes.has(route.id)) throw new Error(`llm-princess-os: duplicate agent id "${route.id}"`)
    assertAbsoluteDirectory(`agent ${route.id} hermesHome`, route.hermesHome)
    routes.set(route.id, route)
  }

  const adapter = new PrincessOsAdapter(ctx, config, routes)
  ctx.llm.registerAdapter([config.providerId], adapter)
  ctx.effect(() => () => adapter.dispose(), 'llm-princess-os.sessions()')
}
