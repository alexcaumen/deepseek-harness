import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import * as Ownership from '../src/ownership.ts'

const local = { provider: 'glm-local-r5300', model: 'GLM-5.3-Flash-official-fp8-canary' }
const nonlocal = { provider: 'deepseek-official', model: 'private-preview' }
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  const calls: GenerateOptions[] = []
  const adapter = new class extends LlmAdapter {
    override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options)
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }()
  ctx.llm.registerAdapter([local.provider, nonlocal.provider], adapter)
  return { ctx, calls, resolve: vi.spyOn(adapter, 'resolveModel') }
}

async function chunks(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []
  for await (const chunk of stream) result.push(chunk)
  return result
}

describe('RC53 ownership-only plugin', () => {
  it('reserves exact local pairs without changing nonlocal or unreserved routing', async () => {
    const { ctx, calls, resolve } = await setup()
    const owner = await ctx.plugin(Ownership, { pairs: [local] })
    const crossed = { provider: nonlocal.provider, model: local.model }

    await expect(ctx.llm.prepareCall(crossed)).rejects.toMatchObject({ code: 'MODEL_PROVIDER_MISMATCH' })
    expect(await chunks(ctx.llm.stream({ ...crossed, messages: [] }))).toMatchObject([
      { type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_PROVIDER_MISMATCH' } } },
    ])
    expect(resolve).not.toHaveBeenCalled()
    expect(calls).toEqual([])

    for (const selection of [local, nonlocal, { provider: nonlocal.provider, model: 'unreserved' }]) {
      const call = await ctx.llm.prepareCall(selection)
      await chunks(call.stream({ ...call.config, messages: [] }))
    }
    expect(calls.map(({ provider, model }) => ({ provider, model }))).toEqual([
      local, nonlocal, { provider: nonlocal.provider, model: 'unreserved' },
    ])

    await owner.dispose()
    expect(() => ctx.llm.assertModelOwnership(crossed.provider, crossed.model))
      .toThrow(expect.objectContaining({ code: 'MODEL_PROVIDER_MISMATCH' }))
    const fresh = await setup()
    expect(() => fresh.ctx.llm.assertModelOwnership(crossed.provider, crossed.model)).not.toThrow()
  })

  it('rejects duplicate, malformed and oversized declarations before registering any pair', async () => {
    const { ctx } = await setup()
    const invalid: unknown[] = [
      { pairs: [local, local] },
      { pairs: [{ ...local, provider: ' glm-local-r5300' }] },
      { pairs: [{ ...local, model: 'bad\u0000model' }] },
      { pairs: [{ ...local, model: '' }] },
      { pairs: [{ ...local, provider: 123 }] },
      { pairs: [{ model: local.model }] },
      { pairs: [{ ...local, extra: true }] },
      { pairs: [local], extra: true },
      { pairs: [] },
      { pairs: Array.from({ length: 17 }, (_, index) => ({ ...local, model: `model-${index}` })) },
    ]
    for (const config of invalid) {
      expect(() => Ownership.apply(ctx, config as Ownership.Config)).toThrow()
    }
    expect(() => ctx.llm.assertModelOwnership(nonlocal.provider, local.model)).not.toThrow()
  })
})
