# Agent Note: Give each DeepSeek slot the admitted context

Status: implemented

English | [中文](2026-09-16-gcp-deepseek-context-and-heqa-cleanup.zh.md)

## Problem

The two DeepSeek Vision launchers configured `--ctx-size 4096 --parallel 2`. llama.cpp divides the total context across parallel slots, so each request received only 2048 tokens. A native GCP request containing 2419 prompt tokens therefore failed before generation with `CONTEXT_WINDOW_EXCEEDED`, even though the compact route contract admits a 4096-token request window. The isolated packaged HEQA overlay also inherited `preserveResidentOnShutdown: true` while its acceptance check required the pre-run GPU baseline to be restored.

## Decision

Both admitted DeepSeek launchers use a total context of 8192 with two parallel slots, preserving two-request concurrency while giving each slot 4096 tokens. Their launcher hashes, route revisions, target-currentness evidence, admission receipt, registry, and runtime binding are advanced together. The product profile continues to preserve a verified resident model on normal shutdown. Only the isolated HEQA overlay sets `preserveResidentOnShutdown: false`, so an exact test candidate stops and verifies its owned model during graceful teardown before comparing the remote baseline.

## Alternatives considered

**Reduce the GCP prompt below 2048 tokens.** This would hide a launcher/accounting defect, leave too little room for a response, and discard useful system or tool context.

**Use one parallel slot with the existing 4096 total.** This would satisfy one request but regress the previously qualified two-request concurrency contract.

**Disable resident preservation in the product.** That would increase cold starts and alter an intentional user-facing lifecycle policy merely to satisfy an isolated test invariant.

## Consequences

The two-slot DeepSeek runtime carries a larger KV allocation and must be requalified on the exact R5300 launchers for load, text, tool call, vision, concurrency, stop, and baseline restoration. Production behavior remains warm-resident after ordinary app shutdown; HEQA behavior is deliberately self-cleaning and must leave DOTS unchanged.
