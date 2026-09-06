# Agent Note: Dictation diagnostics regression coverage

Status: implemented

## Problem

A payload-free diagnostic helper alone cannot prove that the composer invokes it with safe fields, that desktop speech-port injection reaches fetch, or that the Electron IPC handler filters renderer data before persistence.

## Decision

Focused tests exercise the real diagnostic helper, route resolver, InputBar transaction, preload script, and registered main-process IPC handler. Exact record assertions forbid additional diagnostic fields. Synthetic transcript, draft, URL, error, audio, and credential values distinguish private content from allowed metadata.

The IPC tests evaluate the launcher in a VM with an in-memory filesystem, disabled startup, and no process or network implementations. They preserve the existing policy: an otherwise valid record with private extra fields is accepted only after those fields are discarded; invalid required fields and non-window senders are rejected before filesystem access. This is not whole-envelope rejection of extra fields.

This testing decision supplements the [interaction-controls note](../feature/2026-09-02-giana-code-putri-interaction-controls.md) without superseding its product behavior or assembled-application verification requirements.

## Alternatives considered

**Helper-only assertions.** These cannot catch missing composer calls, ignored desktop route injection, or persistence of the original IPC payload.

**Launching Electron or the speech service.** A live launch exceeds this isolated test-only task and introduces unnecessary disk, service, and microphone effects. Packaged integration remains a separate verification obligation.

## Consequences

The tests retain all existing assertions and change no production code. VM tests verify handler behavior, not Electron's real sender provenance, microphone capture, service availability, packaged preload delivery, or actual log-file rotation. Profile, session-clone, and release verification remain parent-owned.

## Testing

The focused Vitest run passes 125 tests across [diagnostic records](../../../../packages/client/ui-conversation/tests/dictation-diagnostics.client.spec.ts), [route resolution](../../../../packages/client/ui-conversation/tests/dictation.client.spec.ts), and [InputBar](../../../../packages/client/ui-conversation/tests/input-bar.client.spec.tsx), using `--no-cache --configLoader runner --maxWorkers 1` with the existing repository configuration.

The wrapper command `node --test test-preload.cjs test-dictation-policy.cjs test-dictation-ipc.cjs` passes 19 tests across [preload](../../../../../../giana-code-desktop/giana-cowork-regression-fix-20260905/test-preload.cjs), [policy](../../../../../../giana-code-desktop/giana-cowork-regression-fix-20260905/test-dictation-policy.cjs), and [IPC](../../../../../../giana-code-desktop/giana-cowork-regression-fix-20260905/test-dictation-ipc.cjs). The initial IPC harness run failed because its process stub lacked `on`; adding that inert test-only method resolves the failure.
