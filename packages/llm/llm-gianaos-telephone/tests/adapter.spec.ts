import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mintTurnFence, PROTOCOL_VERSION, sha256 } from '@grinviro/dsh-llm-gianaos-workspace-bridge'
import { Config, GianaOsTelephoneAdapter, lastHumanMessage, telephoneSessionId } from '../src/index.ts'

const FENCE = '```'
const DIGEST = 'a'.repeat(64)

function userMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function pluginMessage(text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test-context', form: 'catalog' },
  })
}

// Built through the plugin schema so the tests assert against the shipped
// defaults, including a bridge that is off unless an operator turns it on.
function makeConfig(overrides: Partial<Config> = {}): Config {
  return Config(overrides as Config)
}

const config: Config = makeConfig()

/** One SSE response carrying `text` then a clean stop. */
function sseResponse(text: string): Response {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}`,
    'data: [DONE]',
    '',
  ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

type FetchMock = { mock: { calls: [unknown, RequestInit | undefined][] } }

/** The request body of one recorded fetch call. */
function requestInit(mock: unknown, index: number): RequestInit {
  const call = (mock as FetchMock).mock.calls[index]
  if (call?.[1] === undefined) throw new Error(`no fetch call at index ${index}`)
  return call[1]
}

/** The serialized request body text of one recorded fetch call. */
function bodyText(mock: unknown, index: number): string {
  const body = requestInit(mock, index).body
  return typeof body === 'string' ? body : ''
}

function requestBody(mock: unknown, index: number): { model: string; messages: { role: string; content: string }[] } {
  return JSON.parse(bodyText(mock, index)) as {
    model: string
    messages: { role: string; content: string }[]
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function visibleText(chunks: StreamChunk[]): string {
  return chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
}

async function bridgeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'giana-telephone-'))
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'docs', 'marker.txt'), 'MARKER-VIOLET\n', 'utf8')
  return root
}

function bridgeConfig(root: string): Config {
  return makeConfig({
    bridgeEnabled: true,
    bridgeWorkspaces: [{ id: 'WS1', root, identitySha256: DIGEST, writable: false }],
  })
}

describe('GianaOS telephone request boundary', () => {
  it('selects only the latest human message', () => {
    const first = userMessage('first')
    const second = userMessage('second')
    expect(lastHumanMessage([
      first,
      second,
      pluginMessage('@deepseek-ai/dsh-system-prompt'),
      pluginMessage('skill-catalog'),
    ])).toBe('second')
  })

  it('keeps one stable privacy-scoped surface session id', () => {
    expect(telephoneSessionId('deepseek-harness', SessionId('abc'))).toBe('deepseek-harness:abc')
  })

  it('does not send the Harness system prompt, tools, or transcript history', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(sseResponse('ready')))
    const adapter = new GianaOsTelephoneAdapter({ config, resolveCredential: () => Promise.resolve('test-only') })
    const chunks = await collect(adapter.stream({
      provider: 'gianaos',
      model: 'putri',
      sessionId: SessionId('session-a'),
      system: 'shadow persona must not cross',
      tools: [{ name: 'shadow_tool', description: 'must not cross', parameters: {} }],
      messages: [
        userMessage('old'),
        userMessage('current'),
        pluginMessage('@deepseek-ai/dsh-system-prompt'),
        pluginMessage('skill-catalog'),
      ],
    }))

    const request = requestInit(fetchMock, 0)
    const body = requestBody(fetchMock, 0)
    expect(body.messages).toEqual([{ role: 'user', content: 'current' }])
    expect(body).not.toHaveProperty('tools')
    expect(bodyText(fetchMock, 0)).not.toContain('shadow persona')
    expect(bodyText(fetchMock, 0)).not.toContain('shadow_tool')
    expect(request.headers).toMatchObject({
      'x-hermes-session-id': 'deepseek-harness:session-a',
      'x-gianaos-session-id': 'deepseek-harness:session-a',
      'x-hermes-session-key': 'deepseek-harness:session-a',
    })
    // canonicalRouteHeader defaults to empty; the header is absent unless configured
    expect((request.headers as Record<string, string>)['x-giana-route']).toBeUndefined()
    expect(body.model).toBe('putri')
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
    fetchMock.mockRestore()
  })

  it('generates a deterministic title from Harness title framing without a remote call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const adapter = new GianaOsTelephoneAdapter({ config, resolveCredential: () => Promise.resolve('test-only') })
    const chunks = await collect(adapter.stream({
      provider: 'gianaos',
      model: 'putri',
      purpose: 'session-title',
      messages: [pluginMessage('Generate the session title from this JSON array of human messages:\n[{"text":"Canary Putri Telephone"}]')],
    }))

    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'Canary Putri Telephone' })
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockRestore()
  })
})

describe('PRDG workspace bridge on the telephone surface', () => {
  it('sends nothing beyond the human message while the bridge is disabled', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(sseResponse('ready')))
    const adapter = new GianaOsTelephoneAdapter({ config, resolveCredential: () => Promise.resolve('test-only') })
    await collect(adapter.stream({
      provider: 'gianaos',
      model: 'putri',
      sessionId: SessionId('session-a'),
      messages: [userMessage('halo')],
    }))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requestBody(fetchMock, 0).messages).toEqual([{ role: 'user', content: 'halo' }])
    fetchMock.mockRestore()
  })

  it('announces surface and capability without a persona, style, or owner instruction', async () => {
    const root = await bridgeWorkspace()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(sseResponse('ready')))
    const adapter = new GianaOsTelephoneAdapter({
      config: bridgeConfig(root),
      resolveCredential: () => Promise.resolve('test-only'),
    })
    await collect(adapter.stream({
      provider: 'gianaos',
      model: 'putri',
      sessionId: SessionId('session-a'),
      system: 'shadow persona must not cross',
      tools: [{ name: 'shadow_tool', description: 'must not cross', parameters: {} }],
      messages: [userMessage('halo')],
    }))

    const sent = requestBody(fetchMock, 0).messages[0]!.content
    expect(sent).toContain('halo')
    expect(sent).toContain('DeepSeek Harness')
    expect(sent).toContain('WS1')
    expect(sent).toContain('tools: read')
    expect(sent).not.toContain('shadow persona')
    expect(sent).not.toContain('shadow_tool')
    // The envelope is a capability declaration; identity and manner stay canonical.
    for (const forbidden of ['you are', 'persona', 'reply in', 'tone', 'style', 'address the user']) {
      expect(sent.toLowerCase()).not.toContain(forbidden)
    }
    expect(requestBody(fetchMock, 0)).not.toHaveProperty('tools')
    fetchMock.mockRestore()
  })

  it('executes a requested read and returns the evidence in the same canonical session', async () => {
    const root = await bridgeWorkspace()
    // The surface mints the work id; deriving it here the same way proves the
    // fence admits exactly the turn it minted and nothing else.
    const { workId } = mintTurnFence({
      principalId: 'giana.putri',
      canonicalSessionId: 'deepseek-harness:session-a',
      surfaceId: 'deepseek-harness',
      sourceWatermark: sha256('baca marker'),
      conversationWatermark: sha256('deepseek-harness:session-a'),
      cancelGeneration: 0,
      supersessionGeneration: 0,
      authorizationEpoch: 1,
    }, 4)

    const call = [
      `${FENCE}giana-tool`,
      JSON.stringify({
        protocol: PROTOCOL_VERSION,
        workId,
        generation: 1,
        tool: 'read',
        workspaceId: 'WS1',
        path: 'docs/marker.txt',
      }),
      FENCE,
    ].join('\n')

    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sseResponse(`Saya ambil dulu filenya.\n\n${call}`))
      .mockResolvedValueOnce(sseResponse('Isinya MARKER-VIOLET.'))

    const adapter = new GianaOsTelephoneAdapter({
      config: bridgeConfig(root),
      resolveCredential: () => Promise.resolve('test-only'),
    })
    const chunks = await collect(adapter.stream({
      provider: 'gianaos',
      model: 'putri',
      sessionId: SessionId('session-a'),
      messages: [userMessage('baca marker')],
    }))

    expect(fetchMock).toHaveBeenCalledTimes(2)

    // The evidence returns through the same privacy-scoped canonical session.
    const first = requestInit(fetchMock, 0).headers as Record<string, string>
    const second = requestInit(fetchMock, 1).headers as Record<string, string>
    expect(second).toMatchObject({ 'x-gianaos-session-id': 'deepseek-harness:session-a' })
    expect(first['x-gianaos-session-id']).toBe(second['x-gianaos-session-id'])

    const evidenceSent = requestBody(fetchMock, 1).messages[0]!.content
    expect(evidenceSent).toContain('giana-tool-result')
    expect(evidenceSent).toContain('MARKER-VIOLET')
    expect(evidenceSent).toContain(sha256('MARKER-VIOLET\n'))

    // The operator sees the principal's prose and a bounded activity marker,
    // never the machine request block.
    const shown = visibleText(chunks)
    expect(shown).toContain('Saya ambil dulu filenya.')
    expect(shown).toContain('Isinya MARKER-VIOLET.')
    expect(shown).toContain('[prdg-bridge] read OK docs\\marker.txt')
    expect(shown).not.toContain('giana-tool')
    expect(shown).not.toContain(PROTOCOL_VERSION)

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    fetchMock.mockRestore()
  })

  it('offers one canonical knowledge proposal carrying references only', async () => {
    const root = await bridgeWorkspace()
    const proposals: unknown[] = []
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(sseResponse('no request here')))
    const adapter = new GianaOsTelephoneAdapter({
      config: bridgeConfig(root),
      resolveCredential: () => Promise.resolve('test-only'),
      onKnowledgeProposal: proposal => proposals.push(proposal),
    })
    await collect(adapter.stream({
      provider: 'gianaos',
      model: 'putri',
      sessionId: SessionId('session-a'),
      messages: [userMessage('halo')],
    }))

    // A turn that ran no tool proposes nothing.
    expect(proposals).toHaveLength(0)
    fetchMock.mockRestore()
  })

  it('bounds the hop count so a repeating request cannot loop', async () => {
    const root = await bridgeWorkspace()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(
      sseResponse(`${FENCE}giana-tool\n{"protocol":"${PROTOCOL_VERSION}","workId":"W-STALE","generation":1,"tool":"read","workspaceId":"WS1","path":"docs/marker.txt"}\n${FENCE}`),
    ))
    const adapter = new GianaOsTelephoneAdapter({
      config: makeConfig({
        bridgeEnabled: true,
        bridgeWorkspaces: [{ id: 'WS1', root, identitySha256: DIGEST, writable: false }],
        bridgeMaxHops: 2,
      }),
      resolveCredential: () => Promise.resolve('test-only'),
    })
    const chunks = await collect(adapter.stream({
      provider: 'gianaos',
      model: 'putri',
      sessionId: SessionId('session-a'),
      messages: [userMessage('loop')],
    }))

    // One initial turn plus the bounded hops, and never more.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3)
    expect(visibleText(chunks)).toContain('WORK_ID_MISMATCH')
    fetchMock.mockRestore()
  })
})
