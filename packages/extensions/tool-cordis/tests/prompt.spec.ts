import { describe, expect, it } from 'vitest'
import { CORDIS_SYSTEM_PROMPT } from '../src/prompt.ts'

describe('Cordis model prompt', () => {
  it('keeps the safety contract compact and delegates detailed guidance to the skill', () => {
    expect(CORDIS_SYSTEM_PROMPT.length).toBeLessThan(2_500)
    expect(CORDIS_SYSTEM_PROMPT).toContain('cordis-plugin-development skill')
    expect(CORDIS_SYSTEM_PROMPT).toContain('A definition does not run')
    expect(CORDIS_SYSTEM_PROMPT).toContain('Approval belongs to the UI')
    expect(CORDIS_SYSTEM_PROMPT).toContain('plain JavaScript only')
    expect(CORDIS_SYSTEM_PROMPT).toContain('every side effect to a disposer')
    expect(CORDIS_SYSTEM_PROMPT).toContain('never serialize live runtime objects')
  })
})
