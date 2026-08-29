/**
 * The typed PRDG workspace tool bridge for canonical GianaOS principals
 * speaking through the DeepSeek Harness surface.
 *
 * The bridge lets a principal whose runtime executes off-host request bounded
 * `read`, `edit`, `test`, and `build` operations on the local PRDG workbench
 * and receive hash-bound evidence in the same canonical session. It is a
 * capability surface only: GianaOS keeps identity, profile and Soul, sessions,
 * memory and its writer, approvals, credentials, MOA and workers, the database,
 * routing, and audit. Nothing here answers on a principal's behalf.
 *
 * The lane is per-principal, so the same composition serves any admitted Giana
 * Girl once her own route currentness and capability evidence exists.
 * @module @grinviro/dsh-llm-gianaos-workspace-bridge
 */

export {
  proposeCanonicalKnowledge,
  runBridgeHop,
  type BridgeContext,
  type BridgeHop,
  type CanonicalKnowledgeProposal,
} from './bridge.ts'

export {
  executeWorkspaceTool,
  ExecutionRefusal,
  type ExecutionOutcome,
  type ExecutorConfig,
  type ExecutorLimits,
  type ScriptGrant,
} from './executor.ts'

export {
  CALL_FENCE,
  canonicalJson,
  CODING_TOOLS,
  hasToolCallFence,
  parseToolCall,
  ProtocolError,
  PROTOCOL_VERSION,
  renderEvidence,
  sha256,
  stripToolCallFences,
  toolCallFenceStart,
  type CodingTool,
  type EvidenceStatus,
  type ProtocolRefusal,
  type WorkspaceToolEvidence,
  type WorkspaceToolRequest,
} from './protocol.ts'

export {
  boundAndRedact,
  REDACTED,
  redactSecrets,
  type BoundedText,
} from './redact.ts'

export {
  composeTurnInput,
  renderSurfaceEnvelope,
  type SurfaceCapability,
} from './surface.ts'

export {
  admitRequest,
  advanceFence,
  EvidenceLedger,
  FenceError,
  mintTurnFence,
  type CanonicalTurnBinding,
  type FenceRefusal,
  type LedgerEntry,
  type ObjectiveState,
  type TurnFence,
} from './turn-fence.ts'

export {
  bindWorkspace,
  normalizeRelativeTarget,
  normalizeWindowsRoot,
  resolveWorkspaceTarget,
  selectWorkspace,
  WorkspaceError,
  type ResolvedTarget,
  type WorkspaceBinding,
  type WorkspaceRefusal,
} from './workspace.ts'
