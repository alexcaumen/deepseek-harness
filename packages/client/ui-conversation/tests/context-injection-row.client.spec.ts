import { describe, expect, it } from 'vitest'
import { contextProducerLabel } from '../src/client/chat/ContextInjectionRow.tsx'

describe('context producer presentation', () => {
  it('projects upstream package provenance as the owned product name', () => {
    expect(contextProducerLabel('@deepseek-ai/dsh-system-prompt')).toBe('Giana CoWork Preview')
    expect(contextProducerLabel('@deepseek-ai/dsh-client-runtime')).toBe('Giana CoWork Preview')
  })

  it('preserves owned and user-facing producer labels', () => {
    expect(contextProducerLabel('skill-catalog')).toBe('skill-catalog')
    expect(contextProducerLabel('GianaOS Front Door')).toBe('GianaOS Front Door')
    expect(contextProducerLabel(null)).toBeNull()
  })
})
