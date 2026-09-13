# Model lifecycle

English | [中文](README.zh.md)

`@deepseek-ai/dsh-model-lifecycle` is the provider-neutral execution boundary for governed local models. It owns one serialized large-model slot, dynamic target admission, inference leases, and rollback. The LLM service remains the sole provider/model selection authority. Host-specific GPU, RAM, CPU, process, launch, and health mechanics remain behind registered drivers.

The service is deliberately separate from speech routing. It neither calls nor configures the STT/TTS compute endpoint, and it carries no model payload paths or credentials.

## Service contract

`ctx.modelLifecycle.installAuthority()` installs the sole provider classifier, route/scope resolver, and sanitized audit sink. `ctx.modelLifecycle.installResources()` separately installs the sole deployment-owned shared resource lease provider, so a Server Manager adapter cannot gain route, scope, or audit authority merely by supplying host mechanics. `register()` then attaches host mechanics to one immutable route. External providers are classified before the local FIFO; governed-local requests enter the FIFO before asynchronous resolution, so a faster later resolver cannot overtake an earlier request. Resolution and audit persistence receive the runtime-owned cancellation signal and must stop remote work when their deadline expires. The authority must resolve the same provider/model, route identity, admission digest, and revision digest as the registered driver. Governed routes with missing or mismatched authority, scope, admission, or driver data fail closed before resource work; ordinary external providers remain unmanaged.

`acquireRoute()` serializes managed inference. Its durable `preference` setting accepts `automatic`, `r5300`, or `prdg`. Automatic routing probes R5300 first, then PRDG, then RAM/CPU only when the route manifest explicitly permits offload. Manual R5300 or PRDG intent probes only that target and returns a typed failure instead of silently dispatching elsewhere. Every managed acquisition carries an immutable work, principal, tenant, and session scope whose canonical digest is recomputed before resource work.

The service wraps `llm/stream`, after a complete provider/model request exists. For a real switch, it performs capacity preflight before capturing prestate, then runs bounded drain, stop and post-stop verification, exact-revision start, health, and capability probes before adapter iteration. `stageTimeoutMs` gives every host-driver call an explicit deadline and required cancellation signal; drivers must honor that signal. Each stage receipt must match the route, target, revision, scope, and transaction. Rollback stages retain the current `MODEL_ROUTE` transaction kind, scope, and digest rather than creating a second rollback transaction. The returned lease remains held through the complete asynchronous stream and releases in `finally`, so another managed request cannot unload the active model mid-inference. A verified partial failure restores the previous healthy route. A timed-out mutating operation, unverified cleanup, rollback failure, or audit-authority failure instead taints the local slot and prevents later governed-local work until host reconciliation or an orderly runtime restart; the controller never races a speculative rollback against an operation whose physical state is unknown. A definite `READY` audit rejection executes verified rollback, while a timed-out `READY` write preserves the physically ready route under `TAINTED` quarantine because it may settle late; late settlement triggers a bounded `TAINTED/AUDIT_FAILED` compensation attempt for the same transaction.

`minimumDwellMs` and `idleUnloadMs` govern anti-thrashing. After the last inference lease releases, the service arms one owned timer, waits for both limits, then stops and verifies the idle route under the same serialized slot. Zero `idleUnloadMs` disables timed unloading. Every ready, release, rollback, rejection, and idle-unload result is sent to the authority as a sanitized digest-only audit record.

## Extension points

Stateful drivers implement `cancelPreparation()` to settle a rejected preparation transaction without releasing the lease protecting a resident model. Before activation starts, the runtime calls it with the original transaction and a fresh bounded cleanup signal, even when the user cancelled approval. Cancellation failure taints ownership instead of pretending the transaction settled. Drivers without remote transaction state can omit the method; it must never undo or certify a mutating operation as clean.

`settleActivation(context, disposition)` separates physical readiness from publication commit. Stateful drivers keep successful destination probes pending until the runtime records READY and publishes the effective session route, then acknowledge `COMMIT` before returning an inference lease. Definite activation/publication failures request `COMPENSATE` on the original transaction and resource fence before stopping the destination or restoring the verified-stopped source. Settlement uses a fresh bounded cleanup signal independent of caller cancellation. Unknown READY settlement and failed commit acknowledgement quarantine ownership without physical rollback; a definite audit failure can restore residency but retains the runtime's audit taint. Drivers without remote transaction state may omit this hook.

Inference admission is bounded by `maxPendingRequests` (default 32, excluding the current lease) and `queueTimeoutMs` (default 120,000 milliseconds). A full queue returns `QUEUE_FULL`; an expired wait returns `QUEUE_TIMEOUT`. Cancellation and expiry remove the waiting entry immediately without stopping active inference, changing residency, or calling the authority/driver. Zero pending capacity permits immediate acquisition but rejects waiting inference. Internal orderly shutdown and idle-unload operations retain their FIFO positions without inference admission limits, so overload cannot skip resource cleanup.

The dedicated resource installation must supply a deployment-owned `ResourceLeaseProvider` before governed host operations can run. The app requests coverage of the currently registered available targets and consumes externally issued lease, issuer, holder, fencing, receipt, and expiry information. It neither issues leases nor maps logical targets to physical GPUs. The deployment verifies canonical identity, physical resource coverage, currentness, and admission before returning a grant; each driver must enforce its fence atomically at the execution endpoint. The client checks coverage and attaches the grant and explicit transaction kind to every stage, and stage receipts bind its fencing digest.

`ResourceLeaseSession` renews on the provider's schedule and has an independent expiry watchdog. Lease ownership spans inference and idle residency, including rollback and shutdown. Revocation, expiry, or failed renewal cancels stage signals and inference, taints the runtime, and prevents stale cleanup. Release reports `SETTLED` only after local work is quiescent, or `UNCERTAIN` after ambiguous failure. Neither outcome proves that a remote GPU is empty or permits reassignment without deployment reconciliation. Adapters and drivers must honor cancellation; the deployment must quarantine uncertain work and enforce fences even if a client disappears.

The stream wrapper keeps a request-scoped lease signal and contributes it through `llm/dispatch-signal`; it never mutates the agent loop's frozen request. Provider acquisition, renewal, and release are bounded, and acquisition receives the caller's cancellation signal. Close cancels renewal and awaits one bounded best-effort release attempt; if close begins after renewal has started, the current grant is released as `UNCERTAIN` even when `SETTLED` was requested. Provider release failure is contained, not proof of remote cleanup. Authority and resource installations remain owned until every underlying provider call actually settles, including calls that outlive the caller's deadline. Late acquisitions and late renewals receive bounded `UNCERTAIN` release attempts with the receipt that actually settled. Calls that ignore cancellation can outlive their deadline and require owner reconciliation.

`capturePrestate()` must report fresh target occupancy as `EMPTY`, `RESIDENT` with route/revision, or `UNKNOWN`, bound into the prestate receipt. A runtime with no active route requires an empty target by default. An immutable admitted route may opt into exact resident adoption; that path requires the same route ID and revision, then runs health and capability probes without starting, draining, or stopping the process. Successful adoption transfers lifecycle control under the retained resource lease, so later switching, idle unload, or shutdown still requires normal drain and exact-residency checks before stop. Reuse, idle unload, and shutdown require the resident route/revision to match the active route. A cross-target switch checks both hosts. A mismatch returns `RESIDENCY_UNVERIFIED`, taints the runtime, and prevents teardown from stopping the unknown occupant. Failed shutdown prestate reads also prevent stop. These checks detect stale local state; they are not a distributed lock or a replacement for host-enforced fencing.

An admitted route may provide immutable `stageTimeoutsMs` overrides for named stages. Values must be positive, integer, timer-safe milliseconds and match the authority's route resolution. Unspecified stages and authority operations retain `stageTimeoutMs`. A slow-loading route can therefore allow a longer `start` deadline without lengthening health checks or queue-resolution deadlines; changing that budget requires updated route admission.

Deployment plugins install the canonical authority and register route drivers that inspect current resources and execute exact, revision-bound model mechanics. The driver cannot classify a route, choose a fallback target, or invent scope. GianaOS/GDM or another admission owner remains responsible for identity, policy, currentness, credentials, route classification, scope, and durable audit persistence.

## Model Experience

### Governed model selection

#### What the model sees

The model sees no direct context because `modelLifecycle` only coordinates host resources around inference.

#### Token effect

Zero direct token effect.

#### KV Cache effect

Independent. Route acquisition receives an already formed provider/model request and may switch the backing resource before that inference; this package does not rewrite retained conversation input.

## Known Limitations and Deferred Work

- **No host mechanism included** — a deployment must install its canonical authority and register exact route drivers before any governed local route can run.
- **Authority-free classification is intentionally narrow** — without an installed authority, only already registered selections are recognizable as governed. A deployment must install authority before exposing any local adapter.
- **No deployed resource issuer** — the package contains a lease consumer, not a global controller, transport, credential mapping, physical GPU allocator, or durable fencing store. Tests use fixture issuers. Multi-client production safety requires the deployment's real provider and execution-endpoint fencing. Prestate checks alone do not close the check-to-mutation race. Restart alone does not authorize resident adoption; the route must explicitly admit an exact route/revision match under the deployment's resource lease.
- **Conservative residency ownership** — one app serializes its local model work and leases its registered candidate targets together until verified unload. A new target added during residency requires a newly covered lease after release. Cross-client residency transfer or adoption needs an explicit owner-backed reconciliation mechanism, not a local cached route.
- **No route promotion** — loading this package alone does not register a model, promote a held route, or change a default.
