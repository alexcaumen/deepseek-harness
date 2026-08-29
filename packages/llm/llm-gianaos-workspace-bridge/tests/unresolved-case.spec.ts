/**
 * The exact case that motivated this bridge: the operator asked the canonical
 * principal to read a Windows path on PRDG, and she correctly reported that her
 * R5300 runtime has no such volume. These tests run that same request through
 * the bridge against the real file, and prove the reference tree stays
 * unwritable.
 *
 * The file is a read-only diagnostic reference, so the tests read it and assert
 * on its recorded size and digest only.
 */

import { stat } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { runBridgeHop } from '../src/bridge.ts'
import type { ExecutorConfig } from '../src/executor.ts'
import { PROTOCOL_VERSION } from '../src/protocol.ts'
import { EvidenceLedger, mintTurnFence, type CanonicalTurnBinding } from '../src/turn-fence.ts'
import { bindWorkspace } from '../src/workspace.ts'

const DIGEST = 'a'.repeat(64)
const FENCE = '```'

const REFERENCE_ROOT = 'F:\\BIG-KNOWLEDGE\\KIRANA_TOTAL_AI_STUDIO_SURFACE_EXECUTION_20260815_001'
const REFERENCE_RELATIVE = 'LARA_TOTAL_SURFACE_HANDOFF_20260816_001\\LARA_TOTAL_SURFACE_EXECUTION_HANDOFF_20260816.md'
const REFERENCE_BYTES = 44_382
const REFERENCE_SHA256 = '274435227EEBE4B274AD77119AA6F3346EDFC1FDD7CDA108C09930E6C6EE2A1A'

const binding: CanonicalTurnBinding = {
  principalId: 'giana.putri',
  canonicalSessionId: 'deepseek-harness:session-unresolved',
  surfaceId: 'deepseek-harness',
  sourceWatermark: DIGEST,
  conversationWatermark: DIGEST,
  cancelGeneration: 0,
  supersessionGeneration: 0,
  authorizationEpoch: 1,
}

/** Whether the recorded reference file is present on this host. */
async function referencePresent(): Promise<boolean> {
  try {
    return (await stat(`${REFERENCE_ROOT}\\${REFERENCE_RELATIVE}`)).isFile()
  } catch {
    return false
  }
}

describe('the PRDG file the canonical runtime could not reach', () => {
  it('reads it through the bridge and reports its exact size and digest', async ({ skip }) => {
    if (!await referencePresent()) skip()

    const workspace = bindWorkspace({
      id: 'REF',
      root: REFERENCE_ROOT,
      identitySha256: DIGEST,
      writable: false,
    })
    const executor: ExecutorConfig = {
      workspaces: [workspace],
      allowedTools: new Set(['read']),
      scripts: [],
      limits: { maxOutputBytes: 4_096, commandTimeoutMs: 30_000, maxEditBytes: 1_024 },
    }
    const fence = mintTurnFence(binding, 4)
    const hop = await runBridgeHop([
      `${FENCE}giana-tool`,
      JSON.stringify({
        protocol: PROTOCOL_VERSION,
        workId: fence.workId,
        generation: fence.generation,
        tool: 'read',
        workspaceId: 'REF',
        path: REFERENCE_RELATIVE,
      }),
      FENCE,
    ].join('\n'), {
      fence,
      objective: { cancelGeneration: 0, supersessionGeneration: 0 },
      executor,
      ledger: new EvidenceLedger(),
    })

    expect(hop?.evidence.status).toBe('OK')
    expect(hop?.evidence.path).toBe(REFERENCE_RELATIVE)
    expect(hop?.evidence.sourceBytes).toBe(REFERENCE_BYTES)
    expect(hop?.evidence.contentSha256).toBe(REFERENCE_SHA256)
    // The body is bounded well below the file size, so the canonical runtime
    // receives evidence rather than a whole document.
    expect(hop?.evidence.truncated).toBe(true)
    expect(Buffer.byteLength(hop?.evidence.body ?? '', 'utf8')).toBeLessThanOrEqual(4_096)
  })

  it('refuses a write into the reference tree even when configured writable', async () => {
    const workspace = bindWorkspace({
      id: 'REF',
      root: REFERENCE_ROOT,
      identitySha256: DIGEST,
      writable: true,
    })
    expect(workspace.writable).toBe(false)

    const fence = mintTurnFence(binding, 4)
    const hop = await runBridgeHop([
      `${FENCE}giana-tool`,
      JSON.stringify({
        protocol: PROTOCOL_VERSION,
        workId: fence.workId,
        generation: fence.generation,
        tool: 'edit',
        workspaceId: 'REF',
        path: REFERENCE_RELATIVE,
        content: 'overwritten',
        preimageSha256: REFERENCE_SHA256,
      }),
      FENCE,
    ].join('\n'), {
      fence,
      objective: { cancelGeneration: 0, supersessionGeneration: 0 },
      executor: {
        workspaces: [workspace],
        allowedTools: new Set(['read', 'edit']),
        scripts: [],
        limits: { maxOutputBytes: 4_096, commandTimeoutMs: 30_000, maxEditBytes: 1_024 },
      },
      ledger: new EvidenceLedger(),
    })

    expect(hop?.evidence.status).toBe('REFUSED')
    expect(hop?.evidence.refusal).toContain('WORKSPACE_NOT_WRITABLE')
  })

  it('refuses a traversal out of the reference tree toward the canonical roots', async () => {
    const workspace = bindWorkspace({ id: 'REF', root: REFERENCE_ROOT, identitySha256: DIGEST, writable: false })
    const fence = mintTurnFence(binding, 4)
    const hop = await runBridgeHop([
      `${FENCE}giana-tool`,
      JSON.stringify({
        protocol: PROTOCOL_VERSION,
        workId: fence.workId,
        generation: fence.generation,
        tool: 'read',
        workspaceId: 'REF',
        path: '..\\..\\..\\GianaOS\\profiles\\putri\\SOUL.md',
      }),
      FENCE,
    ].join('\n'), {
      fence,
      objective: { cancelGeneration: 0, supersessionGeneration: 0 },
      executor: {
        workspaces: [workspace],
        allowedTools: new Set(['read']),
        scripts: [],
        limits: { maxOutputBytes: 4_096, commandTimeoutMs: 30_000, maxEditBytes: 1_024 },
      },
      ledger: new EvidenceLedger(),
    })

    expect(hop?.evidence.status).toBe('REFUSED')
    expect(hop?.evidence.refusal).toContain('PATH_ESCAPE')
    expect(hop?.evidence.body).toBeUndefined()
  })
})
