# Agent Note: Governed local-model lifecycle

Status: implemented

English | [中文](2026-09-04-governed-local-model-lifecycle.zh.md)

## Problem

A local-model inference can require capacity admission, draining requests, stopping one runtime, starting another, checking health and capabilities, and restoring the previous model after failure. Performing that work when a user merely selects a model can evict a resource while another inference still holds it. Reusing the speech compute controller would also mix the local-model lifecycle with the independent STT and TTS route.

The controller must preserve governance identity and request order without becoming a second model-selection authority. It also cannot treat a timed-out host operation, an unverified cleanup, or a failed audit write as if physical resource state were known.

## Decision

`@deepseek-ai/dsh-model-lifecycle` owns one serialized, process-local large-model slot. The LLM service remains the sole provider/model selection authority. One installed `ModelLifecycleAuthority` supplies coarse provider classification, governed route and execution-scope resolution, and sanitized audit persistence; `register()` binds an immutable admitted route copy to a host-specific driver. Provider classification occurs before the local FIFO. An `UNMANAGED_EXTERNAL` selection receives an inert lease without entering that FIFO, while a `GOVERNED_LOCAL` selection enters the FIFO before asynchronous authority resolution so a faster later resolution cannot overtake an earlier request.

At the head of the FIFO, the runtime rejects a tainted slot before asking the authority to resolve the request. A governed result must match a registered route's id, provider/model pair, admission digest, revision digest, `AVAILABLE` disposition, and admitted reasoning effort before any driver operation. Its execution scope contains non-empty `workId`, `principalId`, `tenantId`, and `sessionId` values. The runtime recomputes the canonical lowercase SHA-256 digest from those four values in that order with NUL separators, rejects a mismatch or a requested-session mismatch, and freezes the resolved scope copy for the transaction. `HELD`, inconsistent, unregistered, and unavailable routes fail before resource work.

Automatic target selection considers only targets declared by the admitted route, in fixed R5300, PRDG, then RAM/CPU order. RAM/CPU is considered only when the route both declares `ram-cpu` and sets `allowRamCpuOffload`; each candidate must return a successful capacity preflight. An explicit unavailable decision advances Automatic to the next admitted candidate, while a preflight error or timeout terminates the request. Manual `r5300` or `prdg` intent probes only that target and returns `MANUAL_TARGET_UNAVAILABLE` instead of falling back.

After target preflight succeeds, the runtime captures prestate. A real switch then drains the previous route, stops it, verifies it stopped, starts the selected target, verifies health, and performs a capability probe. The runtime persists a `READY` audit record before adapter iteration begins. Reusing the same registered route and target performs preflight, prestate capture, and health verification without stop, start, or capability probe. The managed lease remains held through the complete asynchronous `llm/stream`; `finally` attempts to record `RELEASED` and releases the FIFO position so another managed request cannot unload the active model mid-inference. Cancellation while queued removes its waiting entry immediately and does not starve later requests.

Every host-driver invocation receives its own absolute `deadlineAt` and an owned cancellation signal bounded by `stageTimeoutMs`. Successful `prestate`, `preflight`, `drain`, `stop`, `verify-stopped`, `start`, `health`, and `probe` results carry a structured `ModelLifecycleStageReceipt`. The runtime requires each receipt to name the expected stage, route id, target, revision digest, scope digest, and transaction digest and to include a lowercase SHA-256 receipt digest. A parent abort cancels the bounded signal; expiration aborts it and returns `STAGE_TIMEOUT` even if the driver has not settled.

A non-timeout failure after a stop or start attempt first stops and verifies the target, then restarts and verifies the previous route when one existed. Verified restoration retains the previous resource and reports the rolled-back or rejected outcome. Any stage timeout sets the slot to `TAINTED`; target cleanup that cannot prove `verify-stopped`, failure to restore and verify the previous route, or failure of the authority's audit persistence also taints the slot. Audit failure while releasing a completed inference does not invalidate that completed output, but it still cancels idle unload and fail-closes every later governed-local acquisition with `RUNTIME_TAINTED`. The runtime exposes no speculative continuation or automatic untaint path; host reconciliation or an orderly runtime restart is required.

After a successful release, `minimumDwellMs` and `idleUnloadMs` may schedule an idle unload under the same FIFO. The unload captures prestate, stops the active route, verifies it stopped, and records `IDLE_UNLOADED`; zero `idleUnloadMs` disables the timer. A timed-out unload or an unload whose failed restore cannot re-establish a verified state also leaves the slot `TAINTED`.

The package exports the authority, route, scope, receipt, driver, and runtime interfaces, but it supplies no concrete governance authority, admitted route registration, or host driver. Loading the package alone does not register or promote a route, make a held or disabled route `AVAILABLE`, choose a default model, or establish that any model is live or production-ready. Host process commands, resource discovery, model paths, credentials, and deployment admission remain outside the controller. The service neither calls nor configures the speech compute endpoint.

## Verification

The inference FIFO bounds both pending count and waiting time. Cancelled or expired waiters are removed immediately rather than retained as promise-chain nodes behind a long-running stream. Admission failure never aborts the active model. Internal teardown keeps FIFO ordering without inference admission limits, because overload cannot authorize skipping cleanup.

Fresh target occupancy is required before activation, reuse, idle unload, and shutdown; cross-target switches inspect the previous host too. A new process cannot assume the GPU is empty merely because its in-memory active route is absent. Mismatched or unknown occupancy returns `RESIDENCY_UNVERIFIED` and suppresses speculative cleanup, including teardown. This is conservative rejection, not automatic adoption or distributed exclusion. The deployment owner still supplies fencing and authoritative reconciliation.

Per-route `stageTimeoutsMs` budgets are immutable and part of authority/registration equality. A cold model may need a substantially longer start than ordinary health or scope-resolution operations; a single enlarged global timeout would delay unrelated failures. Only explicitly overridden stages use the route budget, including rollback starts. Defaults remain unchanged.

Focused runtime tests cover provider classification before FIFO admission, ordered asynchronous authority resolution, exact scope-digest validation, route-identity rejection before driver work, receipt binding, target precedence, manual no-fallback behavior, stage ordering, whole-stream serialization, rollback, explicit stage timeout, taint after timed-out mutation or unverified cleanup, audit-authority failure, queued cancellation, and idle unload. These tests use fixture authorities, routes, and drivers; they do not demonstrate a deployed host driver or a live or production route.

Additional fixtures cover two independent app contexts observing existing residency, changed occupancy before unload, failed shutdown inspection, both targets in a switch, and long-start budget isolation. A real YAML Loader composition drives the shipping agent loop and pins both successful assistant output and a sanitized residency failure in the session log. Its model and host are deterministic fixtures, not live inference or global-controller evidence.

## Alternatives considered

**Retain cancelled promise-chain waiters.** Rejected because repeated cancellation behind a long-running inference retains unbounded closures even when the apparent pending count is capped. An explicit removable FIFO bounds retained waiters and permits immediate replacement after timeout or cancellation.

**Reuse speech compute routing.** Rejected because STT and TTS availability does not establish LLM payload, memory, runtime, scope, or admission readiness. A shared controller would combine unrelated resource and governance responsibilities.

**Resolve governed routes before entering FIFO.** Rejected because asynchronous resolution would let a faster later request overtake an earlier request. Only coarse provider classification occurs before FIFO so ordinary external providers avoid local serialization.

**Put switching inside each model adapter.** Rejected because adapters cannot serialize one scarce slot across providers. The shared `llm/stream` boundary spans exact adapter iteration without making the lifecycle runtime a model-selection authority.

**Switch resources when the user selects a model.** Rejected because selection records intent and may occur while another inference still holds the current resource.

**Hard-code routes, model paths, processes, or host commands in the controller.** Rejected because deployment authority and host-specific drivers own those facts. The shared runtime owns ordering, transaction binding, leases, deadlines, and failure state, not infrastructure discovery, credentials, or route promotion.

## Consequences

Governed local-model inference has one provider-neutral transaction coordinator while the LLM service retains model selection and an external authority retains classification, scope, admission, and audit ownership. Ordinary external providers avoid the local FIFO. A managed request either reaches a receipt-bound ready state, restores a verified prior state where possible, or fail-closes the process-local slot as `TAINTED` when the physical or audit state is uncertain.

Local serialization coordinates callers in one Host process. Governed host work additionally requires a deployment-issued resource lease covering the registered available candidate targets, retained during idle residency. The provider owns authentication, admission, physical coverage and fencing; the consumer owns bounded acquisition, renewal, expiry and best-effort release. Every stage carries the current grant and its receipt binds the fence. Lost ownership cancels work and suppresses speculative cleanup; local `SETTLED` release never authorizes physical reassignment. No production issuer or server protocol is implemented in this package.

The agent loop freezes model request envelopes. Resource cancellation is therefore contributed at `llm/dispatch-signal` after stream admission, not assigned to `GenerateOptions.signal`. Only the transport envelope receives a composed cancellation signal, preserving caller cancellation, message identity, content and prepared adapter binding. The real YAML composition verifies that this integration reaches assistant output and releases its local lock, while fault-injection tests verify renewal loss during inference and two-context resource arbitration. These are staged fixtures, not evidence of deployed exclusion or live inference.
