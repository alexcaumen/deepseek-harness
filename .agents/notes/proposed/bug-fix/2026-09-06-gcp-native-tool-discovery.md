# Agent Note: GCP native tool discovery

Status: proposed

## Problem

The Giana CoWork Preview full profile retains desktop, browser, file, skill,
and connector capabilities. Sending all 117 schemas adds 121,245 JSON characters
to each model request, compared with 18,905 system-text characters in the measured
session. The GLM local runtime disables prefix reuse for KPool correctness.
Consequently, even an already loaded model repeats substantial prefill work.

## Proposal

The existing [tool registry](../../../../packages/core/tools/src/on-demand.ts)
owns an opt-in, exact-provider native presentation. The deployment pins basic
reading and skill tools and exposes `tool_search`. Search resolves only currently
visible registry schemas, with bounded pagination. Successful correlated search
results and prior calls reconstruct a bounded active set from durable session
events. Current registration supplies schemas; saved schemas never override
current permissions or definitions. Restricted scopes without discovery retain
their complete permitted native presentation. Other providers remain unchanged.

No parallel registry, tool executor, session store, identity plane, or policy is
introduced. The existing request/header receipt records actual sent schemas.
Code mode retains its own execution contract. The opt-in deployment change is
limited to the local GLM provider in GCP, not canonical GCW or Putri V15.

The default agent loop applies `schemasForRequest` after adapter resolution and
before logging the request header. Initial agent options are not routing truth:
the model selector, request middleware, and resumed sessions can select another
provider. Conditional discovery guidance avoids claiming discovery exists when
the current request does not offer it. The exact filtered schemas remain logged.

## Alternatives considered

**Minimal smoke profile:** removes normal capabilities and does not prove the
user's full application. Rejected.

**Force prefix caching:** the runtime explicitly disables it because its KPool
live tail cannot yet be safely restored. Rejected without owner correctness work.

**Increase only timeouts:** prevents premature failure but leaves unnecessary
prefill cost. It is not the performance fix.

## Acceptance criteria

Registry tests cover scope restrictions, replay, failed results, hot replacement,
pagination, bounded growth, and code-mode compatibility. The full copied profile
must retain Settings, Kirana history, and the complete model catalog. A live GLM
tool-read must return the fixture nonce, with correlated result and completed
turn; record request size and time-to-first-output before and after. An additional
discovery workflow must exercise a tool absent from the initial request.

## Risks

Search adds an extra model round-trip when a tool is not already available.
Changed schemas may invalidate prefix caching in other engines, hence explicit
provider opt-in. Long conversations still carry retained user/tool context and
can require compaction. Shrinking schema cost is not a claim that GPU offload,
all-model switching, or every human experience test is complete. Production
acceptance requires the built candidate, not source tests alone.
