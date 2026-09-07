/**
 * Source-only canonical front-door descriptors for Giana CoWork Preview.
 *
 * This package deliberately has no Cordis registration and no provider call.
 * It describes the only route shape that a future GCP UI integration may
 * select after GianaOS/GDM/R5300 supplies typed currentness and capability
 * evidence. Princess OS/Lara is intentionally outside this catalog.
 */

export const GIANOS_FRONT_DOOR = 'canonical-gianaos-gdm-r5300' as const
export const SOURCE_ONLY_STATE = 'SOURCE_ONLY' as const

export const CANONICAL_AUTHORITIES = Object.freeze({
  identity: 'GianaOS/GDM',
  sessions: 'GianaOS/GDM',
  quickq: 'GianaOS/GDM',
  memory: 'GianaOS',
  workers: 'GianaOS',
  moa: 'GianaOS',
  skills: 'GianaOS',
  approvals: 'GDM',
  credentials: 'SecretGuard-via-GDM',
  database: 'R5300-canonical-GianaOS',
  audit: 'GianaOS/GDM',
} as const)

export const GIANA_GIRLS = [
  'putri',
  'maya',
  'sari',
  'wulan',
  'dewi',
  'resi',
  'dara',
  'ayu',
  'ratna',
  'laras',
  'citra',
  'cinta',
  'shima',
] as const

export type GianaGirlId = typeof GIANA_GIRLS[number]
export type RouteKind = 'giana-girl' | 'governed-model'
export type CurrentnessState = 'UNVERIFIED' | 'CURRENT' | 'STALE' | 'HELD'
export type CapabilityState = 'UNVERIFIED' | 'READY' | 'PARTIAL' | 'HELD'
export type TerminalSelectorState = 'HIDDEN_HELD' | 'VISIBLE_DISABLED' | 'EXISTING_ROUTE_PRESERVED'

export interface TerminalModelObservation {
  readonly sourceRouteId: string
  /** State recorded by the hash-bound handoff, never a live-health assertion. */
  readonly recordedState: string
  readonly historicalOnly: true
  readonly selectorState: TerminalSelectorState
  readonly handoffDigest: string
  readonly validationDigest: string
}

export type LocalModelToolCallEvidence = 'PASS_3_OF_3' | 'FAIL_3_OF_3' | 'NOT_TESTED'

/** Hash-bound upstream evidence. This records capability; it never admits a route. */
export interface LocalModelEvidenceObservation extends TerminalModelObservation {
  readonly variantId: string
  readonly repository: string
  readonly revision: string
  readonly manifestDigest: string
  readonly modelRowDigest: string
  readonly runtimeEngine: string
  readonly r5300Compatible: boolean
  readonly supportsVision: boolean
  readonly toolCallEvidence: LocalModelToolCallEvidence
  readonly routeAdmission: false
  readonly productionGreen: false
  readonly nextPredicate: string
}

export interface CanonicalAuthoritySet {
  readonly identity: typeof CANONICAL_AUTHORITIES.identity
  readonly sessions: typeof CANONICAL_AUTHORITIES.sessions
  readonly quickq: typeof CANONICAL_AUTHORITIES.quickq
  readonly memory: typeof CANONICAL_AUTHORITIES.memory
  readonly workers: typeof CANONICAL_AUTHORITIES.workers
  readonly moa: typeof CANONICAL_AUTHORITIES.moa
  readonly skills: typeof CANONICAL_AUTHORITIES.skills
  readonly approvals: typeof CANONICAL_AUTHORITIES.approvals
  readonly credentials: typeof CANONICAL_AUTHORITIES.credentials
  readonly database: typeof CANONICAL_AUTHORITIES.database
  readonly audit: typeof CANONICAL_AUTHORITIES.audit
}

export interface SourceOnlyRouteDescriptor {
  readonly id: string
  readonly kind: RouteKind
  readonly displayName: string
  readonly frontDoor: typeof GIANOS_FRONT_DOOR
  readonly authorities: CanonicalAuthoritySet
  readonly currentness: CurrentnessState
  readonly capability: CapabilityState
  readonly selection: {
    readonly state: 'BLOCKED'
    readonly predicate: string
  }
  readonly terminalObservation?: TerminalModelObservation
  readonly sourceOnly: true
}

export interface SelectionEvidence {
  readonly routeId: string
  readonly frontDoor: typeof GIANOS_FRONT_DOOR
  readonly identityDigest: string
  readonly currentnessDigest: string
  readonly capabilityDigest: string
  readonly currentness: 'CURRENT'
  readonly capability: 'READY'
  readonly sourceOnly: false
}

declare const verifiedSelectionEvidenceBrand: unique symbol

/** Evidence whose detached value was accepted by a canonical verifier. */
export type VerifiedSelectionEvidence = SelectionEvidence & {
  readonly [verifiedSelectionEvidenceBrand]: true
}

/** Canonical verification seam; implementations validate signed currentness receipts. */
export interface SelectionEvidenceAuthority {
  verifySelectionEvidence(
    descriptor: SourceOnlyRouteDescriptor,
    evidence: Readonly<SelectionEvidence>,
  ): Promise<boolean> | boolean
}

export interface SelectableRoute {
  readonly route: SourceOnlyRouteDescriptor
  readonly selection: {
    readonly state: 'ALLOWED'
    readonly evidence: VerifiedSelectionEvidence
  }
}

const COMMON_SELECTION_PREDICATE = 'GIANOS_GDM_R5300_CURRENTNESS_AND_CAPABILITY_PROOF_REQUIRED'
const QWEN_SELECTION_PREDICATE = 'QWEN_3_8_27B_GIANAOS_GDM_ROUTE_ADMISSION_REQUIRED'
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u
const verifiedSelectionEvidence = new WeakMap<object, SourceOnlyRouteDescriptor>()

export const AI_STUDIOTECH_GLM53_R3_HANDOFF_DIGEST
  = 'sha256:e81e14ce6b3a76938569113bee70d95962aa8ad46ad8d2438a4d2e864aa9ebc6' as const
export const AI_STUDIOTECH_GLM53_R3_VALIDATION_DIGEST
  = 'sha256:256db3588e52ab2208489c245e789ef867ad6e90694190f1ddfb53bed153f20d' as const

export const AI_STUDIOTECH_SIX_VARIANT_HANDOFF_DIGEST
  = 'sha256:0ff9813619290e7f09b7449a2a8bc41d76fa8fa5254f1f5bb4e660d9b26af1fb' as const
export const AI_STUDIOTECH_SIX_VARIANT_ASSEMBLY_RECEIPT_DIGEST
  = 'sha256:00a994b6f3708021d7d05f44d0d1ab4b6530874e829c383ad91897c0cdcc3f02' as const
export const AI_STUDIOTECH_SIX_VARIANT_VALIDATION_DIGEST
  = 'sha256:4f509cec5cfcf66a0458cdfe3feb67f7fc002f04c71b76dbe9acc49e263a2596' as const
export const AI_STUDIOTECH_SIX_VARIANT_SELECTION_INDEX_DIGEST
  = 'sha256:665a9a3c42fd04f221e84194c44e3d88e60fb8901e079205237bb79318e2faa7' as const

export const GLM53_ROUTE_IDS = [
  'model.glm53.flash.official.fp8.local',
  'model.glm53.flash.orcasaq.mlx.mixed456.local',
  'model.glm53.flash.orcarouter.uncensored.fp8.local',
  'model.glm53.flash.orcarouter.uncensored.gguf.q6_k.local',
] as const

export const DEEPSEEK_V4_ROUTE_IDS = [
  'model.deepseek.v4.flash.vision.regular.ud_q8_k_xl.local',
  'model.deepseek.v4.flash.vision.uncensored.safetensors.local',
] as const

export const LOCAL_MODEL_ROUTE_IDS = [
  ...GLM53_ROUTE_IDS,
  ...DEEPSEEK_V4_ROUTE_IDS,
] as const

export const QWEN_TERMINAL_OBSERVATION: TerminalModelObservation = Object.freeze({
  sourceRouteId: 'Qwen/Qwen3.8-27B',
  recordedState: 'RESTORED_RUNNING_HEALTHY',
  historicalOnly: true,
  selectorState: 'EXISTING_ROUTE_PRESERVED',
  handoffDigest: AI_STUDIOTECH_GLM53_R3_HANDOFF_DIGEST,
  validationDigest: AI_STUDIOTECH_GLM53_R3_VALIDATION_DIGEST,
})

export const LOCAL_MODEL_TERMINAL_OBSERVATIONS: readonly LocalModelEvidenceObservation[] = Object.freeze(([
  {
    sourceRouteId: 'glm53.flash.official.fp8.local',
    variantId: 'glm53_official_fp8',
    repository: 'zai-org/GLM-5.3-Flash',
    revision: '03eb5366286afd40d2221b1d9c63a6dd1ba4832e',
    manifestDigest: 'sha256:03a47e43a65582c9ea2e7d36ee09e366727025509c729679c9830cd54bc2c16c',
    modelRowDigest: 'sha256:d350e99fb08fe203481690386f296675c9bca922774a82bc86812176babce584',
    runtimeEngine: 'SGLANG_PLUS_KTRANSFORMERS',
    r5300Compatible: true,
    supportsVision: true,
    toolCallEvidence: 'PASS_3_OF_3',
    recordedState: 'TESTED_NOT_ADMITTED',
    historicalOnly: true,
    selectorState: 'HIDDEN_HELD',
    nextPredicate: 'CURRENT_ROUTE_ADMISSION_AND_DEPLOYED_SERVER_MANAGER_BINDING_REQUIRED',
  },
  {
    sourceRouteId: 'glm53.flash.orcasaq.mlx.mixed456.local',
    variantId: 'glm53_orcarouter_mlx_mixed_4_5_6',
    repository: 'orcarouter/GLM-5.3-Flash-MLX',
    revision: 'c80f6810b1a95b5be9042761becc6aa78d189782',
    manifestDigest: 'sha256:45603e9451252331346dfbc7c43a09f22f0173d8e2fdff9eb8daa7d7ae08196c',
    modelRowDigest: 'sha256:eeca030e29319b4a36e16f54cc14236e018bb63ac5e9a3696b0c50ee6531c00e',
    runtimeEngine: 'MLX_AUDIT_ONLY_NO_SELECTED_CUDA_RUNTIME',
    r5300Compatible: false,
    supportsVision: true,
    toolCallEvidence: 'NOT_TESTED',
    recordedState: 'AUDIT_COMPLETE_NON_R5300_RUNTIME',
    historicalOnly: true,
    selectorState: 'VISIBLE_DISABLED',
    nextPredicate: 'STATIC_MLX_MIXED_PRECISION_LAYOUT_HAS_NO_PROVEN_INTERACTIVE_L40S_CUDA_SERVING_ROUTE',
  },
  {
    sourceRouteId: 'glm53.flash.orcarouter.uncensored.fp8.local',
    variantId: 'glm53_orcarouter_uncensored_fp8',
    repository: 'orcarouter/GLM-5.3-Flash-Uncensored-FP8',
    revision: '3cec42d6ed14ec197e328c09650c17fd3660c26a',
    manifestDigest: 'sha256:14637601f9a8631cf470103a9753c9a1e8c252cf575eb5b3c78c33b7cdf88f6b',
    modelRowDigest: 'sha256:87b00cdf3cb9ba56904cd2178bc8f61b2b5fe439ac91a53acf2e89f315d13ea9',
    runtimeEngine: 'SGLANG_PLUS_KTRANSFORMERS',
    r5300Compatible: true,
    supportsVision: true,
    toolCallEvidence: 'PASS_3_OF_3',
    recordedState: 'TESTED_NOT_ADMITTED',
    historicalOnly: true,
    selectorState: 'HIDDEN_HELD',
    nextPredicate: 'CURRENT_ROUTE_ADMISSION_AND_DEPLOYED_SERVER_MANAGER_BINDING_REQUIRED',
  },
  {
    sourceRouteId: 'glm53.flash.orcarouter.uncensored.gguf.q6_k.local',
    variantId: 'glm53_orcarouter_uncensored_gguf_q6k',
    repository: 'orcarouter/GLM-5.3-Flash-Uncensored-GGUF',
    revision: '47be41dfee785dd4247b9b0ecf765137fb9f5f7e',
    manifestDigest: 'sha256:14637601f9a8631cf470103a9753c9a1e8c252cf575eb5b3c78c33b7cdf88f6b',
    modelRowDigest: 'sha256:f88f687d16611a852d09a06821ea61dd4c5542ece6a2ce08d5a05b302d2efa16',
    runtimeEngine: 'LLAMA_CPP_CUDA_SM89',
    r5300Compatible: true,
    supportsVision: true,
    toolCallEvidence: 'FAIL_3_OF_3',
    recordedState: 'TESTED_WITH_TOOL_CALL_HELD_NOT_ADMITTED',
    historicalOnly: true,
    selectorState: 'HIDDEN_HELD',
    nextPredicate: 'GLM53_Q6_NATIVE_TOOL_CALL_OBJECT_NOT_EMITTED_THREE_OF_THREE',
  },
  {
    sourceRouteId: 'deepseek.v4.flash.vision.regular.ud_q8_k_xl.local',
    variantId: 'deepseek_v4_flash_vision_regular_ud_q8_k_xl',
    repository: 'unsloth/DeepSeek-V4-Flash-Vision-Exp-GGUF',
    revision: 'b977d3c0ea2da58dbc12ddae8fb8951a7b3854d0',
    manifestDigest: 'sha256:8c9db76f01c0401e708ff64541327bab296e791961d67d4d39eb6f7ca27ce752',
    modelRowDigest: 'sha256:eea81bbddb64de86fe612272b8d5465692051c6d98d655b7938fcac0f09d279e',
    runtimeEngine: 'LLAMA_CPP_CUDA_SM89',
    r5300Compatible: true,
    supportsVision: true,
    toolCallEvidence: 'PASS_3_OF_3',
    recordedState: 'TESTED_NOT_ADMITTED',
    historicalOnly: true,
    selectorState: 'HIDDEN_HELD',
    nextPredicate: 'CURRENT_ROUTE_ADMISSION_AND_DEPLOYED_SERVER_MANAGER_BINDING_REQUIRED',
  },
  {
    sourceRouteId: 'deepseek.v4.flash.vision.uncensored.safetensors.local',
    variantId: 'deepseek_v4_flash_vision_uncensored_safetensors',
    repository: 'orcarouter/DeepSeek-V4-Flash-Vision-Uncensored',
    revision: '2ef3d5c2bb7d9ccba6ab66314ed9e63bd52ac2a6',
    manifestDigest: 'sha256:14637601f9a8631cf470103a9753c9a1e8c252cf575eb5b3c78c33b7cdf88f6b',
    modelRowDigest: 'sha256:84d1787cd1b44b3cdb12b9e94562a0c5d95f642a0efe914206ca574d0ad9da2a',
    runtimeEngine: 'LLAMA_CPP_CUDA_SM89',
    r5300Compatible: true,
    supportsVision: true,
    toolCallEvidence: 'PASS_3_OF_3',
    recordedState: 'TESTED_NOT_ADMITTED',
    historicalOnly: true,
    selectorState: 'HIDDEN_HELD',
    nextPredicate: 'CURRENT_ROUTE_ADMISSION_AND_DEPLOYED_SERVER_MANAGER_BINDING_REQUIRED',
  },
] as const).map(item => Object.freeze({
  ...item,
  handoffDigest: AI_STUDIOTECH_SIX_VARIANT_HANDOFF_DIGEST,
  validationDigest: AI_STUDIOTECH_SIX_VARIANT_VALIDATION_DIGEST,
  routeAdmission: false as const,
  productionGreen: false as const,
})))

export const GLM53_TERMINAL_OBSERVATIONS = Object.freeze(LOCAL_MODEL_TERMINAL_OBSERVATIONS.slice(0, 4))
export const DEEPSEEK_V4_TERMINAL_OBSERVATIONS = Object.freeze(LOCAL_MODEL_TERMINAL_OBSERVATIONS.slice(4))

function route(
  id: string,
  kind: RouteKind,
  displayName: string,
  predicate: string,
  terminalObservation?: TerminalModelObservation,
): SourceOnlyRouteDescriptor {
  return Object.freeze({
    id,
    kind,
    displayName,
    frontDoor: GIANOS_FRONT_DOOR,
    authorities: CANONICAL_AUTHORITIES,
    currentness: 'UNVERIFIED',
    capability: 'UNVERIFIED',
    selection: Object.freeze({ state: 'BLOCKED', predicate }),
    ...terminalObservation === undefined ? {} : { terminalObservation: Object.freeze({ ...terminalObservation }) },
    sourceOnly: true,
  })
}

function displayName(id: string): string {
  return id.length === 0 ? id : `${id.charAt(0).toUpperCase()}${id.slice(1)}`
}

/** Exactly the 13 scoped Giana Girls, with no Princess OS/Lara entry. */
export function gianaGirlRoutes(): readonly SourceOnlyRouteDescriptor[] {
  return GIANA_GIRLS.map(id => route(`giana.${id}`, 'giana-girl', displayName(id), COMMON_SELECTION_PREDICATE))
}

/** The governed local-model candidate remains held until exact evidence exists. */
export function qwenRoute(): SourceOnlyRouteDescriptor {
  return route(
    'model.qwen-3.8-27b',
    'governed-model',
    'Qwen 3.8-27B',
    QWEN_SELECTION_PREDICATE,
    QWEN_TERMINAL_OBSERVATION,
  )
}

const LOCAL_MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'glm53.flash.official.fp8.local': 'GLM 5.3 Flash Official FP8',
  'glm53.flash.orcasaq.mlx.mixed456.local': 'GLM 5.3 Flash OrcaSAQ MLX Mixed 4/5/6-bit',
  'glm53.flash.orcarouter.uncensored.fp8.local': 'GLM 5.3 Flash OrcaRouter Uncensored FP8',
  'glm53.flash.orcarouter.uncensored.gguf.q6_k.local': 'GLM 5.3 Flash OrcaRouter Uncensored GGUF Q6_K',
  'deepseek.v4.flash.vision.regular.ud_q8_k_xl.local': 'DeepSeek V4 Flash Vision Exp UD-Q8_K_XL',
  'deepseek.v4.flash.vision.uncensored.safetensors.local': 'DeepSeek V4 Flash Vision Uncensored',
})

function evidenceRoutes(
  observations: readonly LocalModelEvidenceObservation[],
): readonly SourceOnlyRouteDescriptor[] {
  return observations.map(observation => route(
    `model.${observation.sourceRouteId}`,
    'governed-model',
    LOCAL_MODEL_DISPLAY_NAMES[observation.sourceRouteId] ?? observation.sourceRouteId,
    observation.nextPredicate,
    observation,
  ))
}

/** Four GLM 5.3 evidence records; presence never implies readiness or admission. */
export function glm53Routes(): readonly SourceOnlyRouteDescriptor[] {
  return evidenceRoutes(GLM53_TERMINAL_OBSERVATIONS)
}

/** Two DeepSeek V4 evidence records; presence never implies readiness or admission. */
export function deepseekV4Routes(): readonly SourceOnlyRouteDescriptor[] {
  return evidenceRoutes(DEEPSEEK_V4_TERMINAL_OBSERVATIONS)
}

/** The exact six-model upstream packet, retained as held source-only records. */
export function localModelEvidenceRoutes(): readonly SourceOnlyRouteDescriptor[] {
  return evidenceRoutes(LOCAL_MODEL_TERMINAL_OBSERVATIONS)
}

/** The complete source-only selector catalog for Giana CoWork Preview. */
export function sourceOnlyCatalog(): readonly SourceOnlyRouteDescriptor[] {
  return Object.freeze([...gianaGirlRoutes(), qwenRoute(), ...localModelEvidenceRoutes()])
}

export function isSelectable(
  descriptor: SourceOnlyRouteDescriptor,
  evidence: SelectionEvidence | undefined,
): evidence is VerifiedSelectionEvidence {
  const runtimeEvidence: {
    sourceOnly: boolean
    frontDoor: string
    currentness: string
    capability: string
  } | undefined = evidence
  return evidence !== undefined
    && verifiedSelectionEvidence.get(evidence) === descriptor
    && runtimeEvidence?.sourceOnly === false
    && evidence.routeId === descriptor.id
    && runtimeEvidence.frontDoor === GIANOS_FRONT_DOOR
    && runtimeEvidence.currentness === 'CURRENT'
    && runtimeEvidence.capability === 'READY'
    && SHA256_DIGEST.test(evidence.identityDigest)
    && SHA256_DIGEST.test(evidence.currentnessDigest)
    && SHA256_DIGEST.test(evidence.capabilityDigest)
}

function hasValidSelectionEvidenceShape(
  descriptor: SourceOnlyRouteDescriptor,
  evidence: SelectionEvidence,
): boolean {
  const runtimeEvidence: {
    sourceOnly: boolean
    frontDoor: string
    currentness: string
    capability: string
  } = evidence
  return !runtimeEvidence.sourceOnly
    && evidence.routeId === descriptor.id
    && runtimeEvidence.frontDoor === GIANOS_FRONT_DOOR
    && runtimeEvidence.currentness === 'CURRENT'
    && runtimeEvidence.capability === 'READY'
    && SHA256_DIGEST.test(evidence.identityDigest)
    && SHA256_DIGEST.test(evidence.currentnessDigest)
    && SHA256_DIGEST.test(evidence.capabilityDigest)
}

/**
 * Ask the canonical adapter to verify a detached evidence value, then mint the
 * in-process capability required by materializeSelection(). Plain objects,
 * including structurally complete ones, remain held.
 */
export async function verifySelectionEvidence(
  descriptor: SourceOnlyRouteDescriptor,
  evidence: SelectionEvidence,
  authority: SelectionEvidenceAuthority,
): Promise<VerifiedSelectionEvidence> {
  if (!hasValidSelectionEvidenceShape(descriptor, evidence)) {
    throw new Error(`Route ${descriptor.id} is held: ${descriptor.selection.predicate}`)
  }
  const detached = Object.freeze({ ...evidence })
  let verified = false
  try {
    verified = await authority.verifySelectionEvidence(descriptor, detached)
  } catch {
    throw new Error(`Route ${descriptor.id} is held: ${descriptor.selection.predicate}`)
  }
  if (!verified) throw new Error(`Route ${descriptor.id} is held: ${descriptor.selection.predicate}`)
  verifiedSelectionEvidence.set(detached, descriptor)
  return detached as VerifiedSelectionEvidence
}

/**
 * Convert a source-only descriptor to a selectable route only with evidence
 * from the canonical front door. No caller can bypass the typed predicate by
 * toggling a UI flag or selecting an upstream provider directly.
 */
export function materializeSelection(
  descriptor: SourceOnlyRouteDescriptor,
  evidence: SelectionEvidence,
): SelectableRoute {
  if (!isSelectable(descriptor, evidence)) {
    throw new Error(`Route ${descriptor.id} is held: ${descriptor.selection.predicate}`)
  }
  return Object.freeze({
    route: descriptor,
    selection: Object.freeze({ state: 'ALLOWED', evidence }),
  })
}

/** Runtime-independent invariant used by source-only tests and future consumers. */
export function assertSourceOnlyCatalog(catalog: readonly SourceOnlyRouteDescriptor[]): void {
  const girls = catalog.filter(item => item.kind === 'giana-girl')
  if (girls.length !== GIANA_GIRLS.length) throw new Error('Expected exactly 13 Giana Girl routes')
  if (new Set(girls.map(item => item.id)).size !== girls.length) throw new Error('Giana Girl route ids must be unique')
  if (catalog.some(item => item.id === 'princess.lara' || item.displayName.toLowerCase() === 'lara')) {
    throw new Error('Princess OS/Lara must remain outside the GianaOS catalog')
  }
  if (catalog.some((item) => {
    const runtimeItem: { frontDoor: string; sourceOnly: boolean } = item
    return runtimeItem.frontDoor !== GIANOS_FRONT_DOOR || !runtimeItem.sourceOnly
  })) {
    throw new Error('Every route must be source-only and use the canonical front door')
  }
  if (catalog.filter(item => item.id === qwenRoute().id).length !== 1) {
    throw new Error('The governed Qwen 3.8-27B route must appear exactly once')
  }
  if (LOCAL_MODEL_ROUTE_IDS.some(id => catalog.filter(item => item.id === id).length !== 1)) {
    throw new Error('Each governed six-model evidence route must appear exactly once')
  }
  const localModels = catalog.filter(item => LOCAL_MODEL_ROUTE_IDS.includes(item.id as typeof LOCAL_MODEL_ROUTE_IDS[number]))
  if (localModels.length !== 6) throw new Error('Expected exactly six governed local-model evidence routes')
  if (localModels.some(item => item.terminalObservation?.handoffDigest !== AI_STUDIOTECH_SIX_VARIANT_HANDOFF_DIGEST)) {
    throw new Error('Every six-model route must bind the current upstream handoff')
  }
  if (localModels.some(item => item.terminalObservation?.validationDigest !== AI_STUDIOTECH_SIX_VARIANT_VALIDATION_DIGEST)) {
    throw new Error('Every six-model route must bind the independent current validation')
  }
  for (const item of catalog) {
    const runtimeSelection: { state: string } = item.selection
    if (runtimeSelection.state !== 'BLOCKED') throw new Error(`Route ${item.id} must be blocked in source-only mode`)
  }
}

export const SOURCE_ONLY_CONTRACT = Object.freeze({
  schema: 'gianaos.deepseek-harness-front-door.v1',
  state: SOURCE_ONLY_STATE,
  frontDoor: GIANOS_FRONT_DOOR,
  gianaGirlCount: GIANA_GIRLS.length,
  princessOsExternal: true,
  duplicateAuthorities: false,
  qwenRoute: qwenRoute().id,
  glm53Routes: GLM53_ROUTE_IDS,
  deepseekV4Routes: DEEPSEEK_V4_ROUTE_IDS,
  localModelRoutes: LOCAL_MODEL_ROUTE_IDS,
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

export * from './front-door-adapter.ts'
