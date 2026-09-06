# Agent Note: Bounded pi-ai reserve for small context windows

Status: implemented

English | [中文](2026-09-06-pi-ai-small-context-reserve.zh.md)

## Problem

pi-ai 0.82.1 subtracts a fixed 4,096-token estimation reserve before clamping output. A truthfully declared 4,096-token local model consequently receives only one output token even with an empty prompt. Changing the model descriptor to evade this reserve would misrepresent capacity to prompt admission and usage reporting.

## Decision

The repository owns a version-specific [pnpm patch](../../../../patches/@earendil-works__pi-ai@0.82.1.patch), bound through [workspace configuration](../../../../pnpm-workspace.yaml) and the mechanically generated [lockfile](../../../../pnpm-lock.yaml). The patch changes only the shipped SDK clamp's reserve calculation. The [adapter token policy](../../../../packages/llm/llm-pi-ai/README.md) defines the reserve and output semantics; both adapter dispatch and SDK `buildBaseOptions` use the same patched function. No loader hook, model-specific exception, model-capacity inflation, or adapter production change is involved.

## Alternatives considered

**Inflate model context capacity.** Rejected because it makes admission and reporting trust a window the server does not provide.

**Keep a private loader hook or edit installed dependency files.** Rejected because those changes do not travel with the repository's dependency graph and can affect other worktrees through shared files.

**Clamp only in the adapter.** Rejected because the SDK can apply its fixed reserve again after dispatch. The existing adapter clamp remains in place and agrees with the SDK.

## Consequences

Small windows retain usable output headroom while windows of at least 32,768 tokens keep the upstream reserve. Request ceilings, model output defaults, nonpositive-window handling, and the one-token saturation floor keep their upstream behavior. Saturation does not prove that a prompt fits: tokenization and provider overhead remain estimates, and an oversized input can still be rejected by the server.

The patch targets the published JavaScript implementation; declarations remain valid and upstream source maps are not regenerated. The exact version and patch hash make dependency upgrades an explicit reapplication or retirement decision. The offline, ignore-scripts install uses pnpm's read-only store mode and relinks only this worktree's dependency copy.

## Verification

[SDK budget tests](../../../../packages/llm/llm-pi-ai/tests/context-budget.spec.ts) exercise the installed clamp and `buildBaseOptions` at the reserve floor, integer-rounding boundaries, 4K/8K windows, the 32K transition, and larger windows. They cover empty and nonempty prompts, saturation and overflow, model defaults, caller ceilings, and unknown-window behavior. [Dispatch tests](../../../../packages/llm/llm-pi-ai/tests/sdk-options.spec.ts) pin unchanged model metadata and exact output budgets before and after the SDK's second clamp. The crowded 8K regression uses 16,000 characters, yielding 4,000 estimated input tokens and 3,168 output tokens.

These are keyless option-path tests with the provider stream mocked. They do not verify a live model, GPU, provider tokenizer, full-profile renderer, or assembled application transcript; those checks remain outside this bounded patch task.
