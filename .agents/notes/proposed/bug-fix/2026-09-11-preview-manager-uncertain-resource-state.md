# Agent Note: Preview manager uncertain resource state

Status: proposed

## Problem

The initial isolated preview model manager could infer empty GPU residency from failed HTTP requests, reuse expired ownership while a command remained unresolved, and count configured reclaimable memory when required GPU telemetry was absent. Those defects are corrected in staging, but package evidence does not demonstrate exclusive switching authority on a shared host.

## Proposal

Keep the manager unmounted until shared-host mutation authority is enforced. Current staging retains unresolved and quarantined leases, rejects uncovered target descriptors and overlapping transactions, stops state operations after persistence failure, classifies unsuccessful mutations as uncertain, validates complete telemetry, measures route-owned reclamation and repeats the capacity check before start. These corrections do not confer shared-host authority.

Exact process and allocation evidence now replaces HTTP-based empty inference. Route-bound recovery, durable request replay, restart reconciliation and complete stage deadlines are implemented. A single shared mutation owner must still enforce fencing at the executor, and drain must include unrelated endpoint clients before activation. Existing lifecycle and Server Manager interfaces remain the integration points; canonical Putri and speech services are outside this package's ownership.

## Alternatives considered

- Treat connection refusal as an unloaded model: rejected because a booting or unhealthy process may still occupy GPU memory.
- Release an expired lease automatically: rejected while a command or transaction remains unresolved.
- Present adapter fixtures as production acceptance: rejected because they cannot prove real resource ownership or user-visible switching.

## Acceptance criteria

Fault-injection cases must reject unknown residency, concurrent conflicting mutations, expired dispatch, persistence failure and incomplete telemetry without losing recovery ownership. Boot the actual isolated profile through the Loader with mocked external services for deterministic session-visible coverage. Subsequently validate current remote process/resource identity and perform authorized GCP end-to-end switching, rollback, protected DOTS preservation and session continuity before portable release.

## Risks

The current staging patches intentionally leave the package disabled. Local exclusion does not prevent another process from mutating the GPU; a registry flag does not prove drain; cached HTTP failure does not prove absence. False claims of readiness remain a release risk until all executor and application-composition checks pass.
