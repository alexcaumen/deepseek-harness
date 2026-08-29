/**
 * Output bounding and secret redaction for evidence leaving PRDG.
 *
 * A tool result crosses a process and network boundary into the canonical
 * runtime, so it is bounded and scrubbed here rather than at the caller. The
 * patterns cover the credential shapes this lane can plausibly encounter in a
 * workspace file or a build log; redaction replaces the value and never the
 * surrounding text, so the principal still sees that a credential was present.
 * @module dsh-llm-gianaos-workspace-bridge/redact
 */

/** The marker substituted for any matched credential value. */
export const REDACTED = '[REDACTED]'

/**
 * Credential shapes refused egress. Each pattern keeps its label or prefix and
 * replaces only the value, so a reader can still see what was removed.
 */
const SECRET_PATTERNS: readonly { readonly pattern: RegExp; readonly replace: string }[] = Object.freeze([
  // key/token/secret/password assignment in config, env, or source
  { pattern: /((?:api[_-]?key|secret|token|password|passwd|pwd|credential)\s*[=:]\s*)(["']?)[^\s"',;]{6,}\2/gi, replace: `$1$2${REDACTED}$2` },
  // Authorization headers
  { pattern: /((?:authorization|proxy-authorization)\s*[=:]\s*)(?:bearer\s+|basic\s+)?[^\s"',;]{6,}/gi, replace: `$1${REDACTED}` },
  // PEM private key blocks
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: REDACTED },
  // AWS access key ids and common vendor key prefixes
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: REDACTED },
  { pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, replace: REDACTED },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: REDACTED },
  // URL userinfo
  { pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):[^/\s@]+@/gi, replace: `$1:${REDACTED}@` },
])

/**
 * Replace every recognized credential value in text.
 * @param text - candidate evidence text.
 * @returns the text with credential values replaced by {@link REDACTED}.
 */
export function redactSecrets(text: string): string {
  let output = text
  for (const { pattern, replace } of SECRET_PATTERNS) {
    output = output.replace(pattern, replace)
  }
  return output
}

/** A bounded, scrubbed body plus what bounding removed. */
export interface BoundedText {
  readonly text: string
  readonly truncated: boolean
  /** Byte length of the source before bounding. */
  readonly sourceBytes: number
  readonly redacted: boolean
}

/**
 * Bound and scrub text for return to the canonical runtime.
 *
 * Bounding is applied before redaction so a very large file cannot make
 * scrubbing quadratic, and the truncation point is a whole line where possible
 * so the principal never receives a half-token.
 * @param source - the raw text read or captured.
 * @param maxBytes - the maximum UTF-8 byte budget for the returned body.
 * @returns the bounded, scrubbed text and its bounding facts.
 */
export function boundAndRedact(source: string, maxBytes: number): BoundedText {
  const sourceBytes = Buffer.byteLength(source, 'utf8')
  let body = source
  let truncated = false
  if (sourceBytes > maxBytes) {
    const slice = Buffer.from(source, 'utf8').subarray(0, maxBytes).toString('utf8')
    const lastBreak = slice.lastIndexOf('\n')
    body = lastBreak > 0 ? slice.slice(0, lastBreak) : slice
    truncated = true
  }
  const scrubbed = redactSecrets(body)
  return Object.freeze({
    text: scrubbed,
    truncated,
    sourceBytes,
    redacted: scrubbed !== body,
  })
}
