# Agent Note: GCP Six-model Source Binding

Status: implemented

## Problem

Giana CoWork Preview retained four stale GLM evidence descriptors while AI StudioTech delivered a hash-bound six-variant packet. Treating downloaded weights or canary results as live selector admission would bypass the existing provider directory and model lifecycle authority.

## Decision

Refresh the existing GianaOS source-only catalog instead of creating a second registry. Bind four GLM 5.3 and two DeepSeek V4 Flash Vision records to the exact handoff, assembly receipt, independent validation and selection-index digests. Preserve each upstream repository revision, manifest digest, selected model-row digest, runtime engine, R5300 compatibility, vision evidence and tool-call result.

Keep all records blocked and non-production. The MLX artifact is audit-only and cannot be selected for R5300. The GLM GGUF Q6_K artifact remains held from agentic tool routing under its exact failed predicate. Qwen remains a separate historical observation and is not a default or rollback assumption.

The existing Host LLM provider directory remains the only live model selector source. The existing lifecycle controller remains the only load, drain, switch and rollback owner; rollback restores the captured previous healthy route.

## Verification

Focused catalog tests assert the exact six records, package digests, five R5300-compatible variants, the MLX exclusion, the Q6 tool-call hold and zero implied admission/default/live activation. Scoped TypeScript and repository checks cover the changed package.

## Alternatives considered

**Create a second live model registry.** Rejected because the Host LLM provider directory already owns live model discovery; another registry would drift and permit UI state to bypass provider truth.

**Publish all six models immediately.** Rejected because the upstream packet explicitly records `route_admission: false` and `production_green: false`, and one variant has no R5300 runtime while another fails native agentic tool calls.

**Restore Qwen after every failed switch.** Rejected because rollback must restore the exact healthy resident route captured before the transaction, regardless of model family.

## Consequences

This is source binding only. Live availability still requires current route admission, a deployed Server Manager authority/binding, provider advertisement and same-build HEQA. No sealed GCP app, canonical Putri V15 runtime, GPU process, default model or user session is changed by this patch.
