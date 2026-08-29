import { describe, expect, it } from 'vitest'
import {
  PUBLIC_FEATURES,
  PUBLIC_FEATURE_CATEGORIES,
  type PublicFeatureState,
} from '../src/client/publicFeatureCatalog.ts'

const STATES: readonly PublicFeatureState[] = [
  'DISCOVERABLE', 'INSTALLED', 'REGISTERED', 'ENABLED', 'NEEDS_SIGN_IN',
  'NEEDS_RUNTIME', 'READY', 'DEGRADED', 'FAILED', 'HELD',
]

describe('public feature catalog', () => {
  it('contains exactly 96 unique features across 12 balanced categories', () => {
    expect(PUBLIC_FEATURE_CATEGORIES).toHaveLength(12)
    expect(PUBLIC_FEATURES).toHaveLength(96)
    expect(new Set(PUBLIC_FEATURES.map(feature => feature.id)).size).toBe(96)
    expect(new Set(PUBLIC_FEATURES.map(feature => feature.title)).size).toBe(96)
    for (const category of PUBLIC_FEATURE_CATEGORIES) {
      expect(PUBLIC_FEATURES.filter(feature => feature.category === category)).toHaveLength(8)
    }
  })

  it('uses canonical states and promotes only routes backed by current evidence', () => {
    expect(PUBLIC_FEATURES.every(feature => STATES.includes(feature.state))).toBe(true)
    expect(PUBLIC_FEATURES.find(feature => feature.title === 'Qwen and Alibaba Open Models')?.state)
      .toBe('READY')
    expect(PUBLIC_FEATURES.find(feature => feature.title === 'Windows Desktop Computer Use and UI Automation')?.state)
      .toBe('READY')
    expect(PUBLIC_FEATURES.find(feature => feature.title === 'OpenAI Models and Official Sign-In/API Routes')?.state)
      .toBe('NEEDS_SIGN_IN')
  })
})
