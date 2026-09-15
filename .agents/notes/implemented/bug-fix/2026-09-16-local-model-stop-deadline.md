# Agent Note: Bound local-model stop beyond host cleanup

English | [中文](2026-09-16-local-model-stop-deadline.zh.md)

Status: implemented

## Problem

The preview lifecycle used the global three-minute stage deadline while its transient systemd units could spend the same three minutes stopping a model. Drain and endpoint handoff consumed part of the lifecycle deadline first, so the caller could time out moments before systemd completed its owned cleanup. Automatic routing also reported a definite resource-lease rejection as `NO_CAPACITY`, hiding contention behind a false GPU-capacity diagnosis.

## Decision

Giana CoWork Preview routes receive a six-minute `stop` deadline and a three-and-a-half-minute `verify-stopped` deadline. These route-level deadlines cover pre-stop drain, the existing systemd cleanup interval, and observation margin without changing host kill policy. Automatic routing continues to the next admitted target after a definite target-lease rejection, but if no candidate succeeds it returns `RESOURCE_TARGET_UNAVAILABLE`; `NO_CAPACITY` remains reserved for completed preflight capacity rejection.

## Alternatives considered

**Shorten the systemd cleanup interval.** This would hide the lifecycle deadline mismatch by reducing the model's opportunity to exit cleanly and would alter host teardown policy without evidence that a shorter interval is safe.

**Treat the late stop as success.** The manager cannot claim success after its own deadline because the remote mutation may still be unsettled. Extending the owning stage preserves fail-closed semantics and lets the existing receipt record the real outcome.

**Keep mapping lease contention to `NO_CAPACITY`.** Lease ownership and hardware capacity have different recovery actions. Preserving the lease error prevents unnecessary model eviction or GPU reset advice.

## Consequences

An approved switch may wait longer while an existing model drains, but the lifecycle remains bounded by the route deadline and the existing operation and lease limits. Focused tests distinguish lease rejection from measured capacity exhaustion. Native qualification must still prove the stop, verify, start, health, probe, rollback, and protected-DOTS path on the exact portable candidate.
