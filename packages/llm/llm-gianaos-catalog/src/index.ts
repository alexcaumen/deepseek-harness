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

export interface SelectableRoute {
  readonly route: SourceOnlyRouteDescriptor
  readonly selection: {
    readonly state: 'ALLOWED'
    readonly evidence: SelectionEvidence
  }
}

const COMMON_SELECTION_PREDICATE = 'GIANOS_GDM_R5300_CURRENTNESS_AND_CAPABILITY_PROOF_REQUIRED'
const QWEN_SELECTION_PREDICATE = 'QWEN_3_8_27B_EXACT_AI_STUDIO_EVIDENCE_REQUIRED'

function route(
  id: string,
  kind: RouteKind,
  displayName: string,
  predicate: string,
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
  return route('model.qwen-3.8-27b', 'governed-model', 'Qwen 3.8-27B', QWEN_SELECTION_PREDICATE)
}

/** The complete source-only selector catalog for the standalone Harness lane. */
export function sourceOnlyCatalog(): readonly SourceOnlyRouteDescriptor[] {
  return Object.freeze([...gianaGirlRoutes(), qwenRoute()])
}

export function isSelectable(
  descriptor: SourceOnlyRouteDescriptor,
  evidence: SelectionEvidence | undefined,
): evidence is SelectionEvidence {
  return evidence !== undefined
    && evidence.sourceOnly === false
    && evidence.routeId === descriptor.id
    && evidence.frontDoor === GIANOS_FRONT_DOOR
    && evidence.currentness === 'CURRENT'
    && evidence.capability === 'READY'
    && evidence.identityDigest.length > 0
    && evidence.currentnessDigest.length > 0
    && evidence.capabilityDigest.length > 0
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
  liveActivation: false,
})

export * from './front-door-adapter.ts'
