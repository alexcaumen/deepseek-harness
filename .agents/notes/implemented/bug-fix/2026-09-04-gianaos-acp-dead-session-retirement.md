# Agent Note: Retire failed GianaOS ACP sessions before reuse

Status: implemented

English | [中文](2026-09-04-gianaos-acp-dead-session-retirement.zh.md)

## Problem

The Putri adapter cached one ACP connection per exact local agent and session. An asynchronous prompt rejection disposed the connection before deleting it from the cache, while a synchronous prompt throw did not delete or dispose it. A concurrent turn could retain that session while waiting for its turn barrier, then send another prompt after the transport had closed and receive `ACP connection closed` again.

## Decision

`llm-gianaos-acp` synchronously removes a failed session from the cache only when the cache still contains that exact instance, then begins its idempotent asynchronous disposal. The compare-and-evict step cannot delete a replacement installed by a concurrent turn. A turn rechecks cache ownership after entering the per-session turn barrier; when its retained session was retired while it waited, it releases that barrier slot and selects or starts the replacement connection.

Synchronous prompt throws and asynchronous prompt rejections share the same retirement and `LlmError` classification. The asynchronous rejection starts retirement before releasing the turn barrier, but the rejecting stream waits for disposal before reporting failure. A replacement turn can therefore restore the durable remote session without waiting for process cleanup to finish.

The adapter also rejects a provider other than its configured provider before model resolution or streaming, and rejects a model other than its configured Putri participant before session work. These checks keep direct or incorrectly bound adapter calls from reaching the canonical ACP route.

## Alternatives considered

**Delete the cache entry after disposal completes.** Rejected because capability revocation and process exit can take time, leaving the failed session visible to another turn during cleanup. A late unconditional delete can also remove a replacement session.

**Retry the failed prompt on the same connection.** Rejected because ACP transport closure is terminal for that connection. Recovery creates a connection and loads the durable remote session instead of replaying a prompt on a closed pipe.

**Change the shared LLM or GG1 runtime.** Rejected because the cache, Putri route identity, and ACP process ownership belong to `llm-gianaos-acp`; changing a shared or remote runtime would widen the behavior beyond this adapter.

## Verification

Hermetic adapter tests close the real ACP SDK transport during a prompt, hold old-session disposal open, and prove a waiting turn creates a replacement connection that loads the same remote session. A separate test injects a synchronous prompt throw and proves the next turn uses a new connection. Binding tests prove wrong-provider and wrong-model calls fail before subprocess launch.

## Consequences

Transport failure no longer leaves a reusable dead Putri session in the adapter cache. Cleanup can overlap replacement startup, so old and replacement subprocesses may coexist briefly, but the old capability is already revoking and no new turn can select its session. Recovery preserves the durable remote session id and does not change GG1 runtime behavior.
