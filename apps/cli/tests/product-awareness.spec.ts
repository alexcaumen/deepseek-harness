import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

interface PresetEntry {
  id?: string
  config?: { text?: string }
}

const CORDIS_PRESET = fileURLToPath(new URL('../config/agent-presets/cordis/agent.cordis.yml', import.meta.url))

describe('Giana Code Putri product awareness', () => {
  it('renders the shipped Cordis persona under the product identity', async () => {
    const parsed: unknown = yaml.load(readFileSync(CORDIS_PRESET, 'utf8'), { schema: entryListSchema })
    if (!Array.isArray(parsed)) throw new TypeError('the Cordis preset must parse to an entry array')
    const persona = (parsed as PresetEntry[]).find(entry => entry.id === 'persona')?.config?.text
    if (persona === undefined) throw new TypeError('the Cordis preset must provide persona text')

    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, { persona })
      ctx.systemPrompt.variable('model', () => 'gianaos/putri')
      ctx.systemPrompt.variable('cwd', () => '/workspace')

      const rendered = renderPrompt(await ctx.systemPrompt.assemble())
      const productOpening = rendered.split('Two planes decide where an edit belongs.')[0]
      expect(productOpening).toContain('working through Giana Code Putri')
      expect(productOpening).toContain('modify the Giana Code Putri implementation')
      expect(productOpening).toContain('powered by the gianaos/putri model')
      expect(productOpening).not.toMatch(/\b(?:DeepSeek Harness|DSH|harness)\b/i)
      expect(rendered).toContain('${DSH_HOME:-$HOME/.dsh}')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
