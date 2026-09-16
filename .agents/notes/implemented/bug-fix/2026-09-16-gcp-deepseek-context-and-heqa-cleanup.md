# Agent Note: Give each DeepSeek slot the admitted context

Status: implemented

English | [中文](2026-09-16-gcp-deepseek-context-and-heqa-cleanup.zh.md)

## Problem

The two DeepSeek Vision launchers configured `--ctx-size 4096 --parallel 2`. llama.cpp divides the total context across parallel slots, so each request received only 2048 tokens. A native GCP request containing 2419 prompt tokens therefore failed before generation with `CONTEXT_WINDOW_EXCEEDED`, even though the compact route contract admits a 4096-token request window. The isolated packaged HEQA overlay also inherited `preserveResidentOnShutdown: true` while its acceptance check required the pre-run GPU baseline to be restored.

After the context correction, RC41 completed the native text and tool-call round trip but could not finish teardown. The loopback endpoint controller awaited `server.close()` before reclaiming a lingering owned tunnel. Node's close callback waits for open connections, so the controller never reached its channel cleanup. The desktop and HEQA driver deadlines were also shorter than the lifecycle controller's admitted cleanup budget.

## Decision

Both admitted DeepSeek launchers use a total context of 8192 with two parallel slots, preserving two-request concurrency while giving each slot 4096 tokens. Their launcher hashes, route revisions, target-currentness evidence, admission receipt, registry, and runtime binding are advanced together. The product profile continues to preserve a verified resident model on normal shutdown. Only the isolated HEQA overlay sets `preserveResidentOnShutdown: false`, so an exact test candidate stops and verifies its owned model during graceful teardown before comparing the remote baseline.

Loopback quiescence now closes admission first, grants existing owned transports a bounded grace interval, and then reclaims only transports still owned by that controller. Remote drain verification remains mandatory before a model process can stop. The extended shutdown deadline applies only to isolated HEQA; the ordinary product retains its existing bounded shutdown behavior. Outer HEQA deadlines exceed the lifecycle cleanup budget so the validator does not kill a valid cleanup in progress.

## Alternatives considered

**Reduce the GCP prompt below 2048 tokens.** This would hide a launcher/accounting defect, leave too little room for a response, and discard useful system or tool context.

**Use one parallel slot with the existing 4096 total.** This would satisfy one request but regress the previously qualified two-request concurrency contract.

**Disable resident preservation in the product.** That would increase cold starts and alter an intentional user-facing lifecycle policy merely to satisfy an isolated test invariant.

**Force-close the loopback immediately.** This can truncate an accepted streamed response. The two-phase close preserves the normal response path and uses forced cleanup only after the grace interval.

**Increase every product timeout.** The long path is evidence collection for self-cleaning HEQA, not ordinary user shutdown. Applying it globally would make real shutdown failures unnecessarily slow to recover.

## Consequences

The two-slot DeepSeek runtime carries a larger KV allocation and must be requalified on the exact R5300 launchers for load, text, tool call, vision, concurrency, stop, and baseline restoration. Production behavior remains warm-resident after ordinary app shutdown; HEQA behavior is deliberately self-cleaning and must leave DOTS unchanged.

The endpoint regression suite now includes a lingering keep-alive tunnel and requires bounded reclamation before quiescence can pass. Packaged HEQA must still prove final response integrity, owned process and port cleanup, exact baseline restoration, and unchanged DOTS identity on the same immutable candidate.
