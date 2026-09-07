import { describe, expect, it, vi } from 'vitest'
import {
  AI_STUDIOTECH_GLM53_R3_HANDOFF_DIGEST,
  AI_STUDIOTECH_GLM53_R3_VALIDATION_DIGEST,
  AI_STUDIOTECH_SIX_VARIANT_ASSEMBLY_RECEIPT_DIGEST,
  AI_STUDIOTECH_SIX_VARIANT_HANDOFF_DIGEST,
  AI_STUDIOTECH_SIX_VARIANT_SELECTION_INDEX_DIGEST,
  AI_STUDIOTECH_SIX_VARIANT_VALIDATION_DIGEST,
  CANONICAL_AUTHORITIES,
  DEEPSEEK_V4_ROUTE_IDS,
  DEEPSEEK_V4_TERMINAL_OBSERVATIONS,
  GIANA_GIRLS,
  GLM53_TERMINAL_OBSERVATIONS,
  GLM53_ROUTE_IDS,
  GIANOS_FRONT_DOOR,
  LOCAL_MODEL_ROUTE_IDS,
  LOCAL_MODEL_TERMINAL_OBSERVATIONS,
  SOURCE_ONLY_CONTRACT,
  assertSourceOnlyCatalog,
  deepseekV4Routes,
  glm53Routes,
  isSelectable,
  localModelEvidenceRoutes,
  materializeSelection,
  qwenRoute,
  sourceOnlyCatalog,
  verifySelectionEvidence,
} from '../src/index.ts'

const digest = (digit: string): string => `sha256:${digit.repeat(64)}`

describe('source-only GianaOS/GDM/R5300 front door', () => {
  const catalog = sourceOnlyCatalog()

  it('exposes exactly 13 Giana Girls, one governed Qwen route, and six held evidence routes', () => {
    expect(catalog).toHaveLength(20)
    expect(catalog.filter(item => item.kind === 'giana-girl').map(item => item.id))
      .toEqual(GIANA_GIRLS.map(id => `giana.${id}`))
    expect(catalog.find(item => item.id === qwenRoute().id)?.displayName).toBe('Qwen 3.8-27B')
    expect(qwenRoute().terminalObservation).toMatchObject({
      recordedState: 'RESTORED_RUNNING_HEALTHY',
      historicalOnly: true,
      selectorState: 'EXISTING_ROUTE_PRESERVED',
      handoffDigest: AI_STUDIOTECH_GLM53_R3_HANDOFF_DIGEST,
      validationDigest: AI_STUDIOTECH_GLM53_R3_VALIDATION_DIGEST,
    })
    expect(catalog.filter(item => GLM53_ROUTE_IDS.includes(item.id as typeof GLM53_ROUTE_IDS[number])))
      .toHaveLength(4)
    for (const id of GLM53_ROUTE_IDS) {
      expect(catalog.find(item => item.id === id)?.selection.state).toBe('BLOCKED')
    }
    expect(glm53Routes().map(item => item.terminalObservation?.selectorState))
      .toEqual(['HIDDEN_HELD', 'VISIBLE_DISABLED', 'HIDDEN_HELD', 'HIDDEN_HELD'])
    expect(glm53Routes().map(item => item.terminalObservation?.recordedState))
      .toEqual(GLM53_TERMINAL_OBSERVATIONS.map(item => item.recordedState))
    expect(glm53Routes().map(item => item.id)).toEqual(GLM53_ROUTE_IDS)
    expect(glm53Routes().map(item => item.displayName)).toEqual([
      'GLM 5.3 Flash Official FP8',
      'GLM 5.3 Flash OrcaSAQ MLX Mixed 4/5/6-bit',
      'GLM 5.3 Flash OrcaRouter Uncensored FP8',
      'GLM 5.3 Flash OrcaRouter Uncensored GGUF Q6_K',
    ])
    expect(deepseekV4Routes().map(item => item.id)).toEqual(DEEPSEEK_V4_ROUTE_IDS)
    expect(deepseekV4Routes().map(item => item.displayName)).toEqual([
      'DeepSeek V4 Flash Vision Exp UD-Q8_K_XL',
      'DeepSeek V4 Flash Vision Uncensored',
    ])
    expect(glm53Routes().every(item => item.terminalObservation?.historicalOnly === true)).toBe(true)
  })

  it('binds the exact current six-model packet without admitting or defaulting any route', () => {
    const routes = localModelEvidenceRoutes()
    expect(routes.map(item => item.id)).toEqual(LOCAL_MODEL_ROUTE_IDS)
    expect(routes).toHaveLength(6)
    expect(LOCAL_MODEL_TERMINAL_OBSERVATIONS).toHaveLength(6)
    expect(GLM53_TERMINAL_OBSERVATIONS).toHaveLength(4)
    expect(DEEPSEEK_V4_TERMINAL_OBSERVATIONS).toHaveLength(2)

    for (const route of routes) {
      expect(route.selection.state).toBe('BLOCKED')
      expect(route.sourceOnly).toBe(true)
      expect(route.terminalObservation).toMatchObject({
        historicalOnly: true,
        handoffDigest: AI_STUDIOTECH_SIX_VARIANT_HANDOFF_DIGEST,
        validationDigest: AI_STUDIOTECH_SIX_VARIANT_VALIDATION_DIGEST,
        routeAdmission: false,
        productionGreen: false,
      })
    }

    expect(LOCAL_MODEL_TERMINAL_OBSERVATIONS.filter(item => item.r5300Compatible)).toHaveLength(5)
    expect(LOCAL_MODEL_TERMINAL_OBSERVATIONS.filter(item => !item.r5300Compatible)).toEqual([
      expect.objectContaining({
        variantId: 'glm53_orcarouter_mlx_mixed_4_5_6',
        runtimeEngine: 'MLX_AUDIT_ONLY_NO_SELECTED_CUDA_RUNTIME',
        selectorState: 'VISIBLE_DISABLED',
      }),
    ])
    expect(LOCAL_MODEL_TERMINAL_OBSERVATIONS.find(item => item.variantId === 'glm53_orcarouter_uncensored_gguf_q6k'))
      .toMatchObject({
        toolCallEvidence: 'FAIL_3_OF_3',
        recordedState: 'TESTED_WITH_TOOL_CALL_HELD_NOT_ADMITTED',
        nextPredicate: 'GLM53_Q6_NATIVE_TOOL_CALL_OBJECT_NOT_EMITTED_THREE_OF_THREE',
      })
    expect(LOCAL_MODEL_TERMINAL_OBSERVATIONS.filter(item => item.toolCallEvidence === 'PASS_3_OF_3'))
      .toHaveLength(4)
    expect(SOURCE_ONLY_CONTRACT).toMatchObject({
      terminalHandoffDigest: AI_STUDIOTECH_SIX_VARIANT_HANDOFF_DIGEST,
      terminalAssemblyReceiptDigest: AI_STUDIOTECH_SIX_VARIANT_ASSEMBLY_RECEIPT_DIGEST,
      terminalValidationDigest: AI_STUDIOTECH_SIX_VARIANT_VALIDATION_DIGEST,
      terminalSelectionIndexDigest: AI_STUDIOTECH_SIX_VARIANT_SELECTION_INDEX_DIGEST,
      routeAdmission: false,
      registryActivated: false,
      defaultModelChanged: false,
      productionGreen: false,
      liveActivation: false,
    })
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

  it('rejects a structurally complete but unverified plain object', () => {
    const putri = catalog[0]!
    const evidence = {
      routeId: putri.id,
      frontDoor: GIANOS_FRONT_DOOR,
      identityDigest: digest('a'),
      currentnessDigest: digest('b'),
      capabilityDigest: digest('c'),
      currentness: 'CURRENT' as const,
      capability: 'READY' as const,
      sourceOnly: false as const,
    }
    expect(isSelectable(putri, evidence)).toBe(false)
    expect(() => materializeSelection(putri, evidence)).toThrow('CURRENTNESS_AND_CAPABILITY')
  })

  it('allows selection only after canonical verification mints detached evidence', async () => {
    const putri = catalog[0]!
    const evidence = {
      routeId: putri.id,
      frontDoor: GIANOS_FRONT_DOOR,
      identityDigest: digest('a'),
      currentnessDigest: digest('b'),
      capabilityDigest: digest('c'),
      currentness: 'CURRENT' as const,
      capability: 'READY' as const,
      sourceOnly: false as const,
    }
    const authority = {
      verifySelectionEvidence: vi.fn(() => true),
    }
    const verified = await verifySelectionEvidence(putri, evidence, authority)
    const selected = materializeSelection(putri, verified)

    expect(authority.verifySelectionEvidence).toHaveBeenCalledWith(putri, verified)
    expect(verified).not.toBe(evidence)
    expect(Object.isFrozen(verified)).toBe(true)
    expect(isSelectable(putri, verified)).toBe(true)
    expect(selected.selection.state).toBe('ALLOWED')
    expect(selected.route.id).toBe('giana.putri')
  })

  it('binds verified evidence to the exact immutable descriptor', async () => {
    const putri = catalog[0]!
    const evidence = {
      routeId: putri.id,
      frontDoor: GIANOS_FRONT_DOOR,
      identityDigest: digest('a'),
      currentnessDigest: digest('b'),
      capabilityDigest: digest('c'),
      currentness: 'CURRENT' as const,
      capability: 'READY' as const,
      sourceOnly: false as const,
    }
    const verified = await verifySelectionEvidence(putri, evidence, {
      verifySelectionEvidence: () => true,
    })
    const forged = Object.freeze({
      ...putri,
      authorities: Object.freeze({
        ...putri.authorities,
        audit: 'caller-controlled-authority',
      }),
    }) as unknown as typeof putri

    expect(forged.id).toBe(putri.id)
    expect(Object.isFrozen(forged)).toBe(true)
    expect(isSelectable(putri, verified)).toBe(true)
    expect(isSelectable(forged, verified)).toBe(false)
    expect(() => materializeSelection(forged, verified)).toThrow('CURRENTNESS_AND_CAPABILITY')
  })

  it('rejects malformed digests before verification and authority rejection after validation', async () => {
    const putri = catalog[0]!
    const malformed = {
      routeId: putri.id,
      frontDoor: GIANOS_FRONT_DOOR,
      identityDigest: 'sha256:not-a-digest',
      currentnessDigest: digest('b'),
      capabilityDigest: digest('c'),
      currentness: 'CURRENT' as const,
      capability: 'READY' as const,
      sourceOnly: false as const,
    }
    const verifier = vi.fn(() => true)
    await expect(verifySelectionEvidence(putri, malformed, {
      verifySelectionEvidence: verifier,
    })).rejects.toThrow('CURRENTNESS_AND_CAPABILITY')
    expect(verifier).not.toHaveBeenCalled()

    await expect(verifySelectionEvidence(putri, {
      ...malformed,
      identityDigest: digest('a'),
    }, {
      verifySelectionEvidence: () => false,
    })).rejects.toThrow('CURRENTNESS_AND_CAPABILITY')
  })
})
