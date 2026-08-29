import { describe, expect, it } from 'vitest'
import {
  CANONICAL_AUTHORITIES,
  GIANA_GIRLS,
  GIANOS_FRONT_DOOR,
  assertSourceOnlyCatalog,
  isSelectable,
  materializeSelection,
  qwenRoute,
  sourceOnlyCatalog,
} from '../src/index.ts'

describe('source-only GianaOS/GDM/R5300 front door', () => {
  const catalog = sourceOnlyCatalog()

  it('exposes exactly 13 Giana Girls and one governed Qwen route', () => {
    expect(catalog).toHaveLength(14)
    expect(catalog.filter(item => item.kind === 'giana-girl').map(item => item.id))
      .toEqual(GIANA_GIRLS.map(id => `giana.${id}`))
    expect(catalog.find(item => item.id === qwenRoute().id)?.displayName).toBe('Qwen 3.8-27B')
  })

  it('keeps every entry on one authority tuple and blocks source-only selection', () => {
    assertSourceOnlyCatalog(catalog)
    for (const item of catalog) {
      expect(item.frontDoor).toBe(GIANOS_FRONT_DOOR)
      expect(item.authorities).toBe(CANONICAL_AUTHORITIES)
      expect(item.sourceOnly).toBe(true)
      expect(item.selection.state).toBe('BLOCKED')
      expect(isSelectable(item, undefined)).toBe(false)
    }
  })

  it('rejects mismatched, incomplete, or absent evidence', () => {
    const putri = catalog[0]!
    const incomplete = {
      routeId: putri.id,
      frontDoor: GIANOS_FRONT_DOOR,
      identityDigest: 'identity',
      currentnessDigest: '',
      capabilityDigest: 'capability',
      currentness: 'CURRENT' as const,
      capability: 'READY' as const,
      sourceOnly: false as const,
    }
    expect(isSelectable(putri, incomplete)).toBe(false)
    expect(() => materializeSelection(putri, incomplete)).toThrow('CURRENTNESS_AND_CAPABILITY')
  })

  it('allows selection only after typed canonical evidence is complete', () => {
    const putri = catalog[0]!
    const evidence = {
      routeId: putri.id,
      frontDoor: GIANOS_FRONT_DOOR,
      identityDigest: 'sha256:identity',
      currentnessDigest: 'sha256:currentness',
      capabilityDigest: 'sha256:capability',
      currentness: 'CURRENT' as const,
      capability: 'READY' as const,
      sourceOnly: false as const,
    }
    const selected = materializeSelection(putri, evidence)
    expect(selected.selection.state).toBe('ALLOWED')
    expect(selected.route.id).toBe('giana.putri')
  })
})
