/**
 * Authenticated loopback MCP bridge for one exact live DSH agent/session scope.
 * @module @deepseek-ai/dsh-mcp-server-tool-runtime
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type {
  CallToolResult,
  ContentBlock as McpContentBlock,
  ImageContent as McpImageContent,
} from '@modelcontextprotocol/sdk/types.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecutionFailure, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

const DEFAULT_PATH = '/mcp/tool-runtime'
const MAX_REQUEST_BYTES = 1024 * 1024
const MAX_RESULT_IMAGES = 20
const MAX_RESULT_IMAGE_BYTES = 20 * 1024 * 1024
const PATH_PATTERN = /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/

type ImageBlock = Extract<ContentBlock, { type: 'image' }>

/** AttachmentStore members used to materialize typed image blocks. */
interface ImageAttachmentReader {
  readonly imageLimits: {
    readonly maxImageBytes: number
    readonly maxImagesPerMessage: number
    readonly maxMessageImageBytes: number
    readonly mediaTypes: readonly ImageBlock['attachment']['mediaType'][]
  }
  readImage(
    ref: ImageBlock['attachment'],
    signal?: AbortSignal,
  ): Promise<{ readonly ref: ImageBlock['attachment']; readonly data: Uint8Array }>
}

/** The only addresses this service may bind. */
export type LoopbackHost = '127.0.0.1' | '::1'

/** Loopback listener configuration. */
export interface Config {
  /** Numeric loopback address. Public and wildcard binds are rejected. */
  host?: LoopbackHost
  /** TCP port, or zero for an OS-assigned port. */
  port?: number
  /** Exact MCP endpoint path. */
  path?: string
}

/** Opaque external capability for one exact live DSH agent/session pair. */
export interface McpToolRuntimeCapability {
  /** Streamable HTTP MCP endpoint; the token is never placed in the URL. */
  readonly endpoint: string
  /** Opaque bearer token. */
  readonly token: string
  /** Revoke this capability and abort its active calls. */
  revoke(): Promise<void>
}

interface Binding {
  readonly agent: Agent
  readonly session: Session
  readonly token: string
  readonly abort: AbortController
  readonly connections: Map<string, McpConnection>
  readonly initializing: Set<McpConnection>
  revoked: boolean
}

interface McpConnection {
  readonly binding: Binding
  readonly server: Server
  readonly transport: StreamableHTTPServerTransport
  sessionId?: string
  closeTask?: Promise<void>
}

class HttpFailure extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpToolRuntime: ToolRuntimeMcpServer
  }
}

/**
 * Cordis service plugin exposing scoped ToolRuntime calls over authenticated
 * loopback Streamable HTTP.
 */
export class ToolRuntimeMcpServer extends Service {
  static inject = ['tools', 'agents', 'sessions']

  static Config: z<Config> = z.object({
    host: z.union([z.const('127.0.0.1'), z.const('::1')]).default('127.0.0.1'),
    port: z.natural().max(65535).default(0),
    path: z.string().pattern(PATH_PATTERN).default(DEFAULT_PATH),
  })

  private readonly hostValue: LoopbackHost
  private readonly requestedPort: number
  private readonly pathValue: string
  private readonly bindings = new Map<string, Binding>()
  private readonly sessions = new WeakMap<Session, Binding>()
  private readonly sockets = new Set<Socket>()
  private server?: HttpServer
  private portValue?: number
  private stopping?: Promise<void>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'mcpToolRuntime')
    this.hostValue = resolveHost(config.host)
    this.requestedPort = resolvePort(config.port)
    this.pathValue = resolvePath(config.path)

    ctx.on('agent/disposed', ({ agent }) => {
      const binding = this.sessions.get(agent.session)
      if (binding?.agent === agent) void this.revokeBinding(binding)
    })
    ctx.on('session/disposed', (session) => {
      const binding = this.sessions.get(session)
      if (binding !== undefined) void this.revokeBinding(binding)
    })
  }

  /** Configured numeric loopback host. */
  get host(): LoopbackHost {
    return this.hostValue
  }

  /** Listening port, including the OS-assigned value when configured as zero. */
  get port(): number {
    if (this.portValue === undefined) throw new Error('mcp tool runtime server is not listening')
    return this.portValue
  }

  /** Exact endpoint path. */
  get path(): string {
    return this.pathValue
  }

  /** Complete loopback endpoint without credentials. */
  get endpoint(): string {
    const host = this.hostValue === '::1' ? '[::1]' : this.hostValue
    return `http://${host}:${this.port}${this.pathValue}`
  }

  /**
   * Issue or retrieve the single capability for an exact live agent/session.
   * Object identity, not a caller-supplied id, is the authorization boundary.
   * @param agent - Exact live Giana Code agent whose session owns the capability.
   * @returns an opaque, revocable loopback MCP capability for that agent/session.
   */
  issue(agent: Agent): McpToolRuntimeCapability {
    if (this.ctx.agents.get(agent.id) !== agent || this.ctx.sessions.get(agent.session.id) !== agent.session) {
      throw new Error('cannot issue MCP capability for an agent/session that is not exactly live')
    }
    if (agent.id !== agent.session.id) {
      throw new Error('cannot issue MCP capability for a mismatched agent/session identity')
    }
    const current = this.sessions.get(agent.session)
    if (current !== undefined && !current.revoked) {
      if (current.agent !== agent) throw new Error('session already has an MCP capability for another agent')
      return this.capability(current)
    }
    const binding: Binding = {
      agent,
      session: agent.session,
      token: randomBytes(32).toString('base64url'),
      abort: new AbortController(),
      connections: new Map(),
      initializing: new Set(),
      revoked: false,
    }
    this.bindings.set(binding.token, binding)
    this.sessions.set(binding.session, binding)
    return this.capability(binding)
  }

  async [Service.init](): Promise<void> {
    this.server = createServer((req, res) => {
      this.handleHttp(req, res).catch(() => {
        writeJson(res, 500, rpcError('tool bridge request failed'))
      })
    })
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => { this.sockets.delete(socket) })
    })
    await new Promise<void>((resolve, reject) => {
      const server = this.server as HttpServer
      server.once('error', reject)
      server.listen(this.requestedPort, this.hostValue, () => {
        server.off('error', reject)
        const address = server.address() as AddressInfo
        this.portValue = address.port
        resolve()
      })
    })
    this.ctx.effect(() => () => this.shutdown(), 'mcpToolRuntime.listen')
  }

  private capability(binding: Binding): McpToolRuntimeCapability {
    return Object.freeze({
      endpoint: this.endpoint,
      token: binding.token,
      revoke: () => this.revokeBinding(binding),
    })
  }

  private bindingFor(req: IncomingMessage): Binding | undefined {
    const authorization = req.headers.authorization
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return undefined
    const token = authorization.slice('Bearer '.length)
    if (token.length === 0 || /\s/.test(token)) return undefined
    const binding = this.bindings.get(token)
    return binding !== undefined && !binding.revoked ? binding : undefined
  }

  private bindingIsLive(binding: Binding): boolean {
    return !binding.revoked
      && this.bindings.get(binding.token) === binding
      && this.ctx.agents.get(binding.agent.id) === binding.agent
      && this.ctx.sessions.get(binding.session.id) === binding.session
      && binding.agent.session === binding.session
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = requestPath(req)
    if (pathname !== this.pathValue) {
      writeJson(res, 404, rpcError('not found'))
      return
    }
    if (req.headers.host !== this.expectedHostHeader()) {
      writeJson(res, 421, rpcError('misdirected request'))
      return
    }
    const binding = this.bindingFor(req)
    if (binding === undefined || !this.bindingIsLive(binding)) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      writeJson(res, 401, rpcError('unauthorized'))
      return
    }

    let body: unknown
    if (req.method === 'POST') {
      try {
        body = await readJsonBody(req)
      } catch (error: unknown) {
        const status = error instanceof HttpFailure ? error.status : 400
        writeJson(res, status, rpcError(status === 413 ? 'request too large' : 'invalid JSON request'))
        return
      }
    }

    const sessionHeader = req.headers['mcp-session-id']
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined
    const existing = sessionId === undefined ? undefined : binding.connections.get(sessionId)
    if (existing !== undefined) {
      await existing.transport.handleRequest(req, res, body)
      return
    }
    if (req.method !== 'POST' || sessionId !== undefined || !isInitializeRequest(body)) {
      writeJson(res, sessionId === undefined ? 400 : 404, rpcError('invalid MCP session'))
      return
    }
    await this.initializeConnection(binding, req, res, body)
  }

  private async initializeConnection(
    binding: Binding,
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const server = this.createMcpServer(binding)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        if (!this.bindingIsLive(binding)) {
          void this.closeConnection(connection)
          return
        }
        connection.sessionId = sessionId
        binding.initializing.delete(connection)
        binding.connections.set(sessionId, connection)
      },
      onsessionclosed: () => { void this.closeConnection(connection) },
    })
    const connection: McpConnection = { binding, server, transport }
    binding.initializing.add(connection)
    transport.onclose = () => { void this.closeConnection(connection) }
    transport.onerror = () => { void this.closeConnection(connection) }
    try {
      await server.connect(transport as Transport)
      if (!this.bindingIsLive(binding)) throw new Error('authorization expired')
      await transport.handleRequest(req, res, body)
    } catch {
      await this.closeConnection(connection)
      writeJson(res, 500, rpcError('tool bridge request failed'))
    } finally {
      if (connection.sessionId === undefined) await this.closeConnection(connection)
    }
  }

  private createMcpServer(binding: Binding): Server {
    const server = new Server(
      { name: 'dsh-tool-runtime', version: '0.1.1-rc.2' },
      { capabilities: { tools: {} } },
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (!this.bindingIsLive(binding)) throw new Error('authorization expired')
      return {
        tools: this.ctx.tools.schemas(binding.agent).map(schema => ({
          name: schema.name,
          description: schema.description,
          inputSchema: schema.parameters,
        })),
      }
    })
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      return this.callTool(binding, request.params.name, request.params.arguments ?? {}, extra.signal)
    })
    return server
  }

  private async callTool(
    binding: Binding,
    name: string,
    args: Record<string, unknown>,
    requestSignal: AbortSignal,
  ): Promise<CallToolResult> {
    if (!this.bindingIsLive(binding)) {
      return projectResult(binding.agent.ctx, unknownToolResult(name), requestSignal)
    }
    const visible = this.ctx.tools.schemas(binding.agent).some(schema => schema.name === name)
    if (!visible) return projectResult(binding.agent.ctx, unknownToolResult(name), requestSignal)

    const fused = fuseSignals(requestSignal, binding.abort.signal)
    try {
      const result = await this.ctx.agents.withInitiator(binding.agent, () => this.ctx.tools.execute({
        callId: CallId(`mcp-${randomUUID()}`),
        name,
        arguments: args,
        agent: binding.agent,
        signal: fused.signal,
      }))
      return await projectResult(binding.agent.ctx, result, fused.signal)
    } catch {
      return await projectResult(binding.agent.ctx, bridgeFailureResult(), fused.signal)
    } finally {
      fused.dispose()
    }
  }

  private expectedHostHeader(): string {
    return this.hostValue === '::1' ? `[::1]:${this.port}` : `${this.hostValue}:${this.port}`
  }

  private async revokeBinding(binding: Binding): Promise<void> {
    if (binding.revoked) return
    binding.revoked = true
    this.bindings.delete(binding.token)
    if (this.sessions.get(binding.session) === binding) this.sessions.delete(binding.session)
    binding.abort.abort(new Error('MCP tool runtime capability revoked'))
    const connections = [...binding.initializing, ...binding.connections.values()]
    binding.initializing.clear()
    binding.connections.clear()
    await Promise.all(connections.map(connection => this.closeConnection(connection)))
  }

  private closeConnection(connection: McpConnection): Promise<void> {
    if (connection.closeTask !== undefined) return connection.closeTask
    connection.binding.initializing.delete(connection)
    if (connection.sessionId !== undefined
      && connection.binding.connections.get(connection.sessionId) === connection) {
      connection.binding.connections.delete(connection.sessionId)
    }
    const closed = Promise.withResolvers<void>()
    // Publish the task before Server.close() synchronously reaches the
    // transport's onclose callback. Server.close() owns transport closure.
    connection.closeTask = closed.promise
    try {
      void connection.server.close().then(closed.resolve, () => { closed.resolve() })
    } catch {
      closed.resolve()
    }
    return connection.closeTask
  }

  private shutdown(): Promise<void> {
    this.stopping ??= (async () => {
      await Promise.all([...this.bindings.values()].map(binding => this.revokeBinding(binding)))
      const server = this.server
      if (server === undefined) return
      const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      server.closeAllConnections()
      for (const socket of this.sockets) socket.destroy()
      await closed
    })()
    return this.stopping
  }
}

function resolveHost(host: Config['host']): LoopbackHost {
  const value = host ?? '127.0.0.1'
  if (value !== '127.0.0.1' && value !== '::1') {
    throw new Error('mcp tool runtime host must be numeric loopback (127.0.0.1 or ::1)')
  }
  return value
}

function resolvePort(port: number | undefined): number {
  const value = port ?? 0
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error('mcp tool runtime port must be an integer from 0 through 65535')
  }
  return value
}

function resolvePath(path: string | undefined): string {
  const value = path ?? DEFAULT_PATH
  if (!PATH_PATTERN.test(value)) {
    throw new Error('mcp tool runtime path must be an exact absolute path without a trailing slash')
  }
  return value
}

function requestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://loopback.invalid').pathname
  } catch {
    return ''
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw new HttpFailure(413, 'request too large')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
    size += chunk.byteLength
    if (size > MAX_REQUEST_BYTES) throw new HttpFailure(413, 'request too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new HttpFailure(400, 'invalid JSON request')
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  })
  res.end(JSON.stringify(body))
}

function rpcError(message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', error: { code: -32000, message }, id: null }
}

async function projectResult(
  ctx: Context,
  result: ToolExecutionResult,
  signal: AbortSignal,
): Promise<CallToolResult> {
  return {
    content: await projectContent(ctx, result.content, signal),
    structuredContent: { result },
    ...result.isError ? { isError: true } : {},
  }
}

function projectNonImage(block: ContentBlock): McpContentBlock {
  if (block.type === 'text') return { type: 'text', text: block.text }
  return { type: 'text', text: `[DSH ${block.type} content; inspect structuredContent.result.content]` }
}

async function projectContent(
  ctx: Context,
  blocks: readonly ContentBlock[],
  signal: AbortSignal,
): Promise<McpContentBlock[]> {
  const images = blocks.flatMap((block, index) => block.type === 'image' ? [{ block, index }] : [])
  if (images.length === 0) return blocks.map(projectNonImage)

  const attachments = ctx.get('attachments') as ImageAttachmentReader | undefined
  if (attachments === undefined) throw new Error('image attachment service is unavailable')
  const maxImages = Math.min(MAX_RESULT_IMAGES, attachments.imageLimits.maxImagesPerMessage)
  const maxImageBytes = Math.min(MAX_RESULT_IMAGE_BYTES, attachments.imageLimits.maxImageBytes)
  const maxMessageBytes = Math.min(MAX_RESULT_IMAGE_BYTES, attachments.imageLimits.maxMessageImageBytes)
  if (images.length > maxImages) throw new Error('tool result image count exceeds the transport limit')

  let declaredBytes = 0
  for (const { block } of images) {
    if (!attachments.imageLimits.mediaTypes.includes(block.attachment.mediaType)) {
      throw new Error('tool result image media type is not admitted')
    }
    if (block.attachment.bytes > maxImageBytes) {
      throw new Error('tool result image exceeds the transport limit')
    }
    declaredBytes += block.attachment.bytes
    if (declaredBytes > maxMessageBytes) {
      throw new Error('tool result image batch exceeds the transport limit')
    }
  }

  const projected = new Map<number, McpImageContent>()
  let actualBytes = 0
  for (const { block, index } of images) {
    signal.throwIfAborted()
    const stored = await attachments.readImage(block.attachment, signal)
    signal.throwIfAborted()
    if (stored.ref.attachmentId !== block.attachment.attachmentId
      || stored.ref.mediaType !== block.attachment.mediaType
      || stored.ref.bytes !== block.attachment.bytes
      || stored.data.byteLength !== stored.ref.bytes) {
      throw new Error('stored image does not match its authorized attachment reference')
    }
    if (!attachments.imageLimits.mediaTypes.includes(stored.ref.mediaType)
      || stored.data.byteLength > maxImageBytes) {
      throw new Error('stored image exceeds the transport limit')
    }
    actualBytes += stored.data.byteLength
    if (actualBytes > maxMessageBytes) {
      throw new Error('stored image batch exceeds the transport limit')
    }
    projected.set(index, {
      type: 'image',
      data: Buffer.from(stored.data).toString('base64'),
      mimeType: stored.ref.mediaType,
    })
  }

  return blocks.map((block, index) => {
    if (block.type !== 'image') return projectNonImage(block)
    const image = projected.get(index)
    if (image === undefined) throw new Error('tool result image projection is incomplete')
    return image
  })
}

function unknownToolResult(name: string): ToolExecutionFailure {
  const message = `unknown tool "${name}"`
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    error: { message, info: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' } },
  }
}

function bridgeFailureResult(): ToolExecutionFailure {
  return {
    isError: true,
    content: [{ type: 'text', text: 'Error: tool bridge request failed' }],
    error: {
      message: 'tool bridge request failed',
      info: { name: 'ToolBridgeError', code: 'BRIDGE_FAILURE' },
    },
  }
}

function fuseSignals(first: AbortSignal, second: AbortSignal): { signal: AbortSignal; dispose(): void } {
  if (first === second) return { signal: first, dispose() {} }
  const controller = new AbortController()
  const abortFirst = (): void => { controller.abort(first.reason); dispose() }
  const abortSecond = (): void => { controller.abort(second.reason); dispose() }
  let listening = false
  const dispose = (): void => {
    if (!listening) return
    listening = false
    first.removeEventListener('abort', abortFirst)
    second.removeEventListener('abort', abortSecond)
  }
  if (first.aborted) abortFirst()
  else if (second.aborted) abortSecond()
  else {
    listening = true
    first.addEventListener('abort', abortFirst, { once: true })
    second.addEventListener('abort', abortSecond, { once: true })
  }
  return { signal: controller.signal, dispose }
}

export default ToolRuntimeMcpServer
