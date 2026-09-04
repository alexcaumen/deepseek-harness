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
import ToolRuntime, { RUN_CODE_NAME, TOOL_ABORTED, defineTool } from '@deepseek-ai/dsh-tools'
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

type CodeRunRequest = Parameters<Context['codeRuntime']['run']>[0]
type CodeRunResult = Awaited<ReturnType<Context['codeRuntime']['run']>>

function provideCodeRuntime(ctx: Context, language = 'typescript') {
  // Exercise the real ToolRuntime bindings without mounting a worker or interpreter.
  const runtime = {
    language,
    isolation: 'fake',
    behavior: (_request: CodeRunRequest): Promise<CodeRunResult> => Promise.resolve({ logs: [] }),
    run: vi.fn((request: CodeRunRequest): Promise<CodeRunResult> => runtime.behavior(request)),
  }
  ctx.provide('codeRuntime', runtime as never)
  return runtime
}

function callCode(client: Client, code = 'return await tools.echo({ value: "nested" })') {
  return client.callTool({
    name: RUN_CODE_NAME,
    arguments: { code, description: 'Run the bridge regression program' },
  })
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
    const runtime = await mount()
    const live = await runtime.agent('auth-agent')
    const capability = runtime.ctx.mcpToolRuntime.issue(live.agent)
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

  it('matches direct and nested calls to each agent presentation before tools/list', async () => {
    const runtime = await mount()
    const codeRuntime = provideCodeRuntime(runtime.ctx)
    const calls: { agent: Agent | undefined; initiator: Agent | undefined; args: unknown }[] = []
    runtime.ctx.tools.register(tool('echo', async (args, exec) => {
      calls.push({ agent: exec.agent, initiator: runtime.ctx.agents.currentInitiator(), args })
      return args
    }))
    codeRuntime.behavior = async request => ({
      logs: [],
      value: await request.bindings[0]!.functions.echo!({ value: 'nested' }),
    })
    const execute = vi.spyOn(runtime.ctx.tools, 'execute')

    for (const mode of ['native', 'code', 'both'] as const) {
      const live = await runtime.agent(`presentation-${mode}`)
      live.session.append('turn/start', { turn: 1 })
      if (mode !== 'native') live.scope.ctx.tools.presentAs(mode)
      const client = await runtime.client(runtime.ctx.mcpToolRuntime.issue(live.agent))
      execute.mockClear()
      const before = calls.length

      const direct = await client.callTool({ name: 'echo', arguments: { value: 'direct' } })
      if (mode === 'code') {
        expect(structuredResult(direct)).toMatchObject({
          isError: true,
          error: { info: { code: 'UNKNOWN_TOOL' } },
        })
        expect(execute).not.toHaveBeenCalled()
      } else {
        expect(structuredResult(direct)).toMatchObject({ isError: false, value: { value: 'direct' } })
      }

      const dispatched = execute.mock.calls.length
      const nested = await callCode(client)
      if (mode === 'native') {
        expect(structuredResult(nested)).toMatchObject({
          isError: true,
          error: { info: { code: 'UNKNOWN_TOOL' } },
        })
        expect(execute).toHaveBeenCalledTimes(dispatched)
        expect(runtime.ctx.tools.codeSdk(live.agent)).toBe('')
      } else {
        expect(structuredResult(nested)).toMatchObject({
          isError: false,
          value: { logs: [], result: { value: 'nested' } },
        })
      }
      expect(calls.slice(before)).toEqual((mode === 'both' ? ['direct', 'nested'] : [mode === 'code' ? 'nested' : 'direct'])
        .map(value => ({ agent: live.agent, initiator: live.agent, args: { value } })))

      const listed = await client.listTools()
      expect(listed.tools.map(entry => entry.name)).toEqual(mode === 'native'
        ? ['echo']
        : mode === 'code' ? [RUN_CODE_NAME] : ['echo', RUN_CODE_NAME])
      expect(listed.tools).toEqual(runtime.ctx.tools.wireSchemas(live.agent).schemas.map(schema => ({
        name: schema.name,
        description: schema.name === RUN_CODE_NAME
          ? `${schema.description}\n\n${runtime.ctx.tools.codeSdk(live.agent)}`
          : schema.description,
        inputSchema: schema.parameters,
      })))
    }
    expect(codeRuntime.run).toHaveBeenCalledTimes(2)
  })

  it.each(['code', 'both'] as const)('refreshes %s SDK and dispatch authority on live restriction and undo', async (mode) => {
    const runtime = await mount()
    const codeRuntime = provideCodeRuntime(runtime.ctx)
    const live = await runtime.agent(`restrict-${mode}`)
    const sibling = await runtime.agent(`hidden-${mode}`)
    live.session.append('turn/start', { turn: 1 })
    live.scope.ctx.tools.presentAs(mode)
    const secretRuns = vi.fn(async (args: unknown) => args)
    const siblingRuns = vi.fn(async (args: unknown) => args)
    runtime.ctx.tools.register(tool('echo'))
    runtime.ctx.tools.register(tool('secret_tool', secretRuns))
    sibling.scope.ctx.tools.register(tool('sibling_secret', siblingRuns))
    const client = await runtime.client(runtime.ctx.mcpToolRuntime.issue(live.agent))
    codeRuntime.behavior = async request => ({
      logs: [],
      value: await request.bindings[0]!.functions.secret_tool!({ value: 'visible' }),
    })

    expect(structuredResult(await callCode(client, 'return await tools.secret_tool({ value: "visible" })')))
      .toMatchObject({ isError: false, value: { result: { value: 'visible' } } })
    const initial = await client.listTools()
    const initialDescription = initial.tools.find(entry => entry.name === RUN_CODE_NAME)?.description
    expect(initialDescription).toContain('secret_tool:')
    expect(initialDescription).not.toContain('sibling_secret')

    let undo!: () => void
    codeRuntime.behavior = async (request) => {
      const functions = request.bindings[0]!.functions
      const retained = functions.secret_tool!
      undo = live.scope.ctx.tools.restrict({ allow: ['echo'] })
      const denied = await retained({ value: 'must-not-run' }).then(
        () => 'unexpected success',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      )
      return { logs: [], value: { denied, kept: await functions.echo!({ value: 'kept' }) } }
    }
    const restrictedDuringRun = structuredResult(await callCode(client, 'return await tools.secret_tool({ value: "must-not-run" })'))
    expect(restrictedDuringRun).toMatchObject({
      isError: false,
      value: { result: { denied: 'unknown tool "secret_tool"', kept: { value: 'kept' } } },
    })
    expect(secretRuns).toHaveBeenCalledTimes(1)

    // Registry membership alone does not authorize a wire call.
    const execute = vi.spyOn(runtime.ctx.tools, 'execute')
    for (const name of ['secret_tool', 'sibling_secret']) {
      expect(structuredResult(await client.callTool({ name, arguments: {} }))).toMatchObject({
        isError: true,
        error: { info: { code: 'UNKNOWN_TOOL' } },
      })
    }
    expect(execute).not.toHaveBeenCalled()
    codeRuntime.behavior = async request => ({
      logs: [],
      value: {
        names: Object.keys(request.bindings[0]!.functions),
        kept: await request.bindings[0]!.functions.echo!({ value: 'restricted' }),
      },
    })
    expect(structuredResult(await callCode(client))).toMatchObject({
      isError: false,
      value: { result: { names: ['echo'], kept: { value: 'restricted' } } },
    })
    const restricted = await client.listTools()
    expect(restricted.tools.map(entry => entry.name)).toEqual(mode === 'code' ? [RUN_CODE_NAME] : ['echo', RUN_CODE_NAME])
    const description = restricted.tools.find(entry => entry.name === RUN_CODE_NAME)?.description
    expect(description).toContain('echo:')
    expect(description).not.toContain('secret_tool')
    expect(description).not.toContain('sibling_secret')

    undo()
    codeRuntime.behavior = async request => ({
      logs: [],
      value: await request.bindings[0]!.functions.secret_tool!({ value: 'restored' }),
    })
    expect(structuredResult(await callCode(client, 'return await tools.secret_tool({ value: "restored" })')))
      .toMatchObject({ isError: false, value: { result: { value: 'restored' } } })
    expect((await client.listTools()).tools).toEqual(initial.tools)
    expect(secretRuns).toHaveBeenCalledTimes(2)
    expect(siblingRuns).not.toHaveBeenCalled()
  })

  it.each(['typescript', 'python'])('carries the canonical typed %s SDK and error contract without recursive bindings', async (language) => {
    const runtime = await mount()
    const codeRuntime = provideCodeRuntime(runtime.ctx, language)
    const live = await runtime.agent(`sdk-${language}`)
    live.session.append('turn/start', { turn: 1 })
    live.scope.ctx.tools.presentAs('code')
    live.scope.ctx.tools.register(defineTool({
      name: 'echo',
      description: 'Return the value and its length.',
      parameters: { value: { type: 'string', required: true } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            value: { type: 'string', required: true },
            length: { type: 'number', required: true },
          },
        },
        render: () => [{ type: 'text', text: 'rendered echo, not the canonical JSON' }],
      },
      execute: args => Promise.resolve({ value: args.value, length: args.value.length }),
    }))
    live.scope.ctx.tools.register(tool('fails', async () => { throw new Error('echo rejected') }))
    codeRuntime.behavior = async (request) => {
      const binding = request.bindings[0]!
      expect(binding.global).toBe('tools')
      expect(binding.errorClass).toEqual({ name: 'ToolCallError', memberNameProperty: 'toolName' })
      expect(binding.functions[RUN_CODE_NAME]).toBeUndefined()
      expect(Object.hasOwn(binding.functions, RUN_CODE_NAME)).toBe(false)
      const value = await binding.functions.echo!({ value: 'typed' })
      const failure = await binding.functions.fails!({}).then(
        () => 'unexpected success',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      )
      return { logs: [], value: { value, failure } }
    }
    const client = await runtime.client(runtime.ctx.mcpToolRuntime.issue(live.agent))
    const program = language === 'python'
      ? 'return await tools.echo({"value": "typed"})'
      : 'return await tools.echo({ value: "typed" })'
    expect(structuredResult(await callCode(client, program))).toMatchObject({
      isError: false,
      value: { logs: [], result: { value: { value: 'typed', length: 5 }, failure: 'echo rejected' } },
    })
    expect(codeRuntime.run.mock.calls[0]?.[0].program).toBe(program)

    const listed = await client.listTools()
    expect(listed.tools.map(entry => entry.name)).toEqual([RUN_CODE_NAME])
    const schema = runtime.ctx.tools.wireSchemas(live.agent).schemas[0]!
    const sdk = runtime.ctx.tools.codeSdk(live.agent)
    const assembly = await runtime.ctx.systemPrompt.assemble({ scope: live.agent })
    expect(sdk).toBe(assembly.sections.find(section => section.name === 'tools:sdk')?.text)
    expect(listed.tools[0]).toEqual({
      name: RUN_CODE_NAME,
      description: `${schema.description}\n\n${sdk}`,
      inputSchema: schema.parameters,
    })
    expect(listed.tools[0]?.inputSchema.required).toEqual(['code', 'description'])
    expect(sdk).toContain('typed canonical JSON value')
    if (language === 'typescript') {
      expect(sdk).toContain('echo: {\n    value: string;\n  } & Record<string, JsonValue>;')
      expect(sdk).toContain('echo: {\n    value: string;\n    length: number;\n  };')
      expect(sdk).toContain('[K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;')
      expect(sdk).toContain('declare class ToolCallError extends Error {\n  readonly name: "ToolCallError";\n  readonly toolName: ToolName;\n}')
      expect(sdk).not.toContain('run_code:')
    } else {
      expect(sdk).toContain('class EchoArgs(TypedDict):\n    value: str')
      expect(sdk).toContain('class EchoOutput(TypedDict):\n    value: str\n    length: float')
      expect(sdk).toContain('async def echo(self, args: EchoArgs) -> EchoOutput:')
      expect(sdk).toContain('class ToolCallError(Exception):\n    toolName: str')
      expect(sdk).not.toContain('async def run_code(')
    }
    expect((await client.listTools()).tools).toEqual(listed.tools)

    codeRuntime.behavior = () => Promise.resolve({
      logs: [],
      error: { kind: 'exception', message: 'program rejected' },
    })
    const failed = await callCode(client, 'raise_or_throw')
    expect(failed.isError).toBe(true)
    expect(structuredResult(failed)).toMatchObject({
      isError: true,
      error: {
        message: 'code run failed (exception): program rejected',
        info: { name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED' },
      },
    })
  })

  it.each([undefined, 'private-unsupported-runtime'])('sanitizes list and call failures for runtime %s without native fallback', async (language) => {
    const runtime = await mount()
    const codeRuntime = language === undefined ? undefined : provideCodeRuntime(runtime.ctx, language)
    const live = await runtime.agent('misconfigured-code-agent')
    const native = await runtime.agent('native-without-code-runtime')
    live.scope.ctx.tools.presentAs('both')
    const body = vi.fn(async (args: unknown) => args)
    runtime.ctx.tools.register(tool('echo', body))
    const capability = runtime.ctx.mcpToolRuntime.issue(live.agent)
    const client = await runtime.client(capability)
    const execute = vi.spyOn(runtime.ctx.tools, 'execute')

    for (const name of [RUN_CODE_NAME, 'echo']) {
      const result = await client.callTool({ name, arguments: { code: 'return 1', description: 'Probe runtime' } })
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([{ type: 'text', text: 'Error: tool bridge request failed' }])
      expect(structuredResult(result)).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'Error: tool bridge request failed' }],
        error: {
          message: 'tool bridge request failed',
          info: { name: 'ToolBridgeError', code: 'BRIDGE_FAILURE' },
        },
      })
      expect(JSON.stringify(result)).not.toContain(capability.token)
      expect(JSON.stringify(result)).not.toContain('private-unsupported-runtime')
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(client.listTools()).rejects.toMatchObject({
        message: 'MCP error -32603: tool bridge listing failed',
      })
    }
    expect(execute).not.toHaveBeenCalled()
    expect(body).not.toHaveBeenCalled()
    if (codeRuntime !== undefined) expect(codeRuntime.run).not.toHaveBeenCalled()

    const nativeClient = await runtime.client(runtime.ctx.mcpToolRuntime.issue(native.agent))
    expect(structuredResult(await nativeClient.callTool({ name: 'echo', arguments: { value: 'native' } })))
      .toMatchObject({ isError: false, value: { value: 'native' } })
    expect((await nativeClient.listTools()).tools.map(entry => entry.name)).toEqual(['echo'])
    expect(runtime.ctx.tools.codeSdk(native.agent)).toBe('')
    expect(body).toHaveBeenCalledTimes(1)
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

  it('retains the bound agent, scoped guard and approval signal in code subcalls', async () => {
    const runtime = await mount()
    const codeRuntime = provideCodeRuntime(runtime.ctx)
    const live = await runtime.agent('nested-policy-agent')
    const native = await runtime.agent('nested-policy-native-sibling')
    live.session.append('turn/start', { turn: 1 })
    live.scope.ctx.tools.presentAs('code')
    const guardedBody = vi.fn(async () => 'ran')
    const approvedBody = vi.fn(async () => 'approved')
    runtime.ctx.tools.register(tool('guarded', guardedBody))
    runtime.ctx.tools.register(tool('approval', approvedBody))
    live.scope.ctx.tools.guard(exec => exec.name === 'guarded' ? 'nested scope denied' : undefined)
    let approvalRequest: ApprovalRequest | undefined
    let approvalSignal: AbortSignal | undefined
    runtime.ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (exec.name !== 'approval') return next()
      expect(exec.agent).toBe(live.agent)
      expect(runtime.ctx.agents.currentInitiator()).toBe(live.agent)
      approvalSignal = exec.signal
      return { kind: 'ask', reason: 'nested approval' }
    })
    runtime.ctx.on('approval/request', (request) => {
      approvalRequest = request
      return Promise.resolve('allowed-once')
    })
    codeRuntime.behavior = async (request) => {
      const functions = request.bindings[0]!.functions
      const guarded = await functions.guarded!({}).then(
        () => 'unexpected success',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      )
      return { logs: [], value: { guarded, approved: await functions.approval!({}) } }
    }
    const client = await runtime.client(runtime.ctx.mcpToolRuntime.issue(live.agent))

    expect(structuredResult(await callCode(client, 'await tools.guarded({}); return await tools.approval({})')))
      .toMatchObject({
        isError: false,
        value: { result: { guarded: 'nested scope denied', approved: 'approved' } },
      })
    expect(guardedBody).not.toHaveBeenCalled()
    expect(approvedBody).toHaveBeenCalledTimes(1)
    expect(approvalRequest).toMatchObject({ agent: live.agent, toolName: 'approval', reason: 'nested approval' })
    expect(approvalRequest?.signal).toBeInstanceOf(AbortSignal)
    expect(approvalRequest?.signal).toBe(approvalSignal)
    const nativeClient = await runtime.client(runtime.ctx.mcpToolRuntime.issue(native.agent))
    expect(structuredResult(await nativeClient.callTool({ name: 'guarded', arguments: {} })))
      .toMatchObject({ isError: false, value: 'ran' })
    expect(guardedBody).toHaveBeenCalledTimes(1)
  })

  it.each(['cancellation', 'revocation'] as const)('drains nested code dispatch after MCP %s', async (ending) => {
    const runtime = await mount()
    const codeRuntime = provideCodeRuntime(runtime.ctx)
    const live = await runtime.agent(`nested-${ending}`)
    live.session.append('turn/start', { turn: 1 })
    live.scope.ctx.tools.presentAs('code')
    let entered = false
    let bodySettled = false
    let nestedSignal: AbortSignal | undefined
    const results = new Map<string, ToolExecutionResult>()
    live.scope.ctx.tools.register(tool('slow', async (_args, exec) => {
      expect(exec.agent).toBe(live.agent)
      expect(runtime.ctx.agents.currentInitiator()).toBe(live.agent)
      nestedSignal = exec.signal
      entered = true
      await new Promise<void>((resolve) => {
        if (exec.signal.aborted) resolve()
        else exec.signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      bodySettled = true
      return 'late-success'
    }))
    runtime.ctx.on('tools/result', (exec, result) => {
      results.set(exec.name, result)
      return undefined
    })
    codeRuntime.behavior = async (request) => {
      try {
        return { logs: [], value: await request.bindings[0]!.functions.slow!({}) }
      } catch {
        // Real runtimes resolve aborts after their in-flight binding rejects.
        return { logs: [], error: { kind: 'abort', message: 'nested run aborted' } }
      }
    }
    const capability = runtime.ctx.mcpToolRuntime.issue(live.agent)
    const client = await runtime.client(capability)
    const controller = new AbortController()
    const pending = client.callTool(
      { name: RUN_CODE_NAME, arguments: { code: 'return await tools.slow({})', description: 'Await nested dispatch' } },
      undefined,
      { signal: controller.signal, timeout: 2_000 },
    ).then(result => ({ rejected: false, result }), (error: unknown) => ({ rejected: true, error }))

    try {
      await vi.waitFor(() => { expect(entered).toBe(true) }, { timeout: 2_000 })
      if (ending === 'cancellation') controller.abort(new Error('nested test cancellation'))
      else await capability.revoke()
      await vi.waitFor(() => {
        expect(bodySettled).toBe(true)
        expect(nestedSignal?.aborted).toBe(true)
        expect(results.get('slow')).toMatchObject({
          isError: true,
          error: { info: { code: TOOL_ABORTED } },
        })
        expect(results.get(RUN_CODE_NAME)).toMatchObject({
          isError: true,
          error: {
            message: 'code run failed (abort): nested run aborted',
            info: { code: 'CODE_RUN_FAILED' },
          },
        })
      }, { timeout: 2_000 })
      if (ending === 'revocation') {
        const retried = await rawInitialize(capability.endpoint, `Bearer ${capability.token}`)
        expect(retried.status).toBe(401)
        expect(retried.text).not.toContain(capability.token)
        // Revocation already drained the body; close the client's pending HTTP wait.
        controller.abort()
      }
      const outcome = await pending
      if (ending === 'cancellation') expect(outcome.rejected).toBe(true)
    } finally {
      controller.abort()
      await capability.revoke()
      await pending
    }
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
