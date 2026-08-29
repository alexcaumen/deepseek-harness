import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { proposeCanonicalKnowledge, runBridgeHop, type BridgeContext } from '../src/bridge.ts'
import type { ExecutorConfig } from '../src/executor.ts'
import { canonicalJson, PROTOCOL_VERSION, sha256 } from '../src/protocol.ts'
import {
  admitRequest,
  advanceFence,
  EvidenceLedger,
  mintTurnFence,
  type CanonicalTurnBinding,
  type TurnFence,
} from '../src/turn-fence.ts'
import { bindWorkspace } from '../src/workspace.ts'

const DIGEST = 'a'.repeat(64)
const FENCE = '```'

const binding: CanonicalTurnBinding = {
  principalId: 'giana.putri',
  canonicalSessionId: 'deepseek-harness:session-a',
  surfaceId: 'deepseek-harness',
  sourceWatermark: sha256('read the marker'),
  conversationWatermark: sha256('deepseek-harness:session-a'),
  cancelGeneration: 0,
  supersessionGeneration: 0,
  authorizationEpoch: 1,
}

async function workspace(writable: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'giana-bridge-e2e-'))
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'docs', 'marker.txt'), 'MARKER-VIOLET\n', 'utf8')
  return { root, binding: bindWorkspace({ id: 'WS1', root, identitySha256: DIGEST, writable }) }
}

function executor(bound: Awaited<ReturnType<typeof workspace>>, overrides: Partial<ExecutorConfig> = {}): ExecutorConfig {
  return {
    workspaces: [bound.binding],
    allowedTools: new Set(['read']),
    scripts: [],
    limits: { maxOutputBytes: 65_536, commandTimeoutMs: 30_000, maxEditBytes: 262_144 },
    ...overrides,
  }
}

function call(fence: TurnFence, body: Record<string, unknown>): string {
  return [
    `${FENCE}giana-tool`,
    JSON.stringify({ protocol: PROTOCOL_VERSION, workId: fence.workId, generation: fence.generation, ...body }),
    FENCE,
  ].join('\n')
}

function context(fence: TurnFence, config: ExecutorConfig, ledger = new EvidenceLedger()): BridgeContext {
  return {
    fence,
    objective: { cancelGeneration: fence.cancelGeneration, supersessionGeneration: fence.supersessionGeneration },
    executor: config,
    ledger,
  }
}

describe('turn fence', () => {
  it('binds the work id to the canonical session, watermarks, and generations', () => {
    const fence = mintTurnFence(binding, 4)
    expect(fence.workId).toMatch(/^W-[0-9A-F]{24}$/)
    expect(mintTurnFence(binding, 4).workId).toBe(fence.workId)
    expect(mintTurnFence({ ...binding, cancelGeneration: 1 }, 4).workId).not.toBe(fence.workId)
    expect(mintTurnFence({ ...binding, canonicalSessionId: 'other' }, 4).workId).not.toBe(fence.workId)
  })

  it('refuses a forged work id and a stale or future generation', () => {
    const fence = mintTurnFence(binding, 4)
    const objective = { cancelGeneration: 0, supersessionGeneration: 0 }
    const request = { protocol: PROTOCOL_VERSION, workId: fence.workId, generation: 1, tool: 'read' as const, workspaceId: 'WS1' }
    expect(() => { admitRequest(fence, { ...request, workId: 'W-FORGED' }, objective) }).toThrow('WORK_ID_MISMATCH')
    expect(() => { admitRequest(advanceFence(fence), request, objective) }).toThrow('STALE_GENERATION')
    expect(() => { admitRequest(fence, { ...request, generation: 9 }, objective) }).toThrow('FUTURE_GENERATION')
  })

  it('refuses a cancelled or superseded objective observed at admission time', () => {
    const fence = mintTurnFence(binding, 4)
    const request = { protocol: PROTOCOL_VERSION, workId: fence.workId, generation: 1, tool: 'read' as const, workspaceId: 'WS1' }
    expect(() => { admitRequest(fence, request, { cancelGeneration: 1, supersessionGeneration: 0 }) }).toThrow('OBJECTIVE_CANCELLED')
    expect(() => { admitRequest(fence, request, { cancelGeneration: 0, supersessionGeneration: 1 }) }).toThrow('OBJECTIVE_SUPERSEDED')
  })

  it('refuses a call once the hop budget is spent', () => {
    const fence = mintTurnFence(binding, 0)
    expect(() => {
      admitRequest(fence, {
        protocol: PROTOCOL_VERSION, workId: fence.workId, generation: 1, tool: 'read', workspaceId: 'WS1',
      }, { cancelGeneration: 0, supersessionGeneration: 0 })
    }).toThrow('HOP_BUDGET_EXHAUSTED')
  })

  it('returns the recorded entry for an identical repeat and refuses a conflicting one', () => {
    const ledger = new EvidenceLedger()
    const entry = { workId: 'W-1', generation: 1, toolCallSha256: DIGEST, resultSha256: DIGEST, evidenceId: 'E-1' }
    expect(ledger.accept(entry)).toBe(ledger.accept({ ...entry }))
    expect(() => { ledger.accept({ ...entry, resultSha256: 'b'.repeat(64) }) }).toThrow('REPLAY_CONFLICT')
    expect(ledger.list()).toHaveLength(1)
  })
})

describe('bounded read through the bridge', () => {
  it('returns hash-bound evidence for a safe marker and records it once', async () => {
    const bound = await workspace(false)
    const fence = mintTurnFence(binding, 4)
    const ledger = new EvidenceLedger()
    const hop = await runBridgeHop(
      `Reading it now.\n\n${call(fence, { tool: 'read', workspaceId: 'WS1', path: 'docs/marker.txt' })}`,
      context(fence, executor(bound), ledger),
    )

    expect(hop?.evidence.status).toBe('OK')
    expect(hop?.evidence.path).toBe('docs\\marker.txt')
    expect(hop?.evidence.contentSha256).toBe(sha256('MARKER-VIOLET\n'))
    expect(hop?.evidenceMessage).toContain('MARKER-VIOLET')
    expect(hop?.fence.generation).toBe(2)
    expect(ledger.list()).toHaveLength(1)
  })

  it('carries the next generation in every evidence block so a follow-up call never guesses', async () => {
    const bound = await workspace(false)
    const fence = mintTurnFence(binding, 4)

    const okHop = await runBridgeHop(
      call(fence, { tool: 'read', workspaceId: 'WS1', path: 'docs/marker.txt' }),
      context(fence, executor(bound)),
    )
    expect(okHop?.evidence.generation).toBe(1)
    expect(okHop?.evidence.nextGeneration).toBe(2)
    expect(okHop?.evidenceMessage).toContain('"nextGeneration":2')

    const refusedHop = await runBridgeHop(
      call(fence, { tool: 'read', workspaceId: 'WS1', path: '..' + '\\outside.txt' }),
      context(fence, executor(bound)),
    )
    expect(refusedHop?.evidence.status).toBe('REFUSED')
    expect(refusedHop?.evidence.nextGeneration).toBe(2)
    expect(refusedHop?.evidenceMessage).toContain('"nextGeneration":2')
  })

  it('reports nothing to do when the reply asked for nothing', async () => {
    const bound = await workspace(false)
    const fence = mintTurnFence(binding, 4)
    expect(await runBridgeHop('Plain reply.', context(fence, executor(bound)))).toBeUndefined()
  })

  it('returns a typed refusal to the principal instead of executing', async () => {
    const bound = await workspace(false)
    const fence = mintTurnFence(binding, 4)

    const escape = await runBridgeHop(
      call(fence, { tool: 'read', workspaceId: 'WS1', path: '..\\outside.txt' }),
      context(fence, executor(bound)),
    )
    expect(escape?.evidence.status).toBe('REFUSED')
    expect(escape?.evidence.refusal).toContain('PATH_ESCAPE')

    const unknownWorkspace = await runBridgeHop(
      call(fence, { tool: 'read', workspaceId: 'WS9', path: 'docs/marker.txt' }),
      context(fence, executor(bound)),
    )
    expect(unknownWorkspace?.evidence.refusal).toContain('WORKSPACE_UNKNOWN')

    const disallowed = await runBridgeHop(
      call(fence, { tool: 'edit', workspaceId: 'WS1', path: 'docs/marker.txt', content: 'x', preimageSha256: DIGEST }),
      context(fence, executor(bound)),
    )
    expect(disallowed?.evidence.refusal).toContain('TOOL_NOT_ALLOWED')
  })

  it('refuses a forged work id as fence evidence without touching the workspace', async () => {
    const bound = await workspace(false)
    const fence = mintTurnFence(binding, 4)
    const forged = [
      `${FENCE}giana-tool`,
      JSON.stringify({
        protocol: PROTOCOL_VERSION, workId: 'W-FORGED', generation: 1, tool: 'read', workspaceId: 'WS1', path: 'docs/marker.txt',
      }),
      FENCE,
    ].join('\n')
    const hop = await runBridgeHop(forged, context(fence, executor(bound)))
    expect(hop?.evidence.status).toBe('REFUSED')
    expect(hop?.evidence.refusal).toBe('WORK_ID_MISMATCH')
    expect(hop?.evidence.body).toBeUndefined()
  })

  it('refuses a malformed block as typed evidence', async () => {
    const bound = await workspace(false)
    const fence = mintTurnFence(binding, 4)
    const hop = await runBridgeHop(`${FENCE}giana-tool\nnot json\n${FENCE}`, context(fence, executor(bound)))
    expect(hop?.evidence.refusal).toBe('MALFORMED_TOOL_CALL')
    expect(hop?.evidence.tool).toBe('none')
  })
})

describe('bounded edit through the bridge', () => {
  it('refuses a write into a read-only workspace', async () => {
    const bound = await workspace(false)
    const fence = mintTurnFence(binding, 4)
    const hop = await runBridgeHop(
      call(fence, { tool: 'edit', workspaceId: 'WS1', path: 'docs/marker.txt', content: 'X', preimageSha256: sha256('MARKER-VIOLET\n') }),
      context(fence, executor(bound, { allowedTools: new Set(['read', 'edit']) })),
    )
    expect(hop?.evidence.refusal).toContain('WORKSPACE_NOT_WRITABLE')
    expect(await readFile(join(bound.root, 'docs', 'marker.txt'), 'utf8')).toBe('MARKER-VIOLET\n')
  })

  it('refuses a stale pre-image rather than discarding a concurrent change', async () => {
    const bound = await workspace(true)
    const fence = mintTurnFence(binding, 4)
    const hop = await runBridgeHop(
      call(fence, { tool: 'edit', workspaceId: 'WS1', path: 'docs/marker.txt', content: 'X', preimageSha256: DIGEST }),
      context(fence, executor(bound, { allowedTools: new Set(['read', 'edit']) })),
    )
    expect(hop?.evidence.refusal).toContain('PREIMAGE_MISMATCH')
    expect(await readFile(join(bound.root, 'docs', 'marker.txt'), 'utf8')).toBe('MARKER-VIOLET\n')
  })

  it('writes and reports both image digests when the pre-image matches', async () => {
    const bound = await workspace(true)
    const fence = mintTurnFence(binding, 4)
    const hop = await runBridgeHop(
      call(fence, {
        tool: 'edit', workspaceId: 'WS1', path: 'docs/marker.txt', content: 'MARKER-INDIGO\n', preimageSha256: sha256('MARKER-VIOLET\n'),
      }),
      context(fence, executor(bound, { allowedTools: new Set(['read', 'edit']) })),
    )
    expect(hop?.evidence.status).toBe('OK')
    expect(hop?.evidence.preimageSha256).toBe(sha256('MARKER-VIOLET\n'))
    expect(hop?.evidence.postimageSha256).toBe(sha256('MARKER-INDIGO\n'))
    expect(await readFile(join(bound.root, 'docs', 'marker.txt'), 'utf8')).toBe('MARKER-INDIGO\n')
  })
})

describe('script execution stays operator-owned', () => {
  it('refuses a script the operator did not grant', async () => {
    const bound = await workspace(false)
    const fence = mintTurnFence(binding, 4)
    const hop = await runBridgeHop(
      call(fence, { tool: 'test', workspaceId: 'WS1', script: 'rm -rf /' }),
      context(fence, executor(bound, { allowedTools: new Set(['read', 'test']) })),
    )
    expect(hop?.evidence.refusal).toContain('SCRIPT_NOT_ALLOWED')
  })

  it('runs only the granted command and reports its exit code and bounded output', async () => {
    const bound = await workspace(false)
    const fence = mintTurnFence(binding, 4)
    const hop = await runBridgeHop(
      call(fence, { tool: 'test', workspaceId: 'WS1', script: 'marker-check' }),
      context(fence, executor(bound, {
        allowedTools: new Set(['read', 'test']),
        scripts: [{
          id: 'marker-check',
          command: process.execPath,
          args: ['-e', 'process.stdout.write("SCRIPT-OK")'],
          tool: 'test',
          workspaceId: 'WS1',
        }],
      })),
    )
    expect(hop?.evidence.status).toBe('OK')
    expect(hop?.evidence.exitCode).toBe(0)
    expect(hop?.evidence.body).toContain('SCRIPT-OK')
  })

  it('reports a failing script as FAILED with its exit code', async () => {
    const bound = await workspace(false)
    const fence = mintTurnFence(binding, 4)
    const hop = await runBridgeHop(
      call(fence, { tool: 'build', workspaceId: 'WS1', script: 'failing' }),
      context(fence, executor(bound, {
        allowedTools: new Set(['read', 'build']),
        scripts: [{
          id: 'failing',
          command: process.execPath,
          args: ['-e', 'process.stdout.write("BOOM"); process.exit(3)'],
          tool: 'build',
          workspaceId: 'WS1',
        }],
      })),
    )
    expect(hop?.evidence.status).toBe('FAILED')
    expect(hop?.evidence.exitCode).toBe(3)
  })
})

describe('canonical knowledge proposal', () => {
  it('carries only references and never authorizes its own write', async () => {
    const bound = await workspace(false)
    const fence = mintTurnFence(binding, 4)
    const ledger = new EvidenceLedger()
    const hop = await runBridgeHop(
      call(fence, { tool: 'read', workspaceId: 'WS1', path: 'docs/marker.txt' }),
      context(fence, executor(bound), ledger),
    )
    const proposal = proposeCanonicalKnowledge(hop!.fence, ledger)

    expect(proposal).toMatchObject({
      principalId: 'giana.putri',
      surfaceId: 'deepseek-harness',
      writeMode: 'PROPOSE_TO_CANONICAL_MEMORY_WRITER',
      writeAuthorized: false,
      rawTranscriptIncluded: false,
    })
    expect(canonicalJson(proposal)).not.toContain('MARKER-VIOLET')
    expect(proposal?.artifactLedgerSha256).toBe(sha256(canonicalJson(ledger.list())))
  })

  it('proposes nothing when the turn accepted no result', () => {
    expect(proposeCanonicalKnowledge(mintTurnFence(binding, 4), new EvidenceLedger())).toBeUndefined()
  })
})
