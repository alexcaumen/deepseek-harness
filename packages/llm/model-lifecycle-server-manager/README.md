# Server Manager model lifecycle adapter

English | [中文](README.zh.md)

`@deepseek-ai/dsh-model-lifecycle-server-manager` is the transport-neutral adapter between the governed model-lifecycle runtime and an admitted Giana Server Manager resource API. It implements both `ResourceLeaseProvider` and `ModelLifecycleDriver`, while an injected transport retains endpoint discovery, authentication, credentials, retry policy, and wire access.

The adapter does not select a provider, model, route, target, session, or fallback. Its options require owner-issued target identity and currentness digests, issuer and holder identities, an admission digest, bounded lease and operation timings, and a verified maximum clock skew. No host, API path, model path, process command, or secret is embedded in this package.

## Contract

Resource acquisition requests exact coverage of the targets admitted by the caller. The adapter validates canonical receipt digests, schema, lease identity, issuer, holder, admission, coverage, expiry, renew schedule, target identity, and currentness before exposing a grant. It subtracts the configured clock-skew bound and local operation budget from usable lifetime. Missing or exhausted lifetime fails closed.

Each lifecycle transaction begins lazily on its first stage, after caller cancellation and deadline checks. Every stage request carries the owner lease id, numeric fence and generation, immutable transaction kind, transaction digest, scope digest, route, revision, target and idempotency key. Digest-bound stage receipts must echo and bind the route id, target class and exact revision digest, as well as the transaction, scope and fencing values, and must advance from a previous receipt through a valid stage state. Failed prestate receipts and duplicate or mismatched targets fail closed. Preflight may return an explicit unavailable result; a no-capacity-only transaction is then cancelled cleanly before a `SETTLED` lease release. Once a mutating stage has been attempted, uncertain cleanup is released as `UNCERTAIN` for owner quarantine.

The adapter forwards caller cancellation to the injected transport and performs no hidden retry. A transport may retry only with the same idempotency key and must reject unknown-commit outcomes. Health decisions preserve `UNHEALTHY` as a typed false result so the lifecycle controller can run its bounded recovery path. Private lease ids, numeric fences, generations and wire payloads never enter the public grant or sanitized adapter error.

## Deployment Connection

`cancelPreparation()` terminally cancels an existing read-only preparation while retaining its resource lease. Successful preflight and prestate remain clean-cancelable, including an available target with a preserved resident. Other stages disable clean cancellation before transport dispatch, so a lost mutating reply cannot be treated as no change. Both explicit cancellation and settled lease release require manager acknowledgement; cancellation does not stop a resident or create a new transaction.

`settleActivation()` sends `settle-activation` with `COMMIT` or `COMPENSATE`, the original lease/fence, scope, destination identity and last acknowledged `transaction_sequence`. Receipts expose `activation_settlement`; `AWAITING_PUBLICATION` is nonterminal even with no allowed physical stages. A rejected or lost stage/settlement reply blocks subsequent stages and settlement in that adapter transaction. Successful read-only adoption also exposes `adopted_resident_route_id`, allowing rejected publication to settle without eviction through `cancelPreparation()`. Mutated transactions cannot use that cancellation path. A pending probe is never implicitly committed by lease release.

`ServerManagerStdioTransport` connects to a deployment-owned executable using bounded JSON-lines frames. Supply an absolute executable, fixed arguments, an explicit environment and `maxOperationMs`. It starts lazily on the first operation, never inherits ambient application credentials, hides the helper window on Windows, and multiplexes responses so lease renewal can continue during model loading. Requests are `{id, operation, envelope}`; responses are `{id, result}` or `{id, error}`. Backend diagnostics never enter transport errors. There is no automatic retry or reconnect. Aborted/timed-out calls retain their response identity until settlement or connection closure; a transport failure does not prove that a remote physical operation stopped. The normal queue is capped by `maxPendingRequests`; renew, release and clean-cancel each reserve one additional bounded slot so lost stage replies cannot starve reconciliation. Await `close()` after lifecycle settlement to reap the transport child.

`installServerManagerLifecycle(runtime, authority, routes, options)` transactionally installs the existing authority, shared lease provider and exact route drivers. Use its async disposer as a Cordis effect, and dispose it before closing the transport. Mounting it makes no resource calls, loads no default model, and does not rewrite settings or sessions. Failed registration unwinds earlier registrations. Failed disposal retains dependencies and unfinished cleanup for a later retry, without replaying completed cleanup. It is not an LLM catalog provider or an identity/admission issuer.

Target identities may cover only the deployed subset, such as R5300 alone. Each declared target must contain valid identity and currentness digests. A request for an undeclared target fails before transport invocation; PRDG/RAM targets are never fabricated merely to fill a configuration shape.

## Model Experience

### Governed resource execution

#### What the model sees

The model receives no direct adapter context from `@deepseek-ai/dsh-model-lifecycle-server-manager`. The surrounding lifecycle runtime may delay inference until an admitted route is ready or return a typed sanitized failure.

#### Token effect

Zero direct token effect. A failed admission occurs before inference; a successful switch changes only the backing route selected elsewhere.

#### KV Cache effect

Independent. This adapter does not rewrite conversation history or model input.

## Known Limitations and Deferred Work

- **Deployment binding still required** - the stdio transport and composition helper are implemented, but this package ships no admitted executable configuration, credential, target identity, model profile, or live Server Manager deployment.
- **Single-slot consumer** - the existing lifecycle consumer still serializes one large-model residency. These transport changes alone do not implement adoption of preexisting external residency or capacity-aware multiple resident models.
- **Owner reconciliation remains external** - `UNCERTAIN`, expired, revoked, or unknown-commit operations require the deployment owner to quarantine and reconcile physical state.
- **Clock discipline is supplied, not measured** - deployment must provide a current verified maximum skew and reject operation when that evidence is stale.
- **Execution fencing is owner-enforced** - client validation cannot replace atomic fence enforcement at every physical mutation endpoint.
- **No route promotion** - installing this adapter does not make a held model available, change a default, or prove R5300, PRDG, RAM/CPU, Putri, Qwen, or GLM live.
