# Agent Note: Exact deployment model ownership

Status: implemented

## Problem

An intact provider/model tuple can still be wrong: the DeepSeek adapter intentionally accepts unlisted model IDs, including a local model accidentally paired with DeepSeek. Atomic selection alone cannot reject that tuple, and restored session requests bypass the selection UI.

## Decision

The [LLM service](../../../../packages/llm/llm/README.md) accepts runtime-pinned declarations of exact model/provider ownership. GCP supplies its existing route declarations, including held routes. Overlapping declarations intersect and cannot weaken one another. Replicas require explicit provider pairs within the declaration. Models absent from every declaration preserve advisory behavior.

Selection resolution and final adapter dispatch enforce ownership. The host rechecks after asynchronous selection preparation and before publication or default persistence. A resolved model must still match the proposed tuple after an await. Prepared calls are rechecked at dispatch. Stored sessions are not rewritten; a crossed stored tuple fails before transport and can be repaired by an explicit valid selection.

## Alternatives considered

**Reject every unlisted DeepSeek model.** This breaks supported private and dynamically served models. Ownership is separate from the advisory catalog.

**Recognize local model name prefixes.** Names are opaque, aliases vary, and replicas can legitimately share a model ID. Exact deployment declarations supply the authority.

**Validate only the selector.** Persisted tuples and direct streaming calls bypass it, so enforcement belongs in the LLM service as well.

## Consequences

Ownership applies only to declared IDs and remains pinned through plugin suspension until the LLM runtime exits. An existing model ID cannot move providers without a new runtime. It does not authorize runtime activation or change lifecycle admission. Synthetic tests cover Loader composition, rejected selection persistence, restored tuples, valid routing, advisory models, asynchronous changes, and suspension; live provider behavior remains separate QA.
