import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  hasToolCallFence,
  parseToolCall,
  PROTOCOL_VERSION,
  renderEvidence,
  sha256,
  stripToolCallFences,
  toolCallFenceStart,
} from '../src/protocol.ts'
import { boundAndRedact, REDACTED, redactSecrets } from '../src/redact.ts'

const FENCE = '```'

function callBlock(body: Record<string, unknown>): string {
  return [`${FENCE}giana-tool`, JSON.stringify(body), FENCE].join('\n')
}

const validCall = {
  protocol: PROTOCOL_VERSION,
  workId: 'W-abc',
  generation: 1,
  tool: 'read',
  workspaceId: 'WS1',
  path: 'docs/marker.txt',
}

describe('request grammar', () => {
  it('parses one well-formed request block', () => {
    const parsed = parseToolCall(`Reading that now.\n\n${callBlock(validCall)}`)
    expect(parsed).toMatchObject({ tool: 'read', workspaceId: 'WS1', path: 'docs/marker.txt', generation: 1 })
  })

  it('returns undefined when the turn requested nothing', () => {
    expect(parseToolCall('Just a reply with no request.')).toBeUndefined()
  })

  it('refuses an unknown tool, a wrong protocol version, and a missing field', () => {
    expect(() => parseToolCall(callBlock({ ...validCall, tool: 'shell' }))).toThrow('UNKNOWN_TOOL')
    expect(() => parseToolCall(callBlock({ ...validCall, protocol: 'giana.v2' }))).toThrow('UNSUPPORTED_PROTOCOL_VERSION')
    expect(() => parseToolCall(callBlock({ ...validCall, workId: undefined }))).toThrow('MISSING_FIELD')
    expect(() => parseToolCall(callBlock({ ...validCall, generation: '1' }))).toThrow('MISSING_FIELD')
    expect(() => parseToolCall(callBlock({ ...validCall, workspaceId: '' }))).toThrow('MISSING_FIELD')
  })

  it('refuses a malformed block instead of repairing it', () => {
    expect(() => parseToolCall(`${FENCE}giana-tool\nnot json\n${FENCE}`)).toThrow('MALFORMED_TOOL_CALL')
    expect(() => parseToolCall(`${FENCE}giana-tool\n[1,2]\n${FENCE}`)).toThrow('MALFORMED_TOOL_CALL')
  })

  it('refuses two request blocks in one turn rather than picking an order', () => {
    expect(() => parseToolCall(`${callBlock(validCall)}\n\n${callBlock(validCall)}`)).toThrow('AMBIGUOUS_TOOL_CALL')
  })

  it('detects and locates an opening fence while it is still streaming', () => {
    const partial = `Working on it.\n\n${FENCE}giana-tool\n{"protocol"`
    expect(hasToolCallFence(partial)).toBe(true)
    expect(toolCallFenceStart(partial)).toBe('Working on it.\n\n'.length)
    expect(toolCallFenceStart('no fence yet')).toBe(-1)
  })

  it('strips the machine block from operator-visible text', () => {
    const text = `Here is the plan.\n\n${callBlock(validCall)}\n\nDone.`
    const stripped = stripToolCallFences(text)
    expect(stripped).toContain('Here is the plan.')
    expect(stripped).not.toContain('giana-tool')
    expect(stripped).not.toContain('WS1')
  })
})

describe('digests and evidence rendering', () => {
  it('produces key-order-independent canonical JSON', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(sha256(canonicalJson({ a: 1, b: 2 }))).toBe(sha256(canonicalJson({ b: 2, a: 1 })))
  })

  it('omits undefined members so an absent field cannot change a digest', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('renders evidence with the body outside the JSON header', () => {
    const rendered = renderEvidence({
      protocol: PROTOCOL_VERSION,
      evidenceId: 'E-1',
      workId: 'W-abc',
      generation: 1,
      tool: 'read',
      workspaceId: 'WS1',
      status: 'OK',
      path: 'docs\\marker.txt',
      body: 'MARKER',
    })
    expect(rendered).toContain('giana-tool-result')
    expect(rendered).toContain('giana-tool-body')
    expect(rendered).toContain('MARKER')
    expect(rendered).not.toContain('"body"')
  })
})

describe('egress bounding and redaction', () => {
  it('redacts assignment, header, vendor-prefix, and URL credential shapes', () => {
    expect(redactSecrets('api_key = "abcdef123456"')).toContain(REDACTED)
    expect(redactSecrets('Authorization: Bearer abcdef123456')).toContain(REDACTED)
    expect(redactSecrets('token: ghp_abcdefghijklmnopqrstuvwxyz')).toContain(REDACTED)
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toContain(REDACTED)
    expect(redactSecrets('https://user:hunter2secret@example.test/path')).toContain(REDACTED)
    expect(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----')).toBe(REDACTED)
  })

  it('keeps the surrounding text so the principal still sees what was removed', () => {
    const redacted = redactSecrets('api_key = "abcdef123456"')
    expect(redacted).toContain('api_key')
    expect(redacted).not.toContain('abcdef123456')
  })

  it('leaves ordinary prose untouched', () => {
    const prose = 'The build passed and the marker file contains MARKER.'
    expect(redactSecrets(prose)).toBe(prose)
  })

  it('bounds oversized output at a line break and reports the original size', () => {
    const source = `${'line\n'.repeat(500)}tail`
    const bounded = boundAndRedact(source, 100)
    expect(bounded.truncated).toBe(true)
    expect(bounded.sourceBytes).toBe(Buffer.byteLength(source, 'utf8'))
    expect(Buffer.byteLength(bounded.text, 'utf8')).toBeLessThanOrEqual(100)
    expect(bounded.text.endsWith('line')).toBe(true)
  })

  it('reports untruncated, unredacted output faithfully', () => {
    const bounded = boundAndRedact('MARKER', 1024)
    expect(bounded).toMatchObject({ text: 'MARKER', truncated: false, redacted: false })
  })
})
