import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ClientSideConnection, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createUserMessage,
  type GenerateOptions,
  type LlmAdapter,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/index.ts'

interface WireRequest {
  readonly id?: number
  readonly method?: string
  readonly params?: unknown
}

interface FakeAcpChild {
  readonly handle: SubprocessHandle
  readonly loads: unknown[]
  readonly prompts: unknown[]
}

interface AdapterFixture {
  readonly adapter: LlmAdapter
  readonly sessionId: ReturnType<typeof SessionId>
  readonly spawn: ReturnType<typeof vi.fn>
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

function fakeAcpChild(mode: 'success' | 'close-on-prompt', remoteSessionId = 'remote-putri'): FakeAcpChild {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const loads: unknown[] = []
  const prompts: unknown[] = []
  let input = ''

  const respond = (id: number, result: unknown): void => {
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }
  const receive = (message: WireRequest): void => {
    if (message.id === undefined || message.method === undefined) return
    switch (message.method) {
      case 'initialize':
        respond(message.id, {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { loadSession: true },
          authMethods: [],
        })
        break
      case 'session/new':
        respond(message.id, { sessionId: remoteSessionId })
        break
      case 'session/load':
        loads.push(message.params)
        respond(message.id, {})
        break
      case 'session/prompt':
        prompts.push(message.params)
        if (mode === 'close-on-prompt') {
          stdout.end()
        } else {
          respond(message.id, { stopReason: 'end_turn' })
        }
        break
      default:
        throw new Error(`unexpected ACP method ${message.method}`)
    }
  }

  stdin.on('data', (chunk: Buffer) => {
    input += chunk.toString('utf8')
    while (true) {
      const newline = input.indexOf('\n')
      if (newline === -1) return
      const line = input.slice(0, newline).trim()
      input = input.slice(newline + 1)
      if (line !== '') receive(JSON.parse(line) as WireRequest)
    }
  })

  return {
    handle: {
      pid: 1,
      stdin,
      stdout,
      stderr: undefined,
      collected: {},
      done: Promise.resolve({}) as SubprocessHandle['done'],
      terminate: vi.fn(),
      waitForExit: vi.fn(() => Promise.resolve(true)),
    },
    loads,
    prompts,
  }
}

function config(): Config {
  return {
    providerId: 'gianaos',
    providerName: 'GianaOS',
    modelId: 'putri',
    modelName: 'Putri',
    description: 'Canonical Putri test route',
    principalId: 'giana.putri',
    routeRevision: 'test-v1',
    launchCommand: process.execPath,
    launchArguments: [],
    launchScript: fileURLToPath(import.meta.url),
    localWorkspace: process.cwd(),
    remoteWorkspace: '/var/lib/gianaos',
    remoteToolRuntimeUrl: 'http://127.0.0.1:18643/mcp/tool-runtime',
    permission: 'allow',
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  }
}

function adapterFixture(
  children: readonly FakeAcpChild[],
  revokes: readonly (() => Promise<void>)[] = [],
): AdapterFixture {
  const sessionId = SessionId('local-putri')
  const localSession = Session.create(sessionId)
  const agent = { id: sessionId, session: localSession } as Agent
  let adapter: LlmAdapter | undefined
  let childIndex = 0
  let capabilityIndex = 0
  const spawn = vi.fn(() => {
    const child = children[childIndex]
    childIndex += 1
    if (child === undefined) throw new Error('unexpected Putri subprocess launch')
    return child.handle
  })
  const context = {
    agents: { get: (id: unknown) => id === sessionId ? agent : undefined },
    sessions: { get: (id: unknown) => id === sessionId ? localSession : undefined },
    subprocess: { spawn },
    mcpToolRuntime: {
      issue: () => {
        const index = capabilityIndex
        capabilityIndex += 1
        return {
          endpoint: 'http://127.0.0.1:18643/mcp/tool-runtime',
          token: `token-${index}`,
          revoke: revokes[index] ?? (() => Promise.resolve()),
        }
      },
    },
    get: () => undefined,
    llm: {
      registerAdapter: (providers: string[], candidate: LlmAdapter) => {
        expect(providers).toEqual(['gianaos'])
        adapter = candidate
        return () => {}
      },
    },
    effect: (install: () => unknown) => {
      install()
      return Promise.resolve()
    },
  } as unknown as Context

  apply(context, config())
  if (adapter === undefined) throw new Error('Putri adapter was not registered')
  return { adapter, sessionId, spawn }
}

function request(sessionId: ReturnType<typeof SessionId>, overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'gianaos',
    model: 'putri',
    sessionId,
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    })],
    ...overrides,
  }
}

async function drain(adapter: LlmAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Putri ACP route binding', () => {
  it.each([
    { provider: 'gg1', model: 'putri', code: 'WRONG_GIANAOS_ADAPTER' },
    { provider: 'gianaos', model: 'gg1', code: 'UNKNOWN_GIANAOS_PARTICIPANT' },
  ])('rejects $provider/$model before opening a session', async ({ provider, model, code }) => {
    const fixture = adapterFixture([])

    await expect(fixture.adapter.resolveModel(provider, model)).rejects.toMatchObject({ code })
    await expect(drain(fixture.adapter, request(fixture.sessionId, { provider, model })))
      .rejects.toMatchObject({ code })
    expect(fixture.spawn).not.toHaveBeenCalled()
  })
})

describe('Putri ACP session recovery', () => {
  it('retires a cached session when prompt dispatch throws synchronously', async () => {
    const first = fakeAcpChild('success')
    const second = fakeAcpChild('success')
    const fixture = adapterFixture([first, second])
    vi.spyOn(ClientSideConnection.prototype, 'prompt')
      .mockImplementationOnce(() => { throw new Error('synchronous prompt failure') })

    await expect(drain(fixture.adapter, request(fixture.sessionId))).rejects.toMatchObject({
      code: 'GIANAOS_ACP_ERROR',
      message: 'Putri ACP failed: synchronous prompt failure',
    })
    const chunks = await drain(fixture.adapter, request(fixture.sessionId))

    expect(fixture.spawn).toHaveBeenCalledTimes(2)
    expect(second.loads).toEqual([expect.objectContaining({ sessionId: 'remote-putri' })])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('replaces a transport-closed session while its disposal is still settling', async () => {
    const first = fakeAcpChild('close-on-prompt')
    const second = fakeAcpChild('success')
    const revokeStarted = deferred()
    const finishRevoke = deferred()
    const firstRevoke = vi.fn(() => {
      revokeStarted.resolve()
      return finishRevoke.promise
    })
    const fixture = adapterFixture([first, second], [firstRevoke])

    const failed = drain(fixture.adapter, request(fixture.sessionId))
    await revokeStarted.promise
    const recovered = drain(fixture.adapter, request(fixture.sessionId))
    await vi.waitFor(() => {
      expect(fixture.spawn).toHaveBeenCalledTimes(2)
    })

    await expect(recovered).resolves.toContainEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(second.loads).toEqual([expect.objectContaining({ sessionId: 'remote-putri' })])
    expect(first.prompts).toHaveLength(1)
    expect(second.prompts).toHaveLength(1)

    finishRevoke.resolve()
    await expect(failed).rejects.toMatchObject({
      code: 'GIANAOS_ACP_ERROR',
      message: 'Putri ACP failed: ACP connection closed',
    })
  })
})
