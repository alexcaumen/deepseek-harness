import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Api, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { buildBaseOptions } from '@earendil-works/pi-ai/api/simple-options'

const streamSimple = vi.hoisted(() => vi.fn())

// A hand-declared route is built by `createProvider` over the protocol table in
// `src/provider.ts`, so the table's lazy api module is the SDK boundary this
// test can observe. A catalog route dispatches through pi-ai's own provider and
// would not see this mock.
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({ stream: streamSimple, streamSimple }),
}))

import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

afterEach(() => { streamSimple.mockReset() })

/** A hand-declared OpenAI-compatible route with one fully described model. */
function gatewayAdapter(contextWindow = 8192, maxTokens = 1024): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles({
      'local-gateway': {
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9/v1',
        models: [{ id: 'local-model', contextWindow, maxTokens }],
      },
    }),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
  })
}

type StreamRequest = Parameters<PiAiAdapter['stream']>[0]

async function drain(adapter: PiAiAdapter, overrides: Partial<StreamRequest> = {}): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'local-gateway',
    model: 'local-model',
    messages: [],
    ...overrides,
  })) chunks.push(chunk)
  return chunks
}

function largeUserMessage(length: number): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text: 'x'.repeat(length) }],
    source: { kind: 'plugin', plugin: 'test' },
  })
}

describe('pi-ai SDK retry boundary', () => {
  it('pins one SDK attempt even when the installed provider currently defaults to zero retries', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    const chunks = await drain(gatewayAdapter())

    expect(streamSimple).toHaveBeenCalledOnce()
    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ maxRetries: 0, apiKey: 'test-key' })
    // pi-ai reports a setup failure as a terminal in-stream error rather than
    // throwing, which the converter turns into the harness error finish.
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'mock SDK boundary' } },
    })
  })

  it('dispatches a hand-declared route to the endpoint and model its configuration describes', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    await drain(gatewayAdapter())

    expect(streamSimple.mock.calls[0]?.[0]).toMatchObject({
      id: 'local-model',
      provider: 'local-gateway',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      contextWindow: 8192,
      maxTokens: 1024,
    })
  })

  it('clamps an explicit output cap to the remaining model context before dispatch', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })
    const adapter = gatewayAdapter(8192, 4096)

    // 4,000 estimated input tokens leave less than the requested output cap
    // even with the small-window reserve, unlike the old 2,000-token prompt.
    await drain(adapter, { messages: [largeUserMessage(16000)], maxTokens: 4096 })

    const requestOptions = streamSimple.mock.calls[0]?.[2] as { maxTokens?: number }
    expect(requestOptions.maxTokens).toBe(3168)
  })

  it('keeps a requested cap when the context has ample headroom', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })
    const adapter = gatewayAdapter()

    await drain(adapter, { maxTokens: 512 })

    expect((streamSimple.mock.calls[0]?.[2] as { maxTokens?: number }).maxTokens).toBe(512)
  })
})

describe.each([
  { contextWindow: 4096, reserve: 512 },
  { contextWindow: 8192, reserve: 1024 },
  { contextWindow: 32768, reserve: 4096 },
  { contextWindow: 65536, reserve: 4096 },
  { contextWindow: 262144, reserve: 4096 },
])('pi-ai option dispatch with $contextWindow context tokens', ({ contextWindow, reserve }) => {
  it.each([
    { label: 'ample headroom', remaining: 2048, expected: 1024 },
    { label: 'crowded prompt', remaining: 128, expected: 128 },
    { label: 'exact saturation', remaining: 0, expected: 1 },
    { label: 'overflow', remaining: -512, expected: 1 },
  ])('preserves truthful capacity and clamps $label', async ({ remaining, expected }) => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })
    const adapter = gatewayAdapter(contextWindow, 1024)
    const inputTokens = contextWindow - reserve - remaining

    await drain(adapter, { messages: [largeUserMessage(inputTokens * 4)], maxTokens: 1024 })

    expect(streamSimple).toHaveBeenCalledOnce()
    const [model, context, options] = streamSimple.mock.calls[0] as [Model<Api>, Context, SimpleStreamOptions]
    expect(model).toMatchObject({ contextWindow, maxTokens: 1024 })
    expect(context.messages).toEqual([{ role: 'user', content: 'x'.repeat(inputTokens * 4), timestamp: 0 }])
    expect(options.maxTokens).toBe(expected)
    // The real provider applies buildBaseOptions after adapter dispatch.
    expect(buildBaseOptions(model, context, options).maxTokens).toBe(expected)
    expect(await adapter.resolveModel('local-gateway', 'local-model')).toMatchObject({
      context: { contextWindow },
      defaultMaxTokens: 1024,
    })
  })

  it.each([undefined, 256])('preserves the model default or explicit cap %s', async (maxTokens) => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })
    await drain(gatewayAdapter(contextWindow, 1024), {
      messages: [largeUserMessage(1024)],
      ...maxTokens === undefined ? {} : { maxTokens },
    })

    const [model, context, options] = streamSimple.mock.calls[0] as [Model<Api>, Context, SimpleStreamOptions]
    expect(model).toMatchObject({ contextWindow, maxTokens: 1024 })
    expect(options.maxTokens).toBe(maxTokens ?? 1024)
    expect(buildBaseOptions(model, context, options).maxTokens).toBe(maxTokens ?? 1024)
  })
})
