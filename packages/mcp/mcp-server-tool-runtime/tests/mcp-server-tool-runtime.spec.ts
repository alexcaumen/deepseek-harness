import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type {
  PreToolDecision,
  ToolDefinition,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import ToolRuntimeMcpServer from '../src/index.ts'
import type { McpToolRuntimeCapability } from '../src/index.ts'

interface LiveAgent {
  agent: Agent
  scope: Scope
  session: Session
  disposeAgent(): void
  disposeSession(): void
}

interface TestRuntime {
  ctx: Context
  clients: Client[]
  agent(name: string): Promise<LiveAgent>
  client(capability: McpToolRuntimeCapability): Promise<Client>
  dispose(): Promise<void>
}

const runtimes: TestRuntime[] = []

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
})

async function mount(path = '/test/mcp'): Promise<TestRuntime> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ApprovalService, {})
  await ctx.plugin(ToolRuntimeMcpServer, { host: '127.0.0.1', port: 0, path })
  const clients: Client[] = []

  const runtime: TestRuntime = {
    ctx,
    clients,
    async agent(name: string): Promise<LiveAgent> {
      const session = ctx.sessions.prepare(SessionId(name))
      const disposeSession = ctx.sessions.enter(session)
      ctx.sessions.announce(session)

      const mutable = {
        id: session.id,
        options: {},
        session,
        inbox: {},
        status: 'idle',
        ctx,
        cancel() {},
        whenIdle: () => Promise.resolve(),
        runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(new AbortController().signal),
        send() {},
        followup() {},
        steer() {},
        inject() {},
      }
      const agent = mutable as unknown as Agent
      let scope!: Scope
      await ctx.plugin(Object.assign(
        (inner: Context) => { scope = createScope(inner, agent) },
        { inject: ['tools', 'systemPrompt'] },
      ))
      mutable.ctx = scope.ctx
      const disposeAgent = ctx.agents.enter(agent, undefined)
      ctx.agents.announce(agent)
      return { agent, scope, session, disposeAgent, disposeSession }
    },
    async client(capability: McpToolRuntimeCapability): Promise<Client> {
      const transport = new StreamableHTTPClientTransport(new URL(capability.endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${capability.token}` } },
      })
      const client = new Client({ name: 'bridge-test', version: '1.0.0' }, { capabilities: {} })
      // SDK optional callback fields currently need this exact-optional widening.
      await client.connect(transport as Transport)
      clients.push(client)
      return client
    },
    async dispose(): Promise<void> {
      await Promise.allSettled(clients.map(client => client.close()))
      await ctx.fiber.dispose()
    },
  }
  runtimes.push(runtime)
  return runtime
}

function tool(name: string, execute: ToolDefinition['execute'] = async args => args): ToolDefinition {
  return {
    name,
    description: `description:${name}`,
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 1234,
    isConcurrencySafe: () => true,
    execute,
  }
}

type ImageAttachmentRef = Extract<ContentBlock, { type: 'image' }>['attachment']

function imageRef(digit: string, bytes: number): ImageAttachmentRef {
  return {
    attachmentId: `sha256:${digit.repeat(64)}` as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png',
    bytes,
    width: 1,
    height: 1,
    name: 'pixel.png',
  }
}

function contentTool(name: string, content: ContentBlock[]): ToolDefinition {
  return {
    ...tool(name, async () => ({})),
    output: { schema: {}, render: () => content },
  }
}

function provideImageReader(
  ctx: Context,
  readImage: (
    ref: ImageAttachmentRef,
    signal?: AbortSignal,
  ) => Promise<{ ref: ImageAttachmentRef; data: Uint8Array }>,
  limits: Partial<{
    maxImageBytes: number
    maxImagesPerMessage: number
    maxMessageImageBytes: number
  }> = {},
): void {
  ctx.provide('attachments', {
    imageLimits: {
      maxImageBytes: limits.maxImageBytes ?? 1024,
      maxImagesPerMessage: limits.maxImagesPerMessage ?? 4,
      maxMessageImageBytes: limits.maxMessageImageBytes ?? 4096,
      maxImagePixels: 1,
      maxImageDimension: 1,
      mediaTypes: ['image/png'],
    },
    readImage,
  } as never)
}

function structuredResult(result: Awaited<ReturnType<Client['callTool']>>): ToolExecutionResult {
  return (result.structuredContent as { result: ToolExecutionResult }).result
}

async function rawInitialize(
  endpoint: string,
  authorization?: string,
): Promise<{ status: number; text: string }> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...authorization === undefined ? {} : { Authorization: authorization },
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw-test', version: '1.0.0' },
      },
    }),
  })
  return { status: response.status, text: await response.text() }
}

describe('ToolRuntimeMcpServer', () => {
  it('requires bearer auth and never reflects missing or forged credentials', async () => {
    const { ctx, agent } = await mount()
    const live = await agent('auth-agent')
    const capability = ctx.mcpToolRuntime.issue(live.agent)
    const forged = 'forged-super-secret-token'

    const missing = await rawInitialize(capability.endpoint)
    const wrong = await rawInitialize(capability.endpoint, `Bearer ${forged}`)

    expect(missing.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(missing.text).not.toContain(capability.token)
    expect(wrong.text).not.toContain(capability.token)
    expect(wrong.text).not.toContain(forged)
  })

  it('binds only the configured exact path and rejects public bind configuration', async () => {
    const runtime = await mount('/exact/mcp')
    const live = await runtime.agent('path-agent')
    const capability = runtime.ctx.mcpToolRuntime.issue(live.agent)
    const wrong = await rawInitialize(capability.endpoint.replace('/exact/mcp', '/mcp'))

    expect(runtime.ctx.mcpToolRuntime.host).toBe('127.0.0.1')
    expect(runtime.ctx.mcpToolRuntime.path).toBe('/exact/mcp')
    expect(wrong.status).toBe(404)

    const isolated = new Context()
    expect(() => new ToolRuntimeMcpServer(isolated, { host: '0.0.0.0' as '127.0.0.1' }))
      .toThrow(/numeric loopback/)
    await isolated.fiber.dispose()
  })

  it('projects only model schemas and preserves the typed ToolRuntime success', async () => {
    const runtime = await mount()
    const live = await runtime.agent('schema-agent')
    live.scope.ctx.tools.register(tool('echo'))
    const client = await runtime.client(runtime.ctx.mcpToolRuntime.issue(live.agent))

    const listed = await client.listTools()
    expect(listed.tools).toEqual([{
      name: 'echo',
      description: 'description:echo',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        additionalProperties: false,
      },
    }])

    const called = await client.callTool({ name: 'echo', arguments: { value: 'typed' } })
    expect(structuredResult(called)).toMatchObject({
      isError: false,
      value: { value: 'typed' },
      content: [{ type: 'text', text: '{"value":"typed"}' }],
    })
  })

  it('isolates agent scopes and rejects direct calls to hidden tools', async () => {
    const runtime = await mount()
    const first = await runtime.agent('scope-a')
    const second = await runtime.agent('scope-b')
    runtime.ctx.tools.register(tool('global-hidden'))
    first.scope.ctx.tools.restrict({ deny: ['global-hidden'] })
    first.scope.ctx.tools.register(tool('only-a'))
    second.scope.ctx.tools.register(tool('only-b'))
    const firstClient = await runtime.client(runtime.ctx.mcpToolRuntime.issue(first.agent))
    const secondClient = await runtime.client(runtime.ctx.mcpToolRuntime.issue(second.agent))

    expect((await firstClient.listTools()).tools.map(entry => entry.name)).toEqual(['only-a'])
    expect((await secondClient.listTools()).tools.map(entry => entry.name).sort())
      .toEqual(['global-hidden', 'only-b'])

    const hidden = await firstClient.callTool({ name: 'global-hidden', arguments: {} })
    expect(structuredResult(hidden)).toMatchObject({
      isError: true,
      error: { info: { code: 'UNKNOWN_TOOL' } },
    })
    const otherScope = await firstClient.callTool({ name: 'only-b', arguments: {} })
    expect(structuredResult(otherScope)).toMatchObject({
      isError: true,
      error: { info: { code: 'UNKNOWN_TOOL' } },
    })
  })

  it('revokes the bearer token when its exact session ends', async () => {
    const runtime = await mount()
    const live = await runtime.agent('revoked-agent')
    const capability = runtime.ctx.mcpToolRuntime.issue(live.agent)
    const client = await runtime.client(capability)
    await expect(client.listTools()).resolves.toBeDefined()

    live.disposeSession()

    const retried = await rawInitialize(capability.endpoint, `Bearer ${capability.token}`)
    expect(retried.status).toBe(401)
    expect(retried.text).not.toContain(capability.token)
  })

  it('preserves scoped guards and routes approval with the exact agent and signal', async () => {
    const runtime = await mount()
    const live = await runtime.agent('policy-agent')
    live.session.append('turn/start', { turn: 1 })
    let guardedRuns = 0
    let approvalRuns = 0
    let approvalRequest: ApprovalRequest | undefined
    live.scope.ctx.tools.register(tool('guarded', async () => { guardedRuns += 1; return 'ran' }))
    live.scope.ctx.tools.register(tool('approval', async () => { approvalRuns += 1; return 'approved' }))
    live.scope.ctx.tools.guard(exec => exec.name === 'guarded' ? 'blocked by exact scope guard' : undefined)
    runtime.ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      return exec.name === 'approval' ? { kind: 'ask', reason: 'external call approval' } : next()
    })
    runtime.ctx.on('approval/request', (request) => {
      approvalRequest = request
      return Promise.resolve('allowed-once')
    })
    const client = await runtime.client(runtime.ctx.mcpToolRuntime.issue(live.agent))

    const guarded = await client.callTool({ name: 'guarded', arguments: {} })
    const approved = await client.callTool({ name: 'approval', arguments: {} })

    expect(structuredResult(guarded)).toMatchObject({
      isError: true,
      error: { message: 'blocked by exact scope guard' },
    })
    expect(guardedRuns).toBe(0)
    expect(structuredResult(approved)).toMatchObject({ isError: false, value: 'approved' })
    expect(approvalRuns).toBe(1)
    expect(approvalRequest).toMatchObject({
      agent: live.agent,
      toolName: 'approval',
      reason: 'external call approval',
    })
    expect(approvalRequest?.signal).toBeInstanceOf(AbortSignal)
  })

  it('transports authorized image bytes and MIME as typed MCP content', async () => {
    const runtime = await mount()
    const data = Uint8Array.of(0x89, 0x50, 0x4e, 0x47)
    const attachment = imageRef('1', data.byteLength)
    const readImage = vi.fn(async (ref: ImageAttachmentRef, signal?: AbortSignal) => {
      signal?.throwIfAborted()
      return { ref, data }
    })
    provideImageReader(runtime.ctx, readImage)
    const live = await runtime.agent('image-agent')
    live.scope.ctx.tools.register(contentTool('image-result', [
      { type: 'text', text: 'captured image' },
      { type: 'image', attachment },
    ]))
    const client = await runtime.client(runtime.ctx.mcpToolRuntime.issue(live.agent))

    const result = await client.callTool({ name: 'image-result', arguments: {} })

    expect(result.content).toEqual([
      { type: 'text', text: 'captured image' },
      { type: 'image', data: Buffer.from(data).toString('base64'), mimeType: 'image/png' },
    ])
    expect(readImage).toHaveBeenCalledWith(attachment, expect.any(AbortSignal))
    expect(JSON.stringify(result.content)).not.toContain(attachment.attachmentId)
    expect(JSON.stringify(result.content)).not.toContain(attachment.name)
    expect(structuredResult(result).content).toEqual([
      { type: 'text', text: 'captured image' },
      { type: 'image', attachment },
    ])
  })

  it('fails closed before reading an image whose declared bytes exceed the fixed transport budget', async () => {
    const runtime = await mount()
    const bytes = 20 * 1024 * 1024 + 1
    const attachment = imageRef('2', bytes)
    const readImage = vi.fn(async (ref: ImageAttachmentRef) => ({ ref, data: new Uint8Array(bytes) }))
    provideImageReader(runtime.ctx, readImage, { maxImageBytes: bytes, maxMessageImageBytes: bytes })
    const live = await runtime.agent('oversize-image-agent')
    live.scope.ctx.tools.register(contentTool('oversize-image', [{ type: 'image', attachment }]))
    const client = await runtime.client(runtime.ctx.mcpToolRuntime.issue(live.agent))

    const result = await client.callTool({ name: 'oversize-image', arguments: {} })

    expect(readImage).not.toHaveBeenCalled()
    expect(result.content).toEqual([{ type: 'text', text: 'Error: tool bridge request failed' }])
    expect(structuredResult(result)).toMatchObject({
      isError: true,
      error: { info: { code: 'BRIDGE_FAILURE' } },
    })
    expect(JSON.stringify(result)).not.toContain(attachment.attachmentId)
  })

  it('fails closed without partial bytes or backend details when an image read fails', async () => {
    const runtime = await mount()
    const first = imageRef('3', 3)
    const second = imageRef('4', 3)
    const firstData = Uint8Array.of(1, 2, 3)
    const backendDetail = String.raw`N:\private\captures\missing.png`
    const readImage = vi.fn(async (ref: ImageAttachmentRef) => {
      if (ref.attachmentId === second.attachmentId) throw new Error(backendDetail)
      return { ref, data: firstData }
    })
    provideImageReader(runtime.ctx, readImage)
    const live = await runtime.agent('missing-image-agent')
    live.scope.ctx.tools.register(contentTool('missing-image', [
      { type: 'image', attachment: first },
      { type: 'image', attachment: second },
    ]))
    const client = await runtime.client(runtime.ctx.mcpToolRuntime.issue(live.agent))

    const result = await client.callTool({ name: 'missing-image', arguments: {} })
    const serialized = JSON.stringify(result)

    expect(readImage).toHaveBeenCalledTimes(2)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: tool bridge request failed' }])
    expect(serialized).not.toContain(Buffer.from(firstData).toString('base64'))
    expect(serialized).not.toContain(backendDetail)
    expect(serialized).not.toContain(first.attachmentId)
    expect(serialized).not.toContain(second.attachmentId)
  })

  it('propagates MCP cancellation into ToolRuntime and drains the tool body', async () => {
    const runtime = await mount()
    const live = await runtime.agent('cancel-agent')
    const entered = Promise.withResolvers<boolean>()
    const bodySettled = Promise.withResolvers<boolean>()
    let finalResult: ToolExecutionResult | undefined
    live.scope.ctx.tools.register(tool('slow', async (_args, exec) => {
      entered.resolve(true)
      await new Promise<void>((resolve) => {
        if (exec.signal.aborted) resolve()
        else exec.signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      bodySettled.resolve(true)
      return 'late-success'
    }))
    runtime.ctx.on('tools/result', (exec, result) => {
      if (exec.name === 'slow') finalResult = result
      return undefined
    })
    const client = await runtime.client(runtime.ctx.mcpToolRuntime.issue(live.agent))
    const controller = new AbortController()
    const pending = client.callTool(
      { name: 'slow', arguments: {} },
      undefined,
      { signal: controller.signal },
    )

    await entered.promise
    controller.abort(new Error('test cancellation'))
    await expect(pending).rejects.toThrow()
    await bodySettled.promise
    await vi.waitFor(() => {
      expect(finalResult).toMatchObject({
        isError: true,
        error: { info: { code: TOOL_ABORTED } },
      })
    })
  })

  it('contains unexpected bridge failures without exposing their secret text', async () => {
    const runtime = await mount()
    const live = await runtime.agent('secret-agent')
    live.scope.ctx.tools.register(tool('secret-probe'))
    const secret = 'provider-key-never-return-this'
    vi.spyOn(runtime.ctx.tools, 'execute').mockRejectedValueOnce(new Error(secret))
    const client = await runtime.client(runtime.ctx.mcpToolRuntime.issue(live.agent))

    const result = await client.callTool({ name: 'secret-probe', arguments: {} })
    const serialized = JSON.stringify(result)

    expect(serialized).not.toContain(secret)
    expect(structuredResult(result)).toMatchObject({
      isError: true,
      error: { info: { code: 'BRIDGE_FAILURE' } },
    })
  })
})
