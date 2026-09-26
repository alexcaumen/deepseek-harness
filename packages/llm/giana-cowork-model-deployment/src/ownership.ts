/** RC53-only model ownership declaration, independent of model activation. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

export interface ModelOwnerPair {
  provider: string
  model: string
}

export interface Config {
  pairs: ModelOwnerPair[]
}

const MAX_PAIRS = 16
const ID = /^[^\u0000-\u001f\u007f]+$/u

export const name = 'giana-cowork-rc53-model-ownership'
export const inject = ['llm']
export const Config: z<Config> = z.object({
  pairs: z.array(z.object({
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
  })).min(1).max(MAX_PAIRS),
})

function validate(input: unknown, config: Config): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => key !== 'pairs')) {
    throw new Error('RC53 model ownership requires only an explicit pairs list')
  }
  const originalPairs = (input as { pairs?: unknown }).pairs
  if (!Array.isArray(originalPairs) || originalPairs.length < 1 || originalPairs.length > MAX_PAIRS
    || originalPairs.length !== config.pairs.length) {
    throw new Error('RC53 model ownership pairs must be an explicit finite list')
  }
  const seen = new Set<string>()
  for (const [index, pair] of config.pairs.entries()) {
    const original = originalPairs[index]
    if (original === null || typeof original !== 'object' || Array.isArray(original)
      || Object.keys(original).sort().join(',') !== 'model,provider') {
      throw new Error(`RC53 model ownership pair ${index} must contain only provider and model`)
    }
    const raw = original as { provider?: unknown; model?: unknown }
    if (typeof raw.provider !== 'string' || typeof raw.model !== 'string'
      || raw.provider !== pair.provider || raw.model !== pair.model
      || !ID.test(pair.provider) || !ID.test(pair.model)
      || pair.provider.trim() !== pair.provider || pair.model.trim() !== pair.model) {
      throw new Error(`RC53 model ownership pair ${index} has an invalid provider or model id`)
    }
    const key = `${pair.provider}\u0000${pair.model}`
    if (seen.has(key)) throw new Error(`RC53 model ownership pair ${index} is duplicated`)
    seen.add(key)
  }
}

/** The LLM service retains these reservations until its runtime is disposed. */
export function apply(ctx: Context, input: Config): void {
  const config = Config(input)
  validate(input, config)
  ctx.llm.registerModelOwnership(config.pairs)
}
