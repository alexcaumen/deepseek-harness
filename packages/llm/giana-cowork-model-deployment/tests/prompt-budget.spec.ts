import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import {
  applyPromptBudget, compactPromptSelections,
} from '../src/index.ts'
import type { RouteConfig } from '../src/index.ts'

const route = (provider: string, model: string, promptProfile?: 'compact-4k'): RouteConfig => ({
  id: `${provider}:${model}`,
  provider,
  model,
  disposition: 'AVAILABLE',
  admissionReceiptDigest: `sha256:${'a'.repeat(64)}`,
  revisionDigest: `sha256:${'b'.repeat(64)}`,
  targets: ['r5300'],
  allowRamCpuOffload: true,
  ...(promptProfile === undefined ? {} : { promptProfile }),
})

function assembly(provider: string, model: string): PromptAssembly {
  return {
    sections: [
      { name: 'harness:identity', text: 'large identity' },
      { name: 'deployment:persona', text: 'large persona' },
      { name: 'tool:read', text: 'read guidance' },
      { name: 'tool:hidden', text: 'hidden guidance' },
      { name: 'tool:cordis', text: 'large tool prose' },
      { name: 'tools:on-demand', text: 'discovery guidance' },
      { name: 'tools:code-only', text: 'code mode contract' },
      { name: 'tools:sdk', text: 'generated sdk' },
    ],
    contexts: [{ name: 'sandbox:policy', text: 'read-only' }],
    tools: [
      { name: 'read', description: 'Read once', parameters: { type: 'object' } },
      { name: 'hidden', description: 'Hidden on demand', parameters: { type: 'object' } },
      { name: 'cordis_define', description: 'Define Cordis package', parameters: { type: 'object' } },
    ],
    variables: { provider, model, cwd: 'N:\\workspace' },
  }
}

it('compacts only the exact provider and model declared by a 4K route', () => {
  const selections = compactPromptSelections({ routes: [
    route('glm-local-r5300', 'official-65k'),
    route('glm-uncensored-local-r5300', 'uncensored-4k', 'compact-4k'),
  ] })
  const input = assembly('glm-uncensored-local-r5300', 'uncensored-4k')
  const output = applyPromptBudget(input, selections, {
    provider: 'glm-uncensored-local-r5300', model: 'uncensored-4k',
  }, input.tools.slice(0, 1))

  expect(output).not.toBe(input)
  expect(output.sections).toEqual([
    { name: 'harness:identity', text: 'large identity' },
    { name: 'deployment:persona', text: 'large persona' },
    { name: 'tool:read', text: 'read guidance' },
    { name: 'tools:on-demand', text: 'discovery guidance' },
    { name: 'tools:code-only', text: 'code mode contract' },
    { name: 'tools:sdk', text: 'generated sdk' },
  ])
  expect(output.contexts).toBe(input.contexts)
  expect(output.tools).toBe(input.tools)
  expect(output.variables).toBe(input.variables)
})

it.each([
  ['glm-local-r5300', 'official-65k'],
  ['glm-uncensored-local-r5300', 'other-model'],
  ['qwen-local-r5300', 'uncensored-4k'],
  ['codex-native', 'gpt-6-astra'],
])('leaves non-target route %s/%s byte-for-byte assembled', (provider, model) => {
  const selections = compactPromptSelections({ routes: [
    route('glm-uncensored-local-r5300', 'uncensored-4k', 'compact-4k'),
  ] })
  const input = assembly(provider, model)
  expect(applyPromptBudget(input, selections, { provider, model })).toBe(input)
})

it('requires an atomically captured provider and model before applying a budget', () => {
  const selections = new Set(['glm\u0000model'])
  const input = assembly('glm', 'model')
  expect(applyPromptBudget(input, selections, undefined)).toBe(input)
})

it('preserves family guidance when one of its exact schemas is visible', () => {
  const input = assembly('local', '4k')
  const output = applyPromptBudget(
    input,
    new Set(['local\u00004k']),
    { provider: 'local', model: '4k' },
    input.tools.filter(tool => tool.name === 'read' || tool.name === 'cordis_define'),
  )
  expect(output.sections.map(section => section.name)).toContain('tool:cordis')
  expect(output.sections.map(section => section.name)).not.toContain('tool:hidden')
})

it('preserves all tool guidance when Code Mode reaches capabilities through the SDK', () => {
  const input = assembly('local', '4k')
  input.tools.push({ name: 'run_code', description: 'Run code', parameters: { type: 'object' } })
  const output = applyPromptBudget(
    input,
    new Set(['local\u00004k']),
    { provider: 'local', model: '4k' },
    input.tools.filter(tool => tool.name === 'run_code'),
  )
  expect(output).toBe(input)
})

describe('atomic selection ordering', () => {
  let ctx: Context | undefined
  afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined })

  it.each(['budget-first', 'selection-first'] as const)(
    'uses the same captured route when listeners register %s', async (order) => {
      ctx = new Context()
      await ctx.plugin(SystemPrompt, { persona: 'custom persona' })
      ctx.systemPrompt.section({ name: 'tool:hidden', order: 100, text: 'hidden guidance' })
      ctx.systemPrompt.tools(() => ({
        schemas: [
          { name: 'read', description: 'read', parameters: { type: 'object' } },
          { name: 'hidden', description: 'hidden', parameters: { type: 'object' } },
        ],
      }))
      const selected: ModelSelectionRef = {
        current: { provider: 'local', model: '4k' }, assembled: undefined,
      }
      const selections = new Set(['local\u00004k'])
      const budget = () => ctx!.on('system-prompt/assemble', async (_assembly, context, next) => {
        const assembled = await next()
        return applyPromptBudget(
          assembled,
          selections,
          context.modelSelection,
          assembled.tools.filter(tool => tool.name === 'read'),
        )
      })
      if (order === 'budget-first') {
        budget()
        installModelSelection(ctx, selected)
      } else {
        installModelSelection(ctx, selected)
        budget()
      }

      expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name))
        .not.toContain('tool:hidden')
      selected.current = { provider: 'cloud', model: 'large' }
      expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name))
        .toContain('tool:hidden')
    },
  )
})
