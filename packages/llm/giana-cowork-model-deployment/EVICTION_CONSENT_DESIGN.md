# GCP resident-model eviction consent design

Status: design only. No source implementation or live GPU admission is implied.

## Current boundary

- Model selection (`ui-model-selection` -> `session.selectModel`) stores provider/model intent. The first subsequent `llm/stream` acquisition may drain and stop a different active route. Selection must never count as eviction consent.
- `dsh-user-approval.request()` can ask during an open agent turn, but returns only an outcome. Its durable `approval/asked` and `approval/decided` events have no structured source/destination, prestate, scope, transaction, expiry, or transferable decision receipt. The answerer renders `toolName` and `reason`; those strings are presentation, not a manager-verifiable authorization.
- The Server Manager adapter sends only stage/route/revision/transaction/target data. The preview manager accepts `drain -> stop` without an approval artifact. Its durable state and replay validator have no consumed-grant field.
- Idle unload defaults to five minutes and shutdown may stop an active route outside an open turn. The existing approval service rejects out-of-turn requests. These operations need separate explicit policy, not a reused switch grant.

## Required opt-in contract

1. Add a GCP-only eviction policy hook to the lifecycle authority. Leave an absent hook's generic behavior unchanged. Invoke it only after the destination and source prestates are verified and before draining a *different owned resident* route. Same-route reuse, exact adoption, and empty-slot start must not ask.
2. Extend the approval seam to return an audited one-shot decision receipt with a service-issued ID and structured action identity. The visible prompt must name source and destination model/route and state that the resident model will be stopped. Bind the decision to principal, tenant, work, live session, scope digest, transaction digest, source and destination IDs/revisions/targets, source and destination prestate receipt digests, and an absolute expiry. A display string or the old `allowed-once` outcome alone is insufficient. The owner must only mint a grant after an explicit user answer, never from selection, a default, or an automation policy.
3. Introduce an authenticated, versioned GCP manager authorization operation or verifiable signed grant. The manager must persist the exact grant identity and binding under its transaction and host fence, reject absent/expired/replayed/mismatched grants, recheck exact residency immediately before stop, and atomically consume the grant before the fenced mutation. Fail closed if persistence, expiry, identity, telemetry, or authority verification is uncertain. Do not infer approval from successful preflight, drain, lease possession, or the static admission receipt.
4. Keep the grant transaction-scoped across the existing drain/stop sequence. A rejected, cancelled, unavailable, or timed-out question must end before drain and leave the source resident. A late answer must not reactivate an expired transaction. A rollback stop of a newly started destination is cleanup, not authorization to evict another pre-existing owned resident; document and test that distinction.
5. Give GCP idle unload and shutdown explicit separate policy. Disable idle unload in GCP until an approved unattended-unload policy exists. Shutdown cannot call the turn-only approval service; it must either preserve the resident route under a separately admitted handoff/lease policy or use a distinct owner-approved shutdown mechanism. Do not silently stop it. Generic lifecycle defaults remain unchanged.

## Minimum tests before activation

- Selector and compute preference updates do not prompt or stop a model; a later different-route acquisition does.
- Approval prompt names exact source/destination; explicit rejection, cancellation, unavailable answerer, timeout, and late answer leave the source resident with no drain/stop.
- One valid grant allows one matching switch and is consumed at the manager stop gate; repeat with new idempotency key, process restart, or replayed grant is rejected.
- Wrong session/principal/scope/transaction, route/revision/target, prestate digest, fence, expiry, or changed physical residency rejects at the manager before mutation.
- Same-route reuse, exact adoption, empty-slot start, non-GCP lifecycle, and ordinary tool approvals retain current behavior.
- Idle timer and shutdown follow their separately chosen GCP policy; neither consumes a switch grant or silently evicts.
- Exercise the full UI answerer -> durable decision -> adapter -> manager path with fake host commands, then obtain separate authorized live GPU and desktop HEQA. Fixture success is not live-switch authorization.

## Existing constraints

The current preview receipt admits only `glm53-official-fp8` and `qwen38-local` on R5300 for isolated staging. It is not per-switch user consent. No PRDG route or RAM/CPU target is configured, regardless of the generic selector and GLM offload flag. Do not expand route admission as part of the consent change.
