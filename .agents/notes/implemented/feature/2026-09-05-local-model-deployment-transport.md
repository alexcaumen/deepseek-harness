# Agent Note: Local Model Deployment Transport

Status: implemented

## Problem

The lifecycle consumer and Server Manager receipt validator existed without a callable transport or reversible composition. An R5300-only installation also required nonexistent PRDG/RAM identities. User-requested lazy startup must not turn configuration into GPU actions.

## Decision

Add bounded JSON-lines stdio transport and an installation helper in the existing Server Manager adapter package. Retain the existing authority, lease and route interfaces. Construction and registration are inert; the process launches on the first actual operation. Environment is explicit, child output is not exposed, replies correlate by id, and requests are never automatically retried. Renewal and cleanup have bounded reserved capacity separate from ordinary stages. Dispose routes before their dependencies; retry unfinished cleanup without replaying successful work.

Accept an explicit nonempty subset of target identities. Reject requests for missing targets without contacting a backend. Candidate settings preparation preserves sessions and existing providers while selecting Official FP8 only when the integrating verifier supplies current lazy-driver readiness.

## Verification

Focused app/lifecycle/transport/installer tests: 273 passed. Scoped adapter TypeScript and lint passed. Real Loader composition exercises inert registration and cleanup; the cross-language smoke uses the real Python owner service with a tests-only fake backend. Two independent-review P2 findings were fixed and re-reviewed.

## Consequences

This implements source-level wiring, not live model installation. Physical supervision, admission, capacity-aware co-residency and preexisting-model adoption remain unfinished in the existing owner/consumer design. No live settings/default, app, GPU process, canonical Putri runtime or R4 package was changed. See the artifact checkpoint for exact remaining work; do not equate fixture success with production-green.
