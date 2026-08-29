import { CANONICAL_AUTHORITIES, GIANA_GIRLS, GIANOS_FRONT_DOOR, type GianaGirlId } from './index.ts'

const SHA256 = /^[0-9a-f]{64}$/i
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

export const PUTRI_PRINCIPAL = 'giana.putri' as const
export const CANONICAL_PUTRI_TELEPHONE_SURFACE = 'CANONICAL_PUTRI_TELEPHONE_SURFACE' as const
export const PRDG_WORKSPACE_TOOL_BRIDGE = 'PRDG_WORKSPACE_TOOL_BRIDGE' as const
export const CANONICAL_MEMORY_CAPTURE_REQUIRED = 'CANONICAL_MEMORY_CAPTURE_REQUIRED' as const
export const MEMORY_PARITY_RECONCILIATION_REQUIRED = 'MEMORY_PARITY_RECONCILIATION_REQUIRED' as const
export const SOURCE_ONLY_ADAPTER_STATE = 'SOURCE_ONLY_CANDIDATE' as const

export type CodingTool = 'read' | 'edit' | 'test' | 'build'
export type ForbiddenShadowResourceClass =
  | 'credential-export'
  | 'direct-database'
  | 'shadow-memory'
  | 'shadow-profile'
  | 'provider-bypass'
  | 'shadow-session'
  | 'live-effect'

export interface FrontDoorCurrentnessEvidence {
  readonly routeId: `giana.${GianaGirlId}`
  readonly principalId: `giana.${GianaGirlId}`
  readonly profileIdentitySha256: string
  readonly hostIdentitySha256: string
  readonly gdmAdmissionSha256: string
  readonly policyScopeSha256: string
  readonly routeCurrentnessSha256: string
  readonly capabilitySha256: string
  readonly observedAt: string
  readonly expiresAt: string
  readonly currentness: 'CURRENT' | 'STALE' | 'HELD'
  readonly capability: 'READY' | 'PARTIAL' | 'HELD'
}

export interface CanonicalGirlProjection {
  readonly girlId: GianaGirlId
  readonly routeId: `giana.${GianaGirlId}`
  readonly displayName: string
  readonly principalId: `giana.${GianaGirlId}`
  readonly profileIdentitySha256: string
  readonly hostIdentitySha256: string
  readonly routeCurrentnessSha256: string
  readonly capabilitySha256: string
  readonly selection: 'READY'
  readonly authority: typeof GIANOS_FRONT_DOOR
}

export interface TranscriptProjectionInput {
  readonly routeId: `giana.${GianaGirlId}`
  readonly principalId: `giana.${GianaGirlId}`
  readonly sessionRefSha256: string
  readonly sequence: number
  readonly transcriptSha256: string
  readonly cancelGeneration: number
  readonly supersessionGeneration: number
}

export interface TranscriptProjection extends TranscriptProjectionInput {
  readonly state: 'READ_ONLY_PROJECTION'
  readonly authority: typeof GIANOS_FRONT_DOOR
}

export interface ObjectiveFence {
  readonly workId: string
  readonly generation: number
  readonly objectiveRevision: number
  readonly ownerPrincipal: typeof PUTRI_PRINCIPAL
  readonly sourceWatermark: string
  readonly conversationWatermark: string
  readonly cancelGeneration: number
  readonly supersessionGeneration: number
  readonly authorizationEpoch: number
  readonly currentnessSha256: string
  readonly state: 'ACTIVE' | 'CANCELLED' | 'SUPERSEDED' | 'HELD'
}

/**
 * One turn owned by the already-active canonical Putri runtime. The Harness
 * projects this turn; it never creates a Putri identity, session, profile,
 * memory namespace, or database of its own.
 */
export interface CanonicalPutriTurn {
  readonly turnId: string
  readonly workId: string
  readonly generation: number
  readonly objectiveRevision: number
  readonly turnSequence: number
  readonly principalId: typeof PUTRI_PRINCIPAL
  readonly profileIdentitySha256: string
  readonly hostIdentitySha256: string
  readonly ownerPrivateNamespaceSha256: string
  readonly surfaceId: 'deepseek-harness'
  readonly surfaceKind: typeof CANONICAL_PUTRI_TELEPHONE_SURFACE
  readonly surfacePrivacyScopeSha256: string
  readonly canonicalSessionRefSha256: string
  readonly canonicalConversationRefSha256: string
  readonly canonicalMemoryNamespaceSha256: string
  readonly canonicalMemoryWriterRouteSha256: string
  readonly memoryParityPolicySha256: string
  readonly memoryParityCursorSha256: string
  readonly sourceWatermark: string
  readonly conversationWatermark: string
  readonly cancelGeneration: number
  readonly supersessionGeneration: number
  readonly authorizationEpoch: number
  readonly inputSha256: string
  readonly sessionAuthority: typeof GIANOS_FRONT_DOOR
  readonly memoryAuthority: typeof CANONICAL_AUTHORITIES.memory
}

export interface WorkspaceToolCall {
  readonly toolCallId: string
  readonly turn: CanonicalPutriTurn
  readonly workspacePath: string
  readonly workspaceIdentitySha256: string
  readonly requestedTools: readonly CodingTool[]
  readonly requestedShadowResources: readonly ForbiddenShadowResourceClass[]
  readonly toolInputSha256: string
  readonly resultSchemaRef: string
  readonly toolCallSha256: string
  readonly bridge: typeof PRDG_WORKSPACE_TOOL_BRIDGE
}

export interface PreparedWorkspaceToolCall extends WorkspaceToolCall {
  readonly adapterState: typeof SOURCE_ONLY_ADAPTER_STATE
  readonly role: typeof CANONICAL_PUTRI_TELEPHONE_SURFACE
  readonly executionAuthorized: false
  readonly providerCallAuthorized: false
  readonly liveEffectAuthorized: false
  readonly shadowSessionAuthorized: false
  readonly shadowDatabaseAuthorized: false
  readonly principalPreserved: true
  readonly canonicalSessionPreserved: true
  readonly moaAuthorityRetainedByPutri: true
  readonly rawCrossSurfaceTranscriptMergeAuthorized: false
}

export interface WorkspaceToolResult {
  readonly evidenceId: string
  readonly toolCallId: string
  readonly turnId: string
  readonly workId: string
  readonly generation: number
  readonly objectiveRevision: number
  readonly turnSequence: number
  readonly principalId: typeof PUTRI_PRINCIPAL
  readonly surfaceId: 'deepseek-harness'
  readonly surfacePrivacyScopeSha256: string
  readonly canonicalSessionRefSha256: string
  readonly canonicalMemoryNamespaceSha256: string
  readonly memoryParityCursorSha256: string
  readonly sourceWatermark: string
  readonly conversationWatermark: string
  readonly cancelGeneration: number
  readonly supersessionGeneration: number
  readonly authorizationEpoch: number
  readonly toolCallSha256: string
  readonly resultSha256: string
  readonly resultSchemaRef: string
  readonly effectCount: 0
  readonly providerCallCount: 0
}

export interface ToolResultLedgerEntry {
  readonly evidenceId: string
  readonly toolCallId: string
  readonly resultSha256: string
  readonly canonicalSessionRefSha256: string
  readonly canonicalMemoryNamespaceSha256: string
  readonly state: 'RETURN_TO_CANONICAL_PUTRI_TURN'
  readonly knowledgeCapture: typeof CANONICAL_MEMORY_CAPTURE_REQUIRED
  readonly parityReconciliation: typeof MEMORY_PARITY_RECONCILIATION_REQUIRED
}

/**
 * Structured knowledge distilled by canonical Putri after she observes the
 * tool result. The full trace remains in her canonical session. This proposal
 * may be persisted only by GianaOS' canonical memory writer.
 */
export interface CanonicalKnowledgeProposal {
  readonly knowledgeId: string
  readonly principalId: typeof PUTRI_PRINCIPAL
  readonly turnId: string
  readonly toolCallId: string
  readonly canonicalSessionRefSha256: string
  readonly canonicalMemoryNamespaceSha256: string
  readonly canonicalMemoryWriterRouteSha256: string
  readonly surfaceId: 'deepseek-harness'
  readonly surfacePrivacyScopeSha256: string
  readonly memoryParityPolicySha256: string
  readonly memoryParityCursorSha256: string
  readonly turnSequence: number
  readonly resultSha256: string
  readonly problemSha256: string
  readonly decisionSha256: string
  readonly solutionSha256: string
  readonly artifactLedgerSha256: string
  readonly evidenceSha256: string
  readonly privacyClass: 'OWNER_PRIVATE_CANONICAL'
  readonly writeMode: 'PROPOSE_TO_CANONICAL_MEMORY_WRITER'
}

export interface PreparedKnowledgeCapture extends CanonicalKnowledgeProposal {
  readonly state: 'CANONICAL_MEMORY_WRITE_PROPOSAL'
  readonly memoryAuthority: typeof CANONICAL_AUTHORITIES.memory
  readonly writeAuthorized: false
  readonly shadowMemoryAuthorized: false
  readonly rawTranscriptMergeAuthorized: false
}

export interface SourceOnlyAdapterConfig {
  readonly allowedWorkspaceRoot: string
  readonly expectedPutriProfileIdentitySha256: string
  readonly expectedPutriHostIdentitySha256: string
  readonly expectedOwnerPrivateNamespaceSha256: string
  readonly expectedCanonicalMemoryWriterRouteSha256: string
  readonly allowedTools: ReadonlySet<CodingTool>
}

function held(reason: string): never {
  throw new Error(`HELD_GIANA_FRONT_DOOR:${reason}`)
}

function requireDigest(value: string, field: string): void {
  if (!SHA256.test(value)) held(`${field.toUpperCase()}_SHA256_REQUIRED`)
}

function requirePositive(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) held(`${field.toUpperCase()}_POSITIVE_REQUIRED`)
}

function requireNonNegative(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) held(`${field.toUpperCase()}_NONNEGATIVE_REQUIRED`)
}

function requireUtc(value: string, field: string): number {
  if (!ISO_UTC.test(value)) held(`${field.toUpperCase()}_UTC_REQUIRED`)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) held(`${field.toUpperCase()}_UTC_REQUIRED`)
  return parsed
}

function normalizeWindowsPath(value: string): string {
  const slash = value.trim().replace(/\//g, '\\').replace(/\\+/g, '\\')
  if (!/^[A-Za-z]:\\/.test(slash)) held('ABSOLUTE_WINDOWS_WORKSPACE_REQUIRED')
  const drive = slash.slice(0, 2).toUpperCase()
  const parts = slash.slice(3).split('\\')
  if (parts.some(part => part === '' || part === '.' || part === '..')) held('WORKSPACE_PATH_ESCAPE')
  return `${drive}\\${parts.join('\\')}`
}

function isAtOrBelow(path: string, root: string): boolean {
  const candidate = normalizeWindowsPath(path).toLowerCase()
  const allowed = normalizeWindowsPath(root).replace(/\\$/, '').toLowerCase()
  return candidate === allowed || candidate.startsWith(`${allowed}\\`)
}

function assertCurrentEvidence(
  evidence: FrontDoorCurrentnessEvidence,
  expectedRouteId: string,
  now: string,
): void {
  if (evidence.routeId !== expectedRouteId || evidence.principalId !== expectedRouteId) {
    held('ROUTE_OR_PRINCIPAL_MISMATCH')
  }
  for (const [field, value] of Object.entries({
    profileIdentity: evidence.profileIdentitySha256,
    hostIdentity: evidence.hostIdentitySha256,
    gdmAdmission: evidence.gdmAdmissionSha256,
    policyScope: evidence.policyScopeSha256,
    routeCurrentness: evidence.routeCurrentnessSha256,
    capability: evidence.capabilitySha256,
  })) requireDigest(value, field)
  const observedAt = requireUtc(evidence.observedAt, 'observedAt')
  const expiresAt = requireUtc(evidence.expiresAt, 'expiresAt')
  const nowAt = requireUtc(now, 'now')
  if (observedAt > nowAt || expiresAt <= nowAt) held('CURRENTNESS_EXPIRED_OR_FUTURE')
  if (evidence.currentness !== 'CURRENT') held('ROUTE_NOT_CURRENT')
  if (evidence.capability !== 'READY') held('CAPABILITY_NOT_READY')
}

function assertExact13(evidence: readonly FrontDoorCurrentnessEvidence[]): void {
  if (evidence.length !== GIANA_GIRLS.length) held('EXACT_13_GIRLS_REQUIRED')
  const expected = new Set(GIANA_GIRLS.map(id => `giana.${id}`))
  const actual = new Set(evidence.map(item => item.routeId))
  if (actual.size !== evidence.length) held('DUPLICATE_GIRL_ROUTE')
  if (actual.size !== expected.size || [...expected].some(id => !actual.has(id as `giana.${GianaGirlId}`))) {
    held('MISSING_OR_UNKNOWN_GIRL_ROUTE')
  }
}

function assertObjective(turn: CanonicalPutriTurn, objective: ObjectiveFence): void {
  if (turn.workId !== objective.workId
    || turn.generation !== objective.generation
    || turn.objectiveRevision !== objective.objectiveRevision
    || turn.sourceWatermark !== objective.sourceWatermark
    || turn.conversationWatermark !== objective.conversationWatermark
    || turn.cancelGeneration !== objective.cancelGeneration
    || turn.supersessionGeneration !== objective.supersessionGeneration
    || turn.authorizationEpoch !== objective.authorizationEpoch) {
    held('OBJECTIVE_CURRENTNESS_MISMATCH')
  }
  if (objective.state !== 'ACTIVE') held('OBJECTIVE_NOT_ACTIVE')
}

/**
 * Pure, source-only adapter. It validates the canonical Putri turn and a
 * bounded PRDG workspace tool surface. It never opens or copies a profile,
 * database, session, memory store, provider, model, network route, or live
 * effect.
 */
export class ReadOnlyGianaFrontDoorAdapter {
  readonly state = SOURCE_ONLY_ADAPTER_STATE
  private readonly root: string
  private readonly acceptedByToolCall = new Map<string, ToolResultLedgerEntry>()

  constructor(private readonly config: SourceOnlyAdapterConfig) {
    this.root = normalizeWindowsPath(config.allowedWorkspaceRoot)
    requireDigest(config.expectedPutriProfileIdentitySha256, 'expectedPutriProfileIdentity')
    requireDigest(config.expectedPutriHostIdentitySha256, 'expectedPutriHostIdentity')
    requireDigest(config.expectedOwnerPrivateNamespaceSha256, 'expectedOwnerPrivateNamespace')
    requireDigest(config.expectedCanonicalMemoryWriterRouteSha256, 'expectedCanonicalMemoryWriterRoute')
    if (config.allowedTools.size === 0) held('ALLOWED_TOOL_SET_REQUIRED')
    for (const tool of config.allowedTools) {
      if (!(['read', 'edit', 'test', 'build'] as const).includes(tool)) held('UNKNOWN_TOOL_CLASS')
    }
  }

  projectGirls(evidence: readonly FrontDoorCurrentnessEvidence[], now: string): readonly CanonicalGirlProjection[] {
    assertExact13(evidence)
    return Object.freeze(GIANA_GIRLS.map((girlId) => {
      const routeId = `giana.${girlId}` as const
      const item = evidence.find(candidate => candidate.routeId === routeId)
      if (!item) held('MISSING_GIRL_ROUTE')
      assertCurrentEvidence(item, routeId, now)
      return Object.freeze({
        girlId,
        routeId,
        displayName: `${girlId.charAt(0).toUpperCase()}${girlId.slice(1)}`,
        principalId: item.principalId,
        profileIdentitySha256: item.profileIdentitySha256,
        hostIdentitySha256: item.hostIdentitySha256,
        routeCurrentnessSha256: item.routeCurrentnessSha256,
        capabilitySha256: item.capabilitySha256,
        selection: 'READY' as const,
        authority: GIANOS_FRONT_DOOR,
      })
    }))
  }

  projectTranscript(input: TranscriptProjectionInput): TranscriptProjection {
    if (input.routeId !== input.principalId) held('TRANSCRIPT_PRINCIPAL_MISMATCH')
    if (!GIANA_GIRLS.some(id => input.routeId === `giana.${id}`)) held('TRANSCRIPT_ROUTE_UNKNOWN')
    requireDigest(input.sessionRefSha256, 'sessionRef')
    requireDigest(input.transcriptSha256, 'transcript')
    requireNonNegative(input.sequence, 'sequence')
    requireNonNegative(input.cancelGeneration, 'cancelGeneration')
    requireNonNegative(input.supersessionGeneration, 'supersessionGeneration')
    return Object.freeze({ ...input, state: 'READ_ONLY_PROJECTION' as const, authority: GIANOS_FRONT_DOOR })
  }

  preparePutriWorkspaceToolCall(
    request: WorkspaceToolCall,
    objective: ObjectiveFence,
    evidence: FrontDoorCurrentnessEvidence,
    now: string,
  ): PreparedWorkspaceToolCall {
    const turn = request.turn
    assertCurrentEvidence(evidence, PUTRI_PRINCIPAL, now)
    if (turn.principalId !== PUTRI_PRINCIPAL || objective.ownerPrincipal !== PUTRI_PRINCIPAL) {
      held('PUTRI_CANONICAL_PRINCIPAL_REQUIRED')
    }
    if (turn.sessionAuthority !== GIANOS_FRONT_DOOR || turn.memoryAuthority !== CANONICAL_AUTHORITIES.memory) {
      held('CANONICAL_SESSION_OR_MEMORY_AUTHORITY_REQUIRED')
    }
    if (turn.profileIdentitySha256 !== this.config.expectedPutriProfileIdentitySha256
      || evidence.profileIdentitySha256 !== this.config.expectedPutriProfileIdentitySha256) {
      held('PUTRI_PROFILE_IDENTITY_MISMATCH')
    }
    if (turn.hostIdentitySha256 !== this.config.expectedPutriHostIdentitySha256
      || evidence.hostIdentitySha256 !== this.config.expectedPutriHostIdentitySha256) {
      held('PUTRI_HOST_IDENTITY_MISMATCH')
    }
    if (turn.ownerPrivateNamespaceSha256 !== this.config.expectedOwnerPrivateNamespaceSha256) {
      held('OWNER_PRIVATE_NAMESPACE_MISMATCH')
    }
    if (turn.canonicalMemoryWriterRouteSha256 !== this.config.expectedCanonicalMemoryWriterRouteSha256) {
      held('CANONICAL_MEMORY_WRITER_ROUTE_MISMATCH')
    }
    for (const [field, value] of Object.entries({
      canonicalSessionRef: turn.canonicalSessionRefSha256,
      canonicalConversationRef: turn.canonicalConversationRefSha256,
      canonicalMemoryNamespace: turn.canonicalMemoryNamespaceSha256,
      canonicalMemoryWriterRoute: turn.canonicalMemoryWriterRouteSha256,
      surfacePrivacyScope: turn.surfacePrivacyScopeSha256,
      memoryParityPolicy: turn.memoryParityPolicySha256,
      memoryParityCursor: turn.memoryParityCursorSha256,
      ownerPrivateNamespace: turn.ownerPrivateNamespaceSha256,
      workspaceIdentity: request.workspaceIdentitySha256,
      turnInput: turn.inputSha256,
      toolInput: request.toolInputSha256,
      toolCall: request.toolCallSha256,
      objectiveCurrentness: objective.currentnessSha256,
    })) requireDigest(value, field)
    for (const field of ['generation', 'objectiveRevision', 'turnSequence'] as const) requirePositive(turn[field], field)
    for (const field of ['cancelGeneration', 'supersessionGeneration', 'authorizationEpoch'] as const) {
      requireNonNegative(turn[field], field)
    }
    assertObjective(turn, objective)
    if (turn.surfaceId !== 'deepseek-harness'
      || turn.surfaceKind !== CANONICAL_PUTRI_TELEPHONE_SURFACE) {
      held('DEEPSEEK_HARNESS_TELEPHONE_SURFACE_REQUIRED')
    }
    if (!isAtOrBelow(request.workspacePath, this.root)) held('WORKSPACE_PATH_NOT_ALLOWED')
    if (request.bridge !== PRDG_WORKSPACE_TOOL_BRIDGE) held('WORKSPACE_TOOL_BRIDGE_REQUIRED')
    if (request.requestedTools.length === 0 || request.requestedTools.some(tool => !this.config.allowedTools.has(tool))) {
      held('DISALLOWED_TOOL')
    }
    if (request.requestedShadowResources.length > 0) held('SHADOW_AUTHORITY_OR_SECRET_REQUEST')
    return Object.freeze({
      ...request,
      adapterState: SOURCE_ONLY_ADAPTER_STATE,
      role: CANONICAL_PUTRI_TELEPHONE_SURFACE,
      executionAuthorized: false as const,
      providerCallAuthorized: false as const,
      liveEffectAuthorized: false as const,
      shadowSessionAuthorized: false as const,
      shadowDatabaseAuthorized: false as const,
      principalPreserved: true as const,
      canonicalSessionPreserved: true as const,
      moaAuthorityRetainedByPutri: true as const,
      rawCrossSurfaceTranscriptMergeAuthorized: false as const,
    })
  }

  acceptWorkspaceToolResult(
    result: WorkspaceToolResult,
    call: PreparedWorkspaceToolCall,
    objective: ObjectiveFence,
  ): ToolResultLedgerEntry {
    requireDigest(result.resultSha256, 'result')
    if (result.effectCount !== 0 || result.providerCallCount !== 0) held('RESULT_CONTAINS_LIVE_EFFECT')
    const turn = call.turn
    if (result.toolCallId !== call.toolCallId
      || result.turnId !== turn.turnId
      || result.workId !== turn.workId
      || result.generation !== turn.generation
      || result.objectiveRevision !== turn.objectiveRevision
      || result.turnSequence !== turn.turnSequence
      || result.principalId !== turn.principalId
      || result.surfaceId !== turn.surfaceId
      || result.surfacePrivacyScopeSha256 !== turn.surfacePrivacyScopeSha256
      || result.canonicalSessionRefSha256 !== turn.canonicalSessionRefSha256
      || result.canonicalMemoryNamespaceSha256 !== turn.canonicalMemoryNamespaceSha256
      || result.memoryParityCursorSha256 !== turn.memoryParityCursorSha256
      || result.sourceWatermark !== turn.sourceWatermark
      || result.conversationWatermark !== turn.conversationWatermark
      || result.cancelGeneration !== turn.cancelGeneration
      || result.supersessionGeneration !== turn.supersessionGeneration
      || result.authorizationEpoch !== turn.authorizationEpoch
      || result.toolCallSha256 !== call.toolCallSha256
      || result.resultSchemaRef !== call.resultSchemaRef) {
      held('FORGED_OR_MISMATCHED_RESULT')
    }
    if (objective.state !== 'ACTIVE'
      || objective.cancelGeneration !== turn.cancelGeneration
      || objective.supersessionGeneration !== turn.supersessionGeneration
      || objective.objectiveRevision !== turn.objectiveRevision
      || !SHA256.test(objective.currentnessSha256)) {
      held('STALE_CANCELLED_OR_SUPERSEDED_RESULT')
    }
    const prior = this.acceptedByToolCall.get(result.toolCallId)
    if (prior) {
      if (prior.evidenceId === result.evidenceId && prior.resultSha256 === result.resultSha256) return prior
      held('REPLAY_OR_CONFLICTING_RESULT')
    }
    const entry = Object.freeze({
      evidenceId: result.evidenceId,
      toolCallId: result.toolCallId,
      resultSha256: result.resultSha256,
      canonicalSessionRefSha256: result.canonicalSessionRefSha256,
      canonicalMemoryNamespaceSha256: result.canonicalMemoryNamespaceSha256,
      state: 'RETURN_TO_CANONICAL_PUTRI_TURN' as const,
      knowledgeCapture: CANONICAL_MEMORY_CAPTURE_REQUIRED,
      parityReconciliation: MEMORY_PARITY_RECONCILIATION_REQUIRED,
    })
    this.acceptedByToolCall.set(result.toolCallId, entry)
    return entry
  }

  prepareCanonicalKnowledgeCapture(
    proposal: CanonicalKnowledgeProposal,
    result: WorkspaceToolResult,
    call: PreparedWorkspaceToolCall,
    objective: ObjectiveFence,
  ): PreparedKnowledgeCapture {
    const turn = call.turn
    if (proposal.principalId !== PUTRI_PRINCIPAL
      || proposal.turnId !== turn.turnId
      || proposal.toolCallId !== call.toolCallId
      || proposal.canonicalSessionRefSha256 !== turn.canonicalSessionRefSha256
      || proposal.canonicalMemoryNamespaceSha256 !== turn.canonicalMemoryNamespaceSha256
      || proposal.canonicalMemoryWriterRouteSha256 !== turn.canonicalMemoryWriterRouteSha256
      || proposal.surfaceId !== turn.surfaceId
      || proposal.surfacePrivacyScopeSha256 !== turn.surfacePrivacyScopeSha256
      || proposal.memoryParityPolicySha256 !== turn.memoryParityPolicySha256
      || proposal.memoryParityCursorSha256 !== turn.memoryParityCursorSha256
      || proposal.turnSequence !== turn.turnSequence
      || proposal.resultSha256 !== result.resultSha256) {
      held('KNOWLEDGE_PROPOSAL_NOT_BOUND_TO_CANONICAL_TURN')
    }
    if (proposal.privacyClass !== 'OWNER_PRIVATE_CANONICAL'
      || proposal.writeMode !== 'PROPOSE_TO_CANONICAL_MEMORY_WRITER') {
      held('CANONICAL_PRIVATE_MEMORY_WRITE_MODE_REQUIRED')
    }
    for (const [field, value] of Object.entries({
      canonicalSessionRef: proposal.canonicalSessionRefSha256,
      canonicalMemoryNamespace: proposal.canonicalMemoryNamespaceSha256,
      canonicalMemoryWriterRoute: proposal.canonicalMemoryWriterRouteSha256,
      surfacePrivacyScope: proposal.surfacePrivacyScopeSha256,
      memoryParityPolicy: proposal.memoryParityPolicySha256,
      memoryParityCursor: proposal.memoryParityCursorSha256,
      result: proposal.resultSha256,
      problem: proposal.problemSha256,
      decision: proposal.decisionSha256,
      solution: proposal.solutionSha256,
      artifactLedger: proposal.artifactLedgerSha256,
      evidence: proposal.evidenceSha256,
    })) requireDigest(value, field)
    assertObjective(turn, objective)
    return Object.freeze({
      ...proposal,
      state: 'CANONICAL_MEMORY_WRITE_PROPOSAL' as const,
      memoryAuthority: CANONICAL_AUTHORITIES.memory,
      writeAuthorized: false as const,
      shadowMemoryAuthorized: false as const,
      rawTranscriptMergeAuthorized: false as const,
    })
  }
}
