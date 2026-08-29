/**
 * The bridge: admit one request block, execute it under bounds, and render the
 * evidence that returns to the canonical principal.
 *
 * This module owns no identity, session, memory, approval, provider, or worker
 * authority. It converts an admitted request into bounded local evidence and
 * records what it accepted. The principal keeps synthesis, the final reply, and
 * every decision about what becomes durable knowledge.
 * @module dsh-llm-gianaos-workspace-bridge/bridge
 */

import { executeWorkspaceTool, type ExecutorConfig } from './executor.ts'
import {
  canonicalJson,
  parseToolCall,
  ProtocolError,
  PROTOCOL_VERSION,
  renderEvidence,
  sha256,
  type WorkspaceToolEvidence,
  type WorkspaceToolRequest,
} from './protocol.ts'
import {
  admitRequest,
  advanceFence,
  EvidenceLedger,
  FenceError,
  type ObjectiveState,
  type TurnFence,
} from './turn-fence.ts'

/** One completed bridge hop. */
export interface BridgeHop {
  readonly request?: WorkspaceToolRequest
  readonly evidence: WorkspaceToolEvidence
  /** Text to send as the next message in the same canonical session. */
  readonly evidenceMessage: string
  readonly fence: TurnFence
  readonly toolCallSha256: string
  readonly resultSha256: string
  readonly durationMs: number
}

/** Everything the bridge needs for one turn. */
export interface BridgeContext {
  readonly fence: TurnFence
  readonly objective: ObjectiveState
  readonly executor: ExecutorConfig
  readonly ledger: EvidenceLedger
  readonly signal?: AbortSignal
}

/**
 * Build the evidence identifier for one accepted call.
 * @param fence - the fence that admitted the call.
 * @param toolCallSha256 - digest of the admitted request.
 * @returns a stable evidence id.
 */
function evidenceId(fence: TurnFence, toolCallSha256: string): string {
  return `E-${sha256(`${fence.workId}#${fence.generation}#${toolCallSha256}`).slice(0, 24)}`
}

/**
 * Process one canonical reply: parse any request block, admit it, execute it,
 * and produce the evidence message for the next turn.
 *
 * A refusal is still returned to the principal as typed evidence rather than
 * thrown away, so she learns why an operation did not run and can choose
 * differently instead of retrying blindly.
 * @param replyText - the canonical reply text for the current turn.
 * @param context - the live fence, objective, executor bounds, and ledger.
 * @returns the completed hop, or undefined when the reply requested nothing.
 */
export async function runBridgeHop(
  replyText: string,
  context: BridgeContext,
): Promise<BridgeHop | undefined> {
  const { fence, objective, executor, ledger, signal } = context

  let request: WorkspaceToolRequest | undefined
  try {
    request = parseToolCall(replyText)
  } catch (error: unknown) {
    if (!(error instanceof ProtocolError)) throw error
    const evidence: WorkspaceToolEvidence = Object.freeze({
      protocol: PROTOCOL_VERSION,
      evidenceId: evidenceId(fence, sha256(replyText)),
      workId: fence.workId,
      generation: fence.generation,
      nextGeneration: fence.generation + 1,
      tool: 'none' as const,
      workspaceId: '',
      status: 'REFUSED' as const,
      refusal: error.refusal,
    })
    return Object.freeze({
      evidence,
      evidenceMessage: renderEvidence(evidence),
      fence: advanceFence(fence),
      toolCallSha256: sha256(replyText),
      resultSha256: sha256(canonicalJson(evidence)),
      durationMs: 0,
    })
  }
  if (request === undefined) return undefined

  const toolCallSha256 = sha256(canonicalJson(request))

  try {
    admitRequest(fence, request, objective)
  } catch (error: unknown) {
    if (!(error instanceof FenceError)) throw error
    const evidence: WorkspaceToolEvidence = Object.freeze({
      protocol: PROTOCOL_VERSION,
      evidenceId: evidenceId(fence, toolCallSha256),
      workId: fence.workId,
      generation: fence.generation,
      nextGeneration: fence.generation + 1,
      tool: request.tool,
      workspaceId: request.workspaceId,
      status: 'REFUSED' as const,
      refusal: error.refusal,
    })
    return Object.freeze({
      request,
      evidence,
      evidenceMessage: renderEvidence(evidence),
      fence: advanceFence(fence),
      toolCallSha256,
      resultSha256: sha256(canonicalJson(evidence)),
      durationMs: 0,
    })
  }

  const outcome = await executeWorkspaceTool(request, executor, signal)
  const evidence: WorkspaceToolEvidence = Object.freeze({
    protocol: PROTOCOL_VERSION,
    evidenceId: evidenceId(fence, toolCallSha256),
    workId: fence.workId,
    generation: fence.generation,
    nextGeneration: fence.generation + 1,
    tool: request.tool,
    workspaceId: request.workspaceId,
    status: outcome.status,
    ...outcome.refusal === undefined ? {} : { refusal: outcome.refusal },
    ...outcome.path === undefined ? {} : { path: outcome.path },
    ...outcome.sourceBytes === undefined ? {} : { sourceBytes: outcome.sourceBytes },
    ...outcome.contentSha256 === undefined ? {} : { contentSha256: outcome.contentSha256 },
    ...outcome.preimageSha256 === undefined ? {} : { preimageSha256: outcome.preimageSha256 },
    ...outcome.postimageSha256 === undefined ? {} : { postimageSha256: outcome.postimageSha256 },
    ...outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode },
    ...outcome.truncated === undefined ? {} : { truncated: outcome.truncated },
    ...outcome.redacted === undefined ? {} : { redacted: outcome.redacted },
    ...outcome.body === undefined ? {} : { body: outcome.body },
  })
  const resultSha256 = sha256(canonicalJson(evidence))
  ledger.accept({
    workId: fence.workId,
    generation: fence.generation,
    toolCallSha256,
    resultSha256,
    evidenceId: evidence.evidenceId,
  })

  return Object.freeze({
    request,
    evidence,
    evidenceMessage: renderEvidence(evidence),
    fence: advanceFence(fence),
    toolCallSha256,
    resultSha256,
    durationMs: outcome.durationMs,
  })
}

/**
 * A distilled knowledge proposal for the canonical memory writer.
 *
 * The bridge composes the references and nothing else: no raw transcript, no
 * file body, no operator utterance. Only the canonical GianaOS memory writer
 * may persist it, and this lane never calls that writer itself.
 */
export interface CanonicalKnowledgeProposal {
  readonly protocol: typeof PROTOCOL_VERSION
  readonly knowledgeId: string
  readonly principalId: string
  readonly canonicalSessionId: string
  readonly workId: string
  readonly surfaceId: 'deepseek-harness'
  readonly toolCallSha256: string
  readonly resultSha256: string
  readonly artifactLedgerSha256: string
  readonly currentnessSha256: string
  readonly writeMode: 'PROPOSE_TO_CANONICAL_MEMORY_WRITER'
  readonly writeAuthorized: false
  readonly rawTranscriptIncluded: false
}

/**
 * Compose the proposal describing what this turn's bounded work produced.
 * @param fence - the turn fence.
 * @param ledger - the accepted-result ledger for the turn.
 * @returns the proposal, or undefined when the turn accepted no result.
 */
export function proposeCanonicalKnowledge(
  fence: TurnFence,
  ledger: EvidenceLedger,
): CanonicalKnowledgeProposal | undefined {
  const entries = ledger.list()
  if (entries.length === 0) return undefined
  const latest = entries[entries.length - 1]
  if (latest === undefined) return undefined
  const artifactLedgerSha256 = sha256(canonicalJson(entries))
  return Object.freeze({
    protocol: PROTOCOL_VERSION,
    knowledgeId: `K-${sha256(`${fence.workId}#${artifactLedgerSha256}`).slice(0, 24)}`,
    principalId: fence.principalId,
    canonicalSessionId: fence.canonicalSessionId,
    workId: fence.workId,
    surfaceId: fence.surfaceId,
    toolCallSha256: latest.toolCallSha256,
    resultSha256: latest.resultSha256,
    artifactLedgerSha256,
    currentnessSha256: fence.currentnessSha256,
    writeMode: 'PROPOSE_TO_CANONICAL_MEMORY_WRITER' as const,
    writeAuthorized: false as const,
    rawTranscriptIncluded: false as const,
  })
}
