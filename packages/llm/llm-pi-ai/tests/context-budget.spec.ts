import { describe, expect, it } from 'vitest'
import type { Context, Model } from '@earendil-works/pi-ai'
import { buildBaseOptions, clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options'

function sdkModel(contextWindow: number, maxTokens = contextWindow): Model<'openai-completions'> {
  return {
    id: 'local-model',
    name: 'Local model',
    provider: 'local-gateway',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:9/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  }
}

function textContext(tokens: number): Context {
  return { messages: [{ role: 'user', content: 'x'.repeat(tokens * 4), timestamp: 0 }] }
}

describe.each([
  { contextWindow: 256, reserve: 64 },
  { contextWindow: 511, reserve: 64 },
  { contextWindow: 512, reserve: 64 },
  { contextWindow: 519, reserve: 64 },
  { contextWindow: 4096, reserve: 512 },
  { contextWindow: 8192, reserve: 1024 },
  { contextWindow: 32767, reserve: 4095 },
  { contextWindow: 32768, reserve: 4096 },
  { contextWindow: 65536, reserve: 4096 },
  { contextWindow: 262144, reserve: 4096 },
])('installed pi-ai SDK budget with $contextWindow context tokens', ({ contextWindow, reserve }) => {
  it('reserves bounded estimation headroom without changing model capacity', () => {
    const model = Object.freeze(sdkModel(contextWindow))
    const context: Context = { messages: [] }
    const expected = contextWindow - reserve

    expect(clampMaxTokensToContext(model, context, model.maxTokens)).toBe(expected)
    expect(buildBaseOptions(model, context).maxTokens).toBe(expected)
    expect(buildBaseOptions(model, context, { maxTokens: model.maxTokens }).maxTokens).toBe(expected)
    expect(model).toMatchObject({ contextWindow, maxTokens: contextWindow })
  })

  it('counts the system prompt and user content before clamping', () => {
    const model = sdkModel(contextWindow)
    const context = { ...textContext(32), systemPrompt: 's'.repeat(128) }
    const expected = contextWindow - reserve - 64
    expect(clampMaxTokensToContext(model, context, model.maxTokens)).toBe(expected)
    expect(buildBaseOptions(model, context).maxTokens).toBe(expected)
  })

  it.each([
    { remaining: 2, expected: 2 },
    { remaining: 1, expected: 1 },
    { remaining: 0, expected: 1 },
    { remaining: -1, expected: 1 },
    { remaining: -512, expected: 1 },
  ])('keeps the one-token floor with $remaining tokens remaining', ({ remaining, expected }) => {
    const model = sdkModel(contextWindow)
    const context = textContext(contextWindow - reserve - remaining)

    expect(clampMaxTokensToContext(model, context, model.maxTokens)).toBe(expected)
    expect(buildBaseOptions(model, context).maxTokens).toBe(expected)
    expect(buildBaseOptions(model, context, { maxTokens: 128 }).maxTokens).toBe(expected)
  })

  it('preserves the model output default and lower caller ceiling', () => {
    const model = sdkModel(contextWindow, 128)
    const context: Context = { messages: [] }

    expect(clampMaxTokensToContext(model, context, model.maxTokens)).toBe(128)
    expect(buildBaseOptions(model, context).maxTokens).toBe(128)
    expect(clampMaxTokensToContext(model, context, 32)).toBe(32)
    expect(buildBaseOptions(model, context, { maxTokens: 32 }).maxTokens).toBe(32)
  })
})

describe('unchanged SDK output policies', () => {
  it('keeps large model defaults above 32768 and explicit caller ceilings', () => {
    const model = sdkModel(262144, 65536)
    const context = textContext(1024)

    expect(buildBaseOptions(model, context).maxTokens).toBe(65536)
    expect(clampMaxTokensToContext(model, context, 49152)).toBe(49152)
    expect(buildBaseOptions(model, context, { maxTokens: 49152 }).maxTokens).toBe(49152)
  })

  it.each([0, -1])('preserves unknown-window handling for %s', (contextWindow) => {
    const model = sdkModel(contextWindow, 1024)
    const context = textContext(8192)

    expect(clampMaxTokensToContext(model, context, 512)).toBe(512)
    expect(clampMaxTokensToContext(model, context, 0)).toBe(1)
    expect(buildBaseOptions(model, context).maxTokens).toBe(1024)
    expect(buildBaseOptions(model, context, { maxTokens: 512 }).maxTokens).toBe(512)
  })
})
