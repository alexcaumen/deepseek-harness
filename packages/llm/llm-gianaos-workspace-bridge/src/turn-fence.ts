/**
 * The per-turn authorization fence: work identity, generation, watermarks, and
 * the accepted-result ledger.
 *
 * The deployed canonical gateway route returns text and mints no work id, so
 * the surface mints one per canonical turn and binds it to the canonical
 * session. A request block echoing a work id or generation that is not the
 * live one is a stale, replayed, cancelled, superseded, or forged call and is
 * refused. That makes the fence the single place where a tool call earns the
 * right to execute.
 * @module dsh-llm-gianaos-workspace-bridge/turn-fence
 */

import { canonicalJson, sha256, type WorkspaceToolRequest } from './protocol.ts'

/** Refusal classes raised by the fence. */
export type FenceRefusal =
  | 'PRINCIPAL_MISMATCH'
  | 'SESSION_MISMATCH'
  | 'WORK_ID_MISMATCH'
  | 'STALE_GENERATION'
  | 'FUTURE_GENERATION'
  | 'OBJECTIVE_CANCELLED'
  | 'OBJECTIVE_SUPERSEDED'
  | 'HOP_BUDGET_EXHAUSTED'
  | 'REPLAY_CONFLICT'

/** Raised for every fence-level refusal. */
export class FenceError extends Error {
  /**
   * @param refusal - the typed refusal class.
   * @param detail - optional non-secret detail appended to the message.
   */
  constructor(readonly refusal: FenceRefusal, detail?: string) {
    super(detail === undefined ? refusal : `${refusal}: ${detail}`)
    this.name = 'FenceError'
  }
}

/** The canonical identity a turn is bound to. */
export interface CanonicalTurnBinding {
  /** Exact canonical principal, for example `giana.putri`. */
  readonly principalId: string
  /** Privacy-scoped canonical surface session id used on the wire. */
  readonly canonicalSessionId: string
  /** Surface identity; fixed for this lane. */
  readonly surfaceId: 'deepseek-harness'
  /** Digest of the operator input that opened this turn. */
  readonly sourceWatermark: string
  /** Digest binding the turn to its canonical conversation. */
  readonly conversationWatermark: string
  /** Bumped by the operator cancelling in-flight work. */
  readonly cancelGeneration: number
  /** Bumped when a later objective supersedes this one. */
  readonly supersessionGeneration: number
  /** Epoch of the bridge authorization grant. */
  readonly authorizationEpoch: number
}

/** One live turn fence, valid for exactly one canonical turn. */
export interface TurnFence extends CanonicalTurnBinding {
  readonly workId: string
  /** Generation of the next admissible request; incremented per accepted call. */
  readonly generation: number
  /** Remaining bridge hops for this turn. */
  readonly hopsRemaining: number
  readonly currentnessSha256: string
}

/**
 * Mint the fence for one canonical turn.
 *
 * The work id is derived from the canonical session, the watermarks, and the
 * generations, so the same operator input in the same session under a bumped
 * cancel generation yields a different work id and cannot be replayed.
 * @param binding - the canonical identity for the turn.
 * @param hopBudget - maximum bridge hops allowed in this turn.
 * @returns the live fence at generation 1.
 */
export function mintTurnFence(binding: CanonicalTurnBinding, hopBudget: number): TurnFence {
  const currentnessSha256 = sha256(canonicalJson({
    principalId: binding.principalId,
    canonicalSessionId: binding.canonicalSessionId,
    surfaceId: binding.surfaceId,
    sourceWatermark: binding.sourceWatermark,
    conversationWatermark: binding.conversationWatermark,
    cancelGeneration: binding.cancelGeneration,
    supersessionGeneration: binding.supersessionGeneration,
    authorizationEpoch: binding.authorizationEpoch,
  }))
  return Object.freeze({
    ...binding,
    workId: `W-${currentnessSha256.slice(0, 24)}`,
    generation: 1,
    hopsRemaining: Math.max(0, hopBudget),
    currentnessSha256,
  })
}

/** The live objective state a turn is checked against at admission time. */
export interface ObjectiveState {
  readonly cancelGeneration: number
  readonly supersessionGeneration: number
}

/**
 * Admit one request block against the live fence.
 *
 * Cancellation and supersession are compared against the objective observed
 * now, not against the values captured when the fence was minted, so work
 * cancelled mid-turn cannot still execute.
 * @param fence - the live turn fence.
 * @param request - the parsed request block.
 * @param objective - the objective state observed at admission time.
 * @returns nothing; refusal is by exception.
 */
export function admitRequest(
  fence: TurnFence,
  request: WorkspaceToolRequest,
  objective: ObjectiveState,
): void {
  if (objective.cancelGeneration !== fence.cancelGeneration) {
    throw new FenceError('OBJECTIVE_CANCELLED', `${fence.cancelGeneration} -> ${objective.cancelGeneration}`)
  }
  if (objective.supersessionGeneration !== fence.supersessionGeneration) {
    throw new FenceError('OBJECTIVE_SUPERSEDED', `${fence.supersessionGeneration} -> ${objective.supersessionGeneration}`)
  }
  if (request.workId !== fence.workId) throw new FenceError('WORK_ID_MISMATCH', request.workId)
  if (request.generation < fence.generation) {
    throw new FenceError('STALE_GENERATION', `${request.generation} < ${fence.generation}`)
  }
  if (request.generation > fence.generation) {
    throw new FenceError('FUTURE_GENERATION', `${request.generation} > ${fence.generation}`)
  }
  if (fence.hopsRemaining <= 0) throw new FenceError('HOP_BUDGET_EXHAUSTED', fence.workId)
}

/**
 * Advance the fence after one admitted and executed call.
 * @param fence - the fence that admitted the call.
 * @returns the fence at the next generation with one hop consumed.
 */
export function advanceFence(fence: TurnFence): TurnFence {
  return Object.freeze({
    ...fence,
    generation: fence.generation + 1,
    hopsRemaining: fence.hopsRemaining - 1,
  })
}

/** One accepted result, keyed by work id and generation. */
export interface LedgerEntry {
  readonly workId: string
  readonly generation: number
  readonly toolCallSha256: string
  readonly resultSha256: string
  readonly evidenceId: string
}

/**
 * The accepted-result ledger for one surface session.
 *
 * An identical repeat of an accepted call returns the recorded entry, so a
 * retried transport does not execute twice; a different result for the same
 * work id and generation is a conflict and is refused.
 */
export class EvidenceLedger {
  private readonly entries = new Map<string, LedgerEntry>()

  /**
   * Record one accepted result, or return the existing identical entry.
   * @param entry - the result to record.
   * @returns the recorded entry.
   */
  accept(entry: LedgerEntry): LedgerEntry {
    const key = `${entry.workId}#${entry.generation}`
    const prior = this.entries.get(key)
    if (prior !== undefined) {
      if (prior.toolCallSha256 === entry.toolCallSha256 && prior.resultSha256 === entry.resultSha256) {
        return prior
      }
      throw new FenceError('REPLAY_CONFLICT', key)
    }
    const frozen = Object.freeze(entry)
    this.entries.set(key, frozen)
    return frozen
  }

  /** Every accepted entry, in acceptance order, for the turn receipt. */
  list(): readonly LedgerEntry[] {
    return Object.freeze([...this.entries.values()])
  }
}
