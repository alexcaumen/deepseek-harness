# Agent Note: Settle rejected local-model preparation

Status: implemented

## Problem

The runtime retains the resource lease when a resident model survives a rejected switch. The Server Manager adapter and manager marked successful preflight as not clean-cancelable, leaving the rejected transaction open. Subsequent requests then failed with a busy transaction even though no model mutation occurred.

## Decision

The driver has an optional `cancelPreparation()` operation for implementations with remote transaction state. The runtime calls it before returning a non-mutating preparation failure, using the original transaction/fence and a fresh bounded cancellation signal. Successful preflight and prestate remain eligible for cancellation; other stages disable eligibility before dispatch. The manager acknowledges terminal cancellation while the resource lease remains held for the existing resident. Failed or uncertain cancellation taints ownership instead of authorizing another switch.

## Alternatives considered

**Release the entire lease on rejection.** This would discard the ownership protecting an existing resident and introduce reacquisition into idle cleanup and shutdown. Settling only the failed transaction preserves ownership.

**Cancel lazily when the next request arrives.** This leaves rejection externally unfinished and makes recovery depend on another user request. The runtime settles preparation before returning the failure.

**Treat every failed stage as clean.** A failed response does not prove that a dispatched mutation did not execute. Only read-only preparation is eligible.

## Consequences

Loader composition tests connect the real lifecycle service, Server Manager adapter and durable preview manager, replacing only host execution and approval with fixtures. Denial, caller cancellation and approval expiry retain the resident, reach a terminal preparation transaction and permit a subsequent governed request. These tests do not certify native approval UI, physical GPU switching, compensation after a committed mutation or final desktop acceptance.
