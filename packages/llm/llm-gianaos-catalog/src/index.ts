/**
 * Source-only canonical front-door descriptors for the DeepSeek Harness lane.
 *
 * This package deliberately has no Cordis registration and no provider call.
 * It describes the only route shape that a future Harness UI integration may
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

export const GLM53_ROUTE_IDS = [
  'model.glm53.flash.official.fp8.local',
  'model.glm53.flash.orcasaq.mlx.mixed456.local',
  'model.glm53.flash.orcarouter.uncensored.fp8.local',
  'model.glm53.flash.orcarouter.uncensored.gguf.q6_k.local',
] as const

export const QWEN_TERMINAL_OBSERVATION: TerminalModelObservation = Object.freeze({
  sourceRouteId: 'Qwen/Qwen3.8-27B',
  recordedState: 'RESTORED_RUNNING_HEALTHY',
  historicalOnly: true,
  selectorState: 'EXISTING_ROUTE_PRESERVED',
  handoffDigest: AI_STUDIOTECH_GLM53_R3_HANDOFF_DIGEST,
  validationDigest: AI_STUDIOTECH_GLM53_R3_VALIDATION_DIGEST,
})

export const GLM53_TERMINAL_OBSERVATIONS = Object.freeze(([
  {
    sourceRouteId: 'glm53.flash.official.fp8.local',
    recordedState: 'TECHNICALLY_VALIDATED_LOOPBACK_CANARY_STOPPED_NOT_REGISTERED',
    historicalOnly: true,
    selectorState: 'HIDDEN_HELD',
    nextPredicate: 'NEWTECH_APP_INTEGRATION_AND_SEPARATE_GIANA_CODE_PUTRI_ROUTE_ADMISSION',
  },
  {
    sourceRouteId: 'glm53.flash.orcasaq.mlx.mixed456.local',
    recordedState: 'INSTALLED_HASH_VALIDATED_CPU_LOAD_AND_STREAM_TESTED_GPU_INTERACTIVE_HELD',
    historicalOnly: true,
    selectorState: 'VISIBLE_DISABLED',
    nextPredicate: 'SOURCE_BACKED_SHARD_OR_CPU_GPU_OFFLOAD_RUNTIME_WITH_INTERACTIVE_THROUGHPUT_PROOF',
  },
  {
    sourceRouteId: 'glm53.flash.orcarouter.uncensored.fp8.local',
    recordedState: 'SOURCE_PINNED_HELD_GATED_ACCESS',
    historicalOnly: true,
    selectorState: 'HIDDEN_HELD',
    nextPredicate: 'APPROVED_NO_EXPORT_HUGGING_FACE_GATED_MODEL_ACCESS_BOUND_ON_R5300',
  },
  {
    sourceRouteId: 'glm53.flash.orcarouter.uncensored.gguf.q6_k.local',
    recordedState: 'SOURCE_PINNED_HELD_GATED_ACCESS_AND_RUNTIME_BUILD',
    historicalOnly: true,
    selectorState: 'HIDDEN_HELD',
    nextPredicate: 'GATED_PAYLOAD_AVAILABLE_AND_PINNED_GLM5NEXT_LLAMA_CPP_BUILD_VALIDATED',
  },
] as const).map(item => Object.freeze({
  ...item,
  handoffDigest: AI_STUDIOTECH_GLM53_R3_HANDOFF_DIGEST,
  validationDigest: AI_STUDIOTECH_GLM53_R3_VALIDATION_DIGEST,
})))

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

/** Four separately admitted GLM 5.3 routes; presence never implies readiness. */
export function glm53Routes(): readonly SourceOnlyRouteDescriptor[] {
  const names: Record<typeof GLM53_TERMINAL_OBSERVATIONS[number]['sourceRouteId'], string> = {
    'glm53.flash.official.fp8.local': 'GLM 5.3 Flash Official FP8',
    'glm53.flash.orcasaq.mlx.mixed456.local': 'GLM 5.3 Flash OrcaSAQ MLX Mixed 4/5/6-bit',
    'glm53.flash.orcarouter.uncensored.fp8.local': 'GLM 5.3 Flash OrcaRouter Uncensored FP8',
    'glm53.flash.orcarouter.uncensored.gguf.q6_k.local': 'GLM 5.3 Flash OrcaRouter Uncensored GGUF Q6_K',
  }
  return GLM53_TERMINAL_OBSERVATIONS.map(observation => route(
    `model.${observation.sourceRouteId}`,
    'governed-model',
    names[observation.sourceRouteId],
    observation.nextPredicate,
    observation,
  ))
}

/** The complete source-only selector catalog for the standalone Harness lane. */
export function sourceOnlyCatalog(): readonly SourceOnlyRouteDescriptor[] {
  return Object.freeze([...gianaGirlRoutes(), qwenRoute(), ...glm53Routes()])
}

export function isSelectable(
  descriptor: SourceOnlyRouteDescriptor,
  evidence: SelectionEvidence | undefined,
): evidence is VerifiedSelectionEvidence {
  return evidence !== undefined
    && verifiedSelectionEvidence.get(evidence) === descriptor
    && evidence.sourceOnly === false
    && evidence.routeId === descriptor.id
    && evidence.frontDoor === GIANOS_FRONT_DOOR
    && evidence.currentness === 'CURRENT'
    && evidence.capability === 'READY'
    && SHA256_DIGEST.test(evidence.identityDigest)
    && SHA256_DIGEST.test(evidence.currentnessDigest)
    && SHA256_DIGEST.test(evidence.capabilityDigest)
}

function hasValidSelectionEvidenceShape(
  descriptor: SourceOnlyRouteDescriptor,
  evidence: SelectionEvidence,
): boolean {
  return evidence.sourceOnly === false
    && evidence.routeId === descriptor.id
    && evidence.frontDoor === GIANOS_FRONT_DOOR
    && evidence.currentness === 'CURRENT'
    && evidence.capability === 'READY'
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
  if (catalog.some(item => item.frontDoor !== GIANOS_FRONT_DOOR || item.sourceOnly !== true)) {
    throw new Error('Every route must be source-only and use the canonical front door')
  }
  if (catalog.filter(item => item.id === qwenRoute().id).length !== 1) {
    throw new Error('The governed Qwen 3.8-27B route must appear exactly once')
  }
  if (GLM53_ROUTE_IDS.some(id => catalog.filter(item => item.id === id).length !== 1)) {
    throw new Error('Each governed GLM 5.3 route must appear exactly once')
  }
  for (const item of catalog) {
    if (item.selection.state !== 'BLOCKED') throw new Error(`Route ${item.id} must be blocked in source-only mode`)
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
  terminalHandoffDigest: AI_STUDIOTECH_GLM53_R3_HANDOFF_DIGEST,
  terminalValidationDigest: AI_STUDIOTECH_GLM53_R3_VALIDATION_DIGEST,
  liveActivation: false,
})

export * from './front-door-adapter.ts'
