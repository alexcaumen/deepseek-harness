# Agent Note: Bounded post-mutation compensation

Status: implemented

## Problem

The runtime restores the source after cancellation following verified source stop, and after definite READY or effective-route publication failure. The manager's destination-only start transition and terminal successful probe rejected those restores. Loader composition with the real runtime, adapter and durable manager reproduces all three paths as `ROLLBACK_FAILED` before alignment.

## Decision

The existing driver gains an optional activation-settlement hook, implemented by the existing Server Manager adapter and manager. Physical probe success remains pending until READY and session publication succeed. COMMIT closes that transaction before inference admission. COMPENSATE authorizes one route-bound cleanup/restoration path using the original lease, fence, transaction, scope, destination identity and acknowledged sequence. It cannot reopen a committed transaction or bypass original signed eviction consent. Read-only resident adoption can settle rejected publication without gaining stop permission.

The runtime detaches settlement from caller cancellation while retaining its configured operation deadline and resource-loss signal. Unknown audit settlement, unresolved stage replies and lost commit replies quarantine ownership without undoing a potentially published route. A definite audit failure can restore the source while retaining audit taint. Failed compensation stages end recovery permission; the runtime quarantines rather than retrying restoration.

## Alternatives

Allowing arbitrary source start after verify-stopped or stop after any terminal probe would also reopen committed transactions. A new rollback transaction would lose the original source/prestate and consent relationship. Implicit commit during resource release cannot distinguish unpublished readiness from successful publication. These alternatives are not used.

## Verification and limits

Package Loader tests use the real runtime, adapter, manager, receipt validation and durable state store; only host execution and approval/audit outcomes are fixtures. Coverage includes cancellation after source stop and destination start/probe, definite publication failures, unknown READY settlement, lost probe/commit/compensation replies, single-attempt restoration, successful commit, signed eviction, stale settlement rejection, durable restart validation and non-mutating adoption settlement. The focused lifecycle and adapter suites remain required. These checks perform no model loads, GPU operations or remote mutations and do not certify native-wrapper, live-host or desktop acceptance.

Manager transaction records require the explicit settlement field. Existing records without it need owner reconciliation outside this change; there is no state reset, migration or automatic promotion. The runtime retains existing conservative quarantine when no resident survives a post-mutation failure. Final application snapshots and candidate-wrapper verification belong to the parent task, outside the package write scope.
