import { describe, expect, it } from 'vitest'
import {
  CANONICAL_AUTHORITIES,
  CANONICAL_MEMORY_CAPTURE_REQUIRED,
  CANONICAL_PUTRI_TELEPHONE_SURFACE,
  GIANA_GIRLS,
  GIANOS_FRONT_DOOR,
  MEMORY_PARITY_RECONCILIATION_REQUIRED,
  PRDG_WORKSPACE_TOOL_BRIDGE,
  PUTRI_PRINCIPAL,
  ReadOnlyGianaFrontDoorAdapter,
  type CanonicalKnowledgeProposal,
  type CanonicalPutriTurn,
  type FrontDoorCurrentnessEvidence,
  type ObjectiveFence,
  type WorkspaceToolCall,
  type WorkspaceToolResult,
} from '../src/index.ts'

const D = 'a'.repeat(64)
const E = 'b'.repeat(64)
const F = 'c'.repeat(64)
const NOW = '2026-08-17T12:00:00Z'

function evidence(id: typeof GIANA_GIRLS[number]): FrontDoorCurrentnessEvidence {
  return {
    routeId: `giana.${id}`,
    principalId: `giana.${id}`,
    profileIdentitySha256: id === 'putri' ? D : E,
    hostIdentitySha256: id === 'putri' ? E : F,
    gdmAdmissionSha256: D,
    policyScopeSha256: E,
    routeCurrentnessSha256: F,
    capabilitySha256: D,
    observedAt: '2026-08-17T11:59:00Z',
    expiresAt: '2026-08-17T12:05:00Z',
    currentness: 'CURRENT',
    capability: 'READY',
  }
}

const allEvidence = () => GIANA_GIRLS.map(evidence)

function adapter(): ReadOnlyGianaFrontDoorAdapter {
  return new ReadOnlyGianaFrontDoorAdapter({
    allowedWorkspaceRoot: 'F:\\DS-Harness',
    expectedPutriProfileIdentitySha256: D,
    expectedPutriHostIdentitySha256: E,
    expectedOwnerPrivateNamespaceSha256: F,
    expectedCanonicalMemoryWriterRouteSha256: D,
    allowedTools: new Set(['read', 'edit', 'test', 'build']),
  })
}

const objective: ObjectiveFence = {
  workId: 'WORK.PUTRI.1',
  generation: 1,
  objectiveRevision: 1,
  ownerPrincipal: PUTRI_PRINCIPAL,
  sourceWatermark: 'SOURCE.1',
  conversationWatermark: 'CONVERSATION.1',
  cancelGeneration: 0,
  supersessionGeneration: 0,
  authorizationEpoch: 7,
  currentnessSha256: D,
  state: 'ACTIVE',
}

function turn(overrides: Partial<CanonicalPutriTurn> = {}): CanonicalPutriTurn {
  return {
    turnId: 'TURN.PUTRI.1',
    workId: objective.workId,
    generation: objective.generation,
    objectiveRevision: objective.objectiveRevision,
    turnSequence: 1,
    principalId: PUTRI_PRINCIPAL,
    profileIdentitySha256: D,
    hostIdentitySha256: E,
    ownerPrivateNamespaceSha256: F,
    surfaceId: 'deepseek-harness',
    surfaceKind: CANONICAL_PUTRI_TELEPHONE_SURFACE,
    surfacePrivacyScopeSha256: D,
    canonicalSessionRefSha256: E,
    canonicalConversationRefSha256: F,
    canonicalMemoryNamespaceSha256: D,
    canonicalMemoryWriterRouteSha256: D,
    memoryParityPolicySha256: E,
    memoryParityCursorSha256: F,
    sourceWatermark: objective.sourceWatermark,
    conversationWatermark: objective.conversationWatermark,
    cancelGeneration: objective.cancelGeneration,
    supersessionGeneration: objective.supersessionGeneration,
    authorizationEpoch: objective.authorizationEpoch,
    inputSha256: D,
    sessionAuthority: GIANOS_FRONT_DOOR,
    memoryAuthority: CANONICAL_AUTHORITIES.memory,
    ...overrides,
  }
}

function request(overrides: Partial<WorkspaceToolCall> = {}): WorkspaceToolCall {
  return {
    toolCallId: 'TOOL.PUTRI.1',
    turn: turn(),
    workspacePath: 'F:\\DS-Harness\\packages',
    workspaceIdentitySha256: F,
    requestedTools: ['read', 'edit', 'test', 'build'],
    requestedShadowResources: [],
    toolInputSha256: D,
    resultSchemaRef: 'SCHEMA.PATCH.TEST.EVIDENCE.V1',
    toolCallSha256: E,
    bridge: PRDG_WORKSPACE_TOOL_BRIDGE,
    ...overrides,
  }
}

function result(overrides: Partial<WorkspaceToolResult> = {}): WorkspaceToolResult {
  const current = turn()
  return {
    evidenceId: 'EVIDENCE.PUTRI.1',
    toolCallId: 'TOOL.PUTRI.1',
    turnId: current.turnId,
    workId: current.workId,
    generation: current.generation,
    objectiveRevision: current.objectiveRevision,
    turnSequence: current.turnSequence,
    principalId: current.principalId,
    surfaceId: current.surfaceId,
    surfacePrivacyScopeSha256: current.surfacePrivacyScopeSha256,
    canonicalSessionRefSha256: current.canonicalSessionRefSha256,
    canonicalMemoryNamespaceSha256: current.canonicalMemoryNamespaceSha256,
    memoryParityCursorSha256: current.memoryParityCursorSha256,
    sourceWatermark: current.sourceWatermark,
    conversationWatermark: current.conversationWatermark,
    cancelGeneration: current.cancelGeneration,
    supersessionGeneration: current.supersessionGeneration,
    authorizationEpoch: current.authorizationEpoch,
    toolCallSha256: E,
    resultSha256: F,
    resultSchemaRef: 'SCHEMA.PATCH.TEST.EVIDENCE.V1',
    effectCount: 0,
    providerCallCount: 0,
    ...overrides,
  }
}

function knowledge(overrides: Partial<CanonicalKnowledgeProposal> = {}): CanonicalKnowledgeProposal {
  const current = turn()
  return {
    knowledgeId: 'KNOWLEDGE.PUTRI.1',
    principalId: current.principalId,
    turnId: current.turnId,
    toolCallId: 'TOOL.PUTRI.1',
    canonicalSessionRefSha256: current.canonicalSessionRefSha256,
    canonicalMemoryNamespaceSha256: current.canonicalMemoryNamespaceSha256,
    canonicalMemoryWriterRouteSha256: current.canonicalMemoryWriterRouteSha256,
    surfaceId: current.surfaceId,
    surfacePrivacyScopeSha256: current.surfacePrivacyScopeSha256,
    memoryParityPolicySha256: current.memoryParityPolicySha256,
    memoryParityCursorSha256: current.memoryParityCursorSha256,
    turnSequence: current.turnSequence,
    resultSha256: F,
    problemSha256: D,
    decisionSha256: E,
    solutionSha256: F,
    artifactLedgerSha256: D,
    evidenceSha256: E,
    privacyClass: 'OWNER_PRIVATE_CANONICAL',
    writeMode: 'PROPOSE_TO_CANONICAL_MEMORY_WRITER',
    ...overrides,
  }
}

describe('typed read-only GianaOS front-door projection', () => {
  it('requires the exact unique 13-Girl set and excludes Princess OS/Lara', () => {
    const projected = adapter().projectGirls(allEvidence(), NOW)
    expect(projected).toHaveLength(13)
    expect(projected.map(item => item.routeId)).toEqual(GIANA_GIRLS.map(id => `giana.${id}`))
    expect(projected.some(item => item.routeId === ('princess.lara' as never))).toBe(false)
    expect(() => adapter().projectGirls(allEvidence().slice(0, 12), NOW)).toThrow('EXACT_13')
    expect(() => adapter().projectGirls([...allEvidence(), evidence('putri')], NOW)).toThrow('EXACT_13')
  })

  it('fails closed on stale, expired, partial, wrong-principal, and wrong-host evidence', () => {
    const rows = allEvidence()
    expect(() => adapter().projectGirls(rows.map((item, index) => index === 0 ? { ...item, currentness: 'STALE' } : item), NOW))
      .toThrow('ROUTE_NOT_CURRENT')
    expect(() => adapter().projectGirls(rows.map((item, index) => index === 0 ? { ...item, expiresAt: NOW } : item), NOW))
      .toThrow('EXPIRED')
    expect(() => adapter().projectGirls(rows.map((item, index) => index === 0 ? { ...item, capability: 'PARTIAL' } : item), NOW))
      .toThrow('CAPABILITY_NOT_READY')
    expect(() => adapter().preparePutriWorkspaceToolCall(request(), objective, { ...evidence('putri'), principalId: 'giana.maya' }, NOW))
      .toThrow('ROUTE_OR_PRINCIPAL')
    expect(() => adapter().preparePutriWorkspaceToolCall(request(), objective, { ...evidence('putri'), hostIdentitySha256: F }, NOW))
      .toThrow('HOST_IDENTITY')
  })

  it('projects a surface session deterministically without opening or replacing it', () => {
    const input = {
      routeId: 'giana.putri' as const,
      principalId: 'giana.putri' as const,
      sessionRefSha256: D,
      sequence: 12,
      transcriptSha256: E,
      cancelGeneration: 0,
      supersessionGeneration: 0,
    }
    expect(adapter().projectTranscript(input)).toEqual(adapter().projectTranscript(input))
    expect(adapter().projectTranscript(input).state).toBe('READ_ONLY_PROJECTION')
  })
})

describe('canonical Putri telephone surface candidate', () => {
  it('preserves Putri, the canonical surface session, MOA authority, and private parity boundaries', () => {
    const prepared = adapter().preparePutriWorkspaceToolCall(request(), objective, evidence('putri'), NOW)
    expect(prepared.role).toBe(CANONICAL_PUTRI_TELEPHONE_SURFACE)
    expect(prepared.principalPreserved).toBe(true)
    expect(prepared.canonicalSessionPreserved).toBe(true)
    expect(prepared.moaAuthorityRetainedByPutri).toBe(true)
    expect(prepared.rawCrossSurfaceTranscriptMergeAuthorized).toBe(false)
    expect(prepared.executionAuthorized).toBe(false)
    expect(prepared.providerCallAuthorized).toBe(false)
    expect(prepared.liveEffectAuthorized).toBe(false)
  })

  it('rejects a worker substitution, shadow authority, path escape, or disallowed tool', () => {
    const subject = adapter()
    expect(() => subject.preparePutriWorkspaceToolCall(request({ turn: turn({ principalId: 'giana.maya' as never }) }), objective, evidence('putri'), NOW))
      .toThrow('PUTRI_CANONICAL')
    expect(() => subject.preparePutriWorkspaceToolCall(request({ turn: turn({ surfaceId: 'other' as never }) }), objective, evidence('putri'), NOW))
      .toThrow('TELEPHONE_SURFACE')
    expect(() => subject.preparePutriWorkspaceToolCall(request({ workspacePath: 'F:\\DS-Harness\\..\\GianaOS' }), objective, evidence('putri'), NOW))
      .toThrow('PATH_ESCAPE')
    expect(() => subject.preparePutriWorkspaceToolCall(request({ requestedTools: ['read', 'shell' as never] }), objective, evidence('putri'), NOW))
      .toThrow('DISALLOWED_TOOL')
    for (const resource of ['credential-export', 'direct-database', 'shadow-memory', 'shadow-profile', 'provider-bypass', 'shadow-session', 'live-effect'] as const) {
      expect(() => subject.preparePutriWorkspaceToolCall(request({ requestedShadowResources: [resource] }), objective, evidence('putri'), NOW))
        .toThrow('SHADOW_AUTHORITY_OR_SECRET_REQUEST')
    }
  })

  it('returns tool evidence to the same canonical Putri turn and parity cursor', () => {
    const subject = adapter()
    const prepared = subject.preparePutriWorkspaceToolCall(request(), objective, evidence('putri'), NOW)
    const accepted = subject.acceptWorkspaceToolResult(result(), prepared, objective)
    expect(accepted.state).toBe('RETURN_TO_CANONICAL_PUTRI_TURN')
    expect(accepted.knowledgeCapture).toBe(CANONICAL_MEMORY_CAPTURE_REQUIRED)
    expect(accepted.parityReconciliation).toBe(MEMORY_PARITY_RECONCILIATION_REQUIRED)
    expect(subject.acceptWorkspaceToolResult(result(), prepared, objective)).toBe(accepted)
  })

  it('rejects forged, cancelled, superseded, replayed, cross-surface, or effectful returns', () => {
    const subject = adapter()
    const prepared = subject.preparePutriWorkspaceToolCall(request(), objective, evidence('putri'), NOW)
    subject.acceptWorkspaceToolResult(result(), prepared, objective)
    expect(() => subject.acceptWorkspaceToolResult(result({ evidenceId: 'EVIDENCE.FORGED', resultSha256: D }), prepared, objective))
      .toThrow('REPLAY_OR_CONFLICTING')
    expect(() => adapter().acceptWorkspaceToolResult(result({ canonicalSessionRefSha256: D }), prepared, objective))
      .toThrow('FORGED_OR_MISMATCHED')
    expect(() => adapter().acceptWorkspaceToolResult(result({ surfacePrivacyScopeSha256: E }), prepared, objective))
      .toThrow('FORGED_OR_MISMATCHED')
    expect(() => adapter().acceptWorkspaceToolResult(result(), prepared, { ...objective, state: 'CANCELLED', cancelGeneration: 1 }))
      .toThrow('STALE_CANCELLED_OR_SUPERSEDED')
    expect(() => adapter().acceptWorkspaceToolResult(result(), prepared, { ...objective, state: 'SUPERSEDED', supersessionGeneration: 1 }))
      .toThrow('STALE_CANCELLED_OR_SUPERSEDED')
    expect(() => adapter().acceptWorkspaceToolResult({ ...result(), effectCount: 1 as never }, prepared, objective))
      .toThrow('LIVE_EFFECT')
  })

  it('proposes durable knowledge only through Putri canonical memory writer', () => {
    const subject = adapter()
    const prepared = subject.preparePutriWorkspaceToolCall(request(), objective, evidence('putri'), NOW)
    const acceptedResult = result()
    subject.acceptWorkspaceToolResult(acceptedResult, prepared, objective)
    const capture = subject.prepareCanonicalKnowledgeCapture(knowledge(), acceptedResult, prepared, objective)
    expect(capture.state).toBe('CANONICAL_MEMORY_WRITE_PROPOSAL')
    expect(capture.memoryAuthority).toBe(CANONICAL_AUTHORITIES.memory)
    expect(capture.writeAuthorized).toBe(false)
    expect(capture.shadowMemoryAuthorized).toBe(false)
    expect(capture.rawTranscriptMergeAuthorized).toBe(false)
    expect(() => subject.prepareCanonicalKnowledgeCapture(knowledge({ canonicalSessionRefSha256: D }), acceptedResult, prepared, objective))
      .toThrow('NOT_BOUND_TO_CANONICAL_TURN')
    expect(() => subject.prepareCanonicalKnowledgeCapture(knowledge({ privacyClass: 'PUBLIC' as never }), acceptedResult, prepared, objective))
      .toThrow('CANONICAL_PRIVATE_MEMORY')
  })
})
