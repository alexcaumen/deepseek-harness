import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import ToolAccessPolicy from '@grinviro/dsh-tool-access-policy'

const signal = new AbortController().signal

async function harness(config: Parameters<typeof ToolAccessPolicy>[1]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(Tools, {})
  await ctx.plugin(ToolAccessPolicy, config)
  for (const name of [
    'mcp__playwright__browser_snapshot',
    'mcp__playwright__browser_run_code_unsafe',
    'mcp__playwright__browser_file_upload',
  ]) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: name,
      parameters: {},
      async execute() { return [{ type: 'text', text: 'ran' }] },
    }))
  }
  return ctx
}

describe('tool access policy', () => {
  it('allows an unmatched observation tool', async () => {
    const ctx = await harness({ denyPatterns: ['*run_code_unsafe', '*file_upload'] })
    const result = await ctx.tools.execute({
      callId: CallId('allow'), name: 'mcp__playwright__browser_snapshot', arguments: {}, signal,
    })
    expect(result.isError).toBe(false)
  })

  it('denies unsafe and upload tools without dispatching them', async () => {
    const ctx = await harness({ denyPatterns: ['*run_code_unsafe', '*file_upload'] })
    for (const [index, name] of [
      'mcp__playwright__browser_run_code_unsafe',
      'mcp__playwright__browser_file_upload',
    ].entries()) {
      const result = await ctx.tools.execute({
        callId: CallId(`deny-${index}`), name, arguments: {}, signal,
      })
      expect(result.isError).toBe(true)
      expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('disabled') })
    }
  })

  it('fails loud on an empty pattern', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(Tools, {})
    await expect(ctx.plugin(ToolAccessPolicy, { denyPatterns: [''] })).rejects.toThrow('must not be empty')
  })
})
