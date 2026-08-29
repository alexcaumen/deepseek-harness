import { describe, expect, it } from 'vitest'
import {
  PUBLIC_FEATURES,
  PUBLIC_FEATURE_CATEGORIES,
} from '../src/client/publicFeatureCatalog.ts'

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

  it('keeps every catalog entry a discoverable claim without a runtime-state field', () => {
    expect(PUBLIC_FEATURES.every(feature => feature.claim === 'discoverable')).toBe(true)
    for (const feature of PUBLIC_FEATURES) {
      expect(feature).not.toHaveProperty('state')
      expect(feature).not.toHaveProperty('runtimeState')
      expect(feature.detail).toContain('require live runtime evidence')
    }
  })
})
