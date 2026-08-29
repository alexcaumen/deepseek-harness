/**
 * The versioned `giana.prdg-workspace-tool-bridge.v1` request and evidence
 * grammar exchanged with a canonical GianaOS principal.
 *
 * The deployed canonical gateway route carries one text field per turn, so the
 * protocol rides inside fenced blocks in that text rather than a provider
 * `tools` array. Parsing is strict: an unparseable, mistyped, or wrong-version
 * block is refused, never repaired, because a repaired call would execute
 * something the principal did not ask for.
 * @module dsh-llm-gianaos-workspace-bridge/protocol
 */

import { createHash } from 'node:crypto'

/** Protocol identity carried by every request and evidence block. */
export const PROTOCOL_VERSION = 'giana.prdg-workspace-tool-bridge.v1' as const

/** Fence tag a principal opens to request one bounded workspace operation. */
export const CALL_FENCE = 'giana-tool' as const

/** The bounded coding tools this bridge admits. */
export const CODING_TOOLS = Object.freeze(['read', 'edit', 'test', 'build', 'terminal'] as const)

/** One bounded coding tool. */
export type CodingTool = typeof CODING_TOOLS[number]

/** Refusal classes for a malformed or out-of-contract request block. */
export type ProtocolRefusal =
  | 'NO_TOOL_CALL'
  | 'MALFORMED_TOOL_CALL'
  | 'UNSUPPORTED_PROTOCOL_VERSION'
  | 'UNKNOWN_TOOL'
  | 'MISSING_FIELD'
  | 'AMBIGUOUS_TOOL_CALL'

/** Raised for every grammar-level refusal. */
export class ProtocolError extends Error {
  /**
   * @param refusal - the typed refusal class.
   * @param detail - optional non-secret detail appended to the message.
   */
  constructor(readonly refusal: ProtocolRefusal, detail?: string) {
    super(detail === undefined ? refusal : `${refusal}: ${detail}`)
    this.name = 'ProtocolError'
  }
}

/** One workspace operation requested by the canonical principal. */
export interface WorkspaceToolRequest {
  readonly protocol: typeof PROTOCOL_VERSION
  /** Immutable work id minted by the surface for this canonical turn. */
  readonly workId: string
  /** Monotonic generation of that work id. */
  readonly generation: number
  readonly tool: CodingTool
  /** Workspace selector from the configured allowlist. */
  readonly workspaceId: string
  /** Workspace-relative target; required by `read` and `edit`. */
  readonly path?: string
  /** Expected pre-image digest for `edit`, enforced as optimistic concurrency. */
  readonly preimageSha256?: string
  /** Replacement content for `edit`. */
  readonly content?: string
  /** Named script from the configured allowlist for `test` and `build`. */
  readonly script?: string
  /** Shell command for `terminal`; operator-bounded via allowlist when configured. */
  readonly command?: string
}

/** The triple-backtick fence delimiter, kept as data so the patterns stay readable. */
const FENCE = '```'

/**
 * Matches one complete request block. Non-greedy so two adjacent blocks are
 * counted separately and reported as ambiguous rather than merged into one.
 */
const FENCE_PATTERN = new RegExp(
  `${FENCE}[ \\t]*${CALL_FENCE}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n?${FENCE}`,
  'g',
)

/**
 * Describe an untrusted value for a refusal message without stringifying an
 * object into an unreadable default form.
 * @param value - the offending value from a parsed block.
 * @returns a short, safe description.
 */
function describeValue(value: unknown): string {
  if (value === undefined) return 'absent'
  if (typeof value === 'string') return value
  return typeof value
}

/**
 * The SHA-256 digest of a UTF-8 string, upper-case hex.
 * @param value - the text to digest.
 * @returns the upper-case hex digest.
 */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').toUpperCase()
}

/**
 * Canonical JSON for digesting: object keys sorted, no incidental whitespace.
 * @param value - a JSON-serializable value.
 * @returns the canonical JSON text.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
  return `{${entries.join(',')}}`
}

/**
 * Whether the text has begun a request fence, including one still streaming
 * and not yet closed.
 * @param text - accumulated reply text.
 * @returns true once the opening fence has appeared.
 */
export function hasToolCallFence(text: string): boolean {
  return new RegExp(`${FENCE}[ \\t]*${CALL_FENCE}\\b`).test(text)
}

/**
 * The index at which an opening request fence starts, for suppressing the
 * machine block from operator-visible streaming output.
 * @param text - accumulated reply text.
 * @returns the start index, or -1 when no fence has opened.
 */
export function toolCallFenceStart(text: string): number {
  return text.search(new RegExp(`${FENCE}[ \\t]*${CALL_FENCE}\\b`))
}

/**
 * Extract the single tool request from a canonical reply.
 *
 * A turn carrying more than one request block is refused rather than executed
 * in an arbitrary order: the surface cannot know which the principal meant to
 * run first, and running both would consume two generations for one intent.
 * @param text - the full canonical reply text for one turn.
 * @returns the parsed request, or undefined when the turn asked for nothing.
 */
export function parseToolCall(text: string): WorkspaceToolRequest | undefined {
  const matches = [...text.matchAll(FENCE_PATTERN)]
  if (matches.length === 0) return undefined
  if (matches.length > 1) throw new ProtocolError('AMBIGUOUS_TOOL_CALL', `${matches.length} blocks`)

  const captured = matches[0]?.[1]
  if (captured === undefined) throw new ProtocolError('MALFORMED_TOOL_CALL', 'unterminated block')
  const body = captured.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new ProtocolError('MALFORMED_TOOL_CALL', 'block body is not JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProtocolError('MALFORMED_TOOL_CALL', 'block body is not a JSON object')
  }
  const record = parsed as Record<string, unknown>

  if (record['protocol'] !== PROTOCOL_VERSION) {
    throw new ProtocolError('UNSUPPORTED_PROTOCOL_VERSION', describeValue(record['protocol']))
  }
  const tool = record['tool']
  if (typeof tool !== 'string' || !(CODING_TOOLS as readonly string[]).includes(tool)) {
    throw new ProtocolError('UNKNOWN_TOOL', describeValue(tool))
  }
  const workId = record['workId']
  const generation = record['generation']
  const workspaceId = record['workspaceId']
  if (typeof workId !== 'string' || workId === '') throw new ProtocolError('MISSING_FIELD', 'workId')
  if (typeof generation !== 'number' || !Number.isInteger(generation)) {
    throw new ProtocolError('MISSING_FIELD', 'generation')
  }
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    throw new ProtocolError('MISSING_FIELD', 'workspaceId')
  }

  const optionalText = (key: string): Record<string, string> => {
    const value = record[key]
    if (value === undefined) return {}
    if (typeof value !== 'string') throw new ProtocolError('MALFORMED_TOOL_CALL', key)
    return { [key]: value }
  }

  return Object.freeze({
    protocol: PROTOCOL_VERSION,
    workId,
    generation,
    tool: tool as CodingTool,
    workspaceId,
    ...optionalText('path'),
    ...optionalText('preimageSha256'),
    ...optionalText('content'),
    ...optionalText('script'),
    ...optionalText('command'),
  })
}

/**
 * Remove every request fence from text shown to the operator.
 *
 * The fenced block is surface machinery; the prose around it is the
 * principal's own reply and stays untouched.
 * @param text - the canonical reply text.
 * @returns the text with request blocks removed and surrounding blank runs collapsed.
 */
export function stripToolCallFences(text: string): string {
  return text.replace(FENCE_PATTERN, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** The outcome classes an evidence block can report. */
export type EvidenceStatus = 'OK' | 'REFUSED' | 'FAILED'

/** One bounded execution result returned to the canonical principal. */
export interface WorkspaceToolEvidence {
  readonly protocol: typeof PROTOCOL_VERSION
  readonly evidenceId: string
  readonly workId: string
  readonly generation: number
  /**
   * The generation the principal must use for any follow-up call after this
   * evidence. Carried on every evidence block so a retry or a second call
   * never has to guess the live generation.
   */
  readonly nextGeneration?: number
  readonly tool: CodingTool | 'none'
  readonly workspaceId: string
  readonly status: EvidenceStatus
  /** Typed refusal or failure class; absent when status is `OK`. */
  readonly refusal?: string
  readonly path?: string
  readonly sourceBytes?: number
  readonly contentSha256?: string
  readonly preimageSha256?: string
  readonly postimageSha256?: string
  readonly exitCode?: number
  readonly truncated?: boolean
  readonly redacted?: boolean
  readonly body?: string
}

/**
 * Render evidence as the fenced block appended to the next canonical turn.
 *
 * The body is emitted outside the JSON header so a large file does not have to
 * survive JSON escaping, and so the principal reads the content directly.
 * @param evidence - the execution evidence.
 * @returns the text block to send as the next message in the same canonical session.
 */
export function renderEvidence(evidence: WorkspaceToolEvidence): string {
  const { body, ...header } = evidence
  const lines = [
    `${FENCE}giana-tool-result`,
    canonicalJson(header),
    FENCE,
  ]
  if (body !== undefined && body !== '') {
    lines.push('', `${FENCE}giana-tool-body`, body, FENCE)
  }
  return lines.join('\n')
}
