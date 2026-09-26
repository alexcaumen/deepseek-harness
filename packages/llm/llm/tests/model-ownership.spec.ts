import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '../src/index.ts'

const local = { provider: 'glm-local-r5300', model: 'glm-5.3-flash' }
const crossed = { ...local, provider: 'deepseek-official' }
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
  ctx.llm.registerAdapter(['deepseek-official', local.provider, 'replica'], adapter)
  const resolve = vi.spyOn(adapter, 'resolveModel')
  return { ctx, calls, adapter, resolve }
}

async function chunks(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []
  for await (const chunk of stream) result.push(chunk)
  return result
}

const mismatch = { code: 'MODEL_PROVIDER_MISMATCH' }
const denied = [{ type: 'finish', reason: { kind: 'error', failure: mismatch } }]

describe('exact deployment model ownership', () => {
  it('rejects crossed tuples before metadata or transport, preserving valid and unreserved models', async () => {
    const { ctx, calls, resolve } = await setup()
    ctx.llm.registerModelOwnership([local])
    await expect(ctx.llm.resolveModelInfo(crossed.provider, crossed.model)).rejects.toMatchObject(mismatch)
    await expect(ctx.llm.resolveCallConfig(crossed)).rejects.toMatchObject(mismatch)
    await expect(ctx.llm.prepareCall(crossed)).rejects.toMatchObject(mismatch)
    expect(await chunks(ctx.llm.stream({ ...crossed, messages: [] }))).toMatchObject(denied)
    expect(resolve).not.toHaveBeenCalled()
    expect(calls).toEqual([])

    for (const selection of [local, { provider: 'deepseek-official', model: 'private-preview' },
      { provider: 'deepseek-official', model: 'glm-unreserved-preview' }]) {
      const call = await ctx.llm.prepareCall(selection)
      await chunks(call.stream({ ...call.config, messages: [] }))
    }
    expect(calls.map(({ provider, model }) => ({ provider, model }))).toEqual([
      local, { provider: 'deepseek-official', model: 'private-preview' },
      { provider: 'deepseek-official', model: 'glm-unreserved-preview' },
    ])
  })

  it('captures declarations, supports explicit replicas, and remains fail-closed across plugin suspension', async () => {
    const { ctx, calls } = await setup()
    const selections = [{ ...local }, { ...local, provider: 'replica' }]
    const owner = await ctx.plugin({
      name: 'test-model-owner', inject: ['llm'],
      apply(scope: Context) { scope.llm.registerModelOwnership(selections) },
    })
    selections[0]!.provider = crossed.provider
    selections.length = 0
    expect(() => { ctx.llm.assertModelOwnership(crossed.provider, crossed.model) }).toThrow(expect.objectContaining(mismatch))
    expect(() => { ctx.llm.assertModelOwnership('replica', local.model) }).not.toThrow()
    await owner.dispose()
    expect(() => { ctx.llm.assertModelOwnership(crossed.provider, crossed.model) }).toThrow(expect.objectContaining(mismatch))
    expect(() => { ctx.llm.assertModelOwnership('replica', local.model) }).not.toThrow()
    expect(await chunks(ctx.llm.stream({ ...crossed, messages: [] }))).toMatchObject(denied)
    expect(calls).toEqual([])
    ctx.llm.registerModelOwnership([local])
    expect(() => { ctx.llm.assertModelOwnership('replica', local.model) }).toThrow(expect.objectContaining(mismatch))
  })

  it('notifies model-directory consumers when ownership changes', async () => {
    const { ctx } = await setup()
    const updated = vi.fn()
    ctx.on('llm/adapters-updated', updated)
    ctx.llm.registerModelOwnership([local])
    expect(updated).toHaveBeenCalledTimes(1)
    ctx.llm.registerModelOwnership([local])
    expect(updated).toHaveBeenCalledTimes(1)
    ctx.llm.registerModelOwnership([{ ...local, provider: 'replica' }])
    expect(updated).toHaveBeenCalledTimes(2)
    expect(() => { ctx.llm.assertModelOwnership(local.provider, local.model) }).toThrow(expect.objectContaining(mismatch))
  })

  it.each(['resolve', 'prepare', 'stream'] as const)('rechecks ownership after asynchronous %s metadata', async (kind) => {
    const { ctx, calls, resolve } = await setup()
    let release!: () => void
    const pending = new Promise<void>((done) => { release = done })
    resolve.mockImplementation(async (provider, model) => {
      await pending
      return { provider, id: model, name: model }
    })
    const operation = kind === 'resolve' ? ctx.llm.resolveCallConfig(crossed)
      : kind === 'prepare' ? ctx.llm.prepareCall(crossed)
        : chunks(ctx.llm.stream({ ...crossed, messages: [] }))
    await vi.waitFor(() => { expect(resolve).toHaveBeenCalledOnce() })
    ctx.llm.registerModelOwnership([local])
    release()
    if (kind === 'stream') expect(await operation).toMatchObject(denied)
    else await expect(operation).rejects.toMatchObject(mismatch)
    expect(calls).toEqual([])
  })

  it('rechecks a prepared call against ownership installed before dispatch', async () => {
    const { ctx, calls } = await setup()
    const call = await ctx.llm.prepareCall(crossed)
    ctx.llm.registerModelOwnership([local])
    expect(await chunks(call.stream({ ...call.config, messages: [] }))).toMatchObject(denied)
    expect(calls).toEqual([])
  })

  it.each(['resolve', 'prepare', 'stream'] as const)('rejects provider mutation across asynchronous %s resolution', async (kind) => {
    const { ctx, calls, resolve } = await setup()
    ctx.llm.registerModelOwnership([local, { ...local, provider: 'replica' }])
    let release!: () => void
    const pending = new Promise<void>((done) => { release = done })
    resolve.mockImplementation(async (provider, model) => {
      await pending
      return { provider, id: model, name: model }
    })
    const selection = { ...local, messages: [] }
    const operation = kind === 'resolve' ? ctx.llm.resolveCallConfig(selection)
      : kind === 'prepare' ? ctx.llm.prepareCall(selection)
        : chunks(ctx.llm.stream(selection))
    await vi.waitFor(() => { expect(resolve).toHaveBeenCalledOnce() })
    selection.provider = 'replica'
    release()
    if (kind === 'stream') expect(await operation).toMatchObject([
      { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_MODEL_INFO' } } },
    ])
    else await expect(operation).rejects.toMatchObject({ code: 'INVALID_MODEL_INFO' })
    expect(calls).toEqual([])
  })

  it('rejects empty identities before registering any partial ownership', async () => {
    const { ctx } = await setup()
    for (const invalid of [{ provider: '', model: local.model }, { provider: local.provider, model: '' }]) {
      expect(() => { ctx.llm.registerModelOwnership([local, invalid]) })
        .toThrow(expect.objectContaining({ code: 'INVALID_MODEL_OWNERSHIP' }))
      expect(() => { ctx.llm.assertModelOwnership(crossed.provider, crossed.model) }).not.toThrow()
    }
  })
})
