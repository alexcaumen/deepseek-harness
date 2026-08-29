import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import ToolAccessPolicy from '@grinviro/dsh-tool-access-policy'

const signal = new AbortController().signal
const windowsApprovalTool = 'mcp__windows_desktop__approve_automation'
const windowsMutationTool = 'mcp__windows_desktop__automation_mouse'

async function harness(
  config: Parameters<typeof ToolAccessPolicy>[1],
  onDispatch: (name: string) => void = () => {},
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(Tools, {})
  await ctx.plugin(ToolAccessPolicy, config)
  for (const name of [
    'mcp__playwright__browser_snapshot',
    'mcp__playwright__browser_run_code_unsafe',
    'mcp__playwright__browser_file_upload',
    windowsApprovalTool,
    windowsMutationTool,
    'mcp__windows_desktop__automation_face',
    'mcp__windows_desktop__global_keylogger',
  ]) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: name,
      parameters: {
        operation: { type: 'string' },
        approved: { type: 'boolean' },
        human_approved: { type: 'boolean' },
        duration_minutes: { type: 'number' },
      },
      async execute() {
        onDispatch(name)
        return [{ type: 'text', text: 'ran' }]
      },
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

  it('does not let the model invoke the vendor self-approval tool without DSH approval', async () => {
    const dispatched: string[] = []
    const ctx = await harness({ askPatterns: ['mcp__windows_desktop__*'] }, name => dispatched.push(name))

    const result = await ctx.tools.execute({
      callId: CallId('self-approve'),
      name: windowsApprovalTool,
      arguments: { duration_minutes: 60 },
      signal,
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('requires one-shot human approval'),
    })
    expect(dispatched).toEqual([])
  })

  it('waits for a one-shot DSH human grant before dispatching the exact call', async () => {
    const dispatched: string[] = []
    const requests: Array<{ toolName: string; callId: string; reason?: string }> = []
    const decision = Promise.withResolvers<'allowed-once' | 'rejected'>()
    const ctx = await harness({ askPatterns: ['mcp__windows_desktop__*'] }, name => dispatched.push(name))
    ctx.provide('approval', {
      request(request: { toolName: string; callId: string; reason?: string }) {
        requests.push(request)
        return decision.promise
      },
    } as never)

    const pending = ctx.tools.execute({
      callId: CallId('human-approved'),
      name: windowsApprovalTool,
      arguments: { duration_minutes: 5 },
      agent: {} as never,
      signal,
    })

    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]).toMatchObject({
      toolName: windowsApprovalTool,
      callId: 'human-approved',
      reason: expect.stringContaining('one-shot human approval'),
    })
    expect(dispatched).toEqual([])

    decision.resolve('allowed-once')
    await expect(pending).resolves.toMatchObject({ isError: false })
    expect(dispatched).toEqual([windowsApprovalTool])
  })

  it('ignores model-supplied approval claims when the human rejects the mutation', async () => {
    const dispatched: string[] = []
    const ctx = await harness({ askPatterns: ['mcp__windows_desktop__*'] }, name => dispatched.push(name))
    ctx.provide('approval', {
      request: () => Promise.resolve('rejected'),
    } as never)

    const result = await ctx.tools.execute({
      callId: CallId('model-claim'),
      name: windowsMutationTool,
      arguments: { operation: 'click', approved: true, human_approved: true },
      agent: {} as never,
      signal,
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining(`the user rejected tool "${windowsMutationTool}"`),
    })
    expect(dispatched).toEqual([])
  })

  it('denies disabled invasive tools before consulting an approval answerer', async () => {
    let asked = false
    const ctx = await harness({
      denyPatterns: [
        'mcp__windows_desktop__automation_face',
        'mcp__windows_desktop__global_keylogger',
      ],
      askPatterns: ['mcp__windows_desktop__*'],
    })
    ctx.provide('approval', {
      request: () => {
        asked = true
        return Promise.resolve('allowed-once')
      },
    } as never)

    for (const [index, name] of [
      'mcp__windows_desktop__automation_face',
      'mcp__windows_desktop__global_keylogger',
    ].entries()) {
      const result = await ctx.tools.execute({
        callId: CallId(`invasive-${index}`), name, arguments: {}, agent: {} as never, signal,
      })
      expect(result.isError).toBe(true)
      expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('disabled') })
    }
    expect(asked).toBe(false)
  })
})
