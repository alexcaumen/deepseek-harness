# Agent Note: Bound Automatic Browser History Retention

Status: implemented

## Decision

Keep browser display history independent from durable session history. Apply a validated event/serialized-character budget at complete Step boundaries and release the previous selected session's display window. Preserve control-plane state and reload durable history on return. Generation guards reject old open/paging/gap responses after suspension.

## Rationale

An overnight agent can generate hundreds of thousands of raw stream events. A 50-message initial page does not bound subsequent live arrivals. Keeping every previously opened session resident multiplies the retained data. UI virtualization does not reclaim those objects.

## Alternatives

Periodic whole-window reload loses interaction state and masks the accumulation. Arbitrary event slicing can separate tool calls/results or partial assistant chunks. Cancelling a background agent to reclaim display memory changes user work and is rejected. Increasing V8 heap size merely delays exhaustion.

## Consequences

Older history remains on disk and pageable. A single atomic Step may exceed the soft targets; manually expanded history may also exceed them. No hard total-process memory guarantee is made. Pending interactions, selected model, source events and backend execution are unchanged. Validation covers long turns, oversized tool output, history reload, suspension and late response rejection; native release acceptance is recorded by the desktop wrapper.

Independent review identified same-session reopening after clear, stale suspended waits across reconnect, and an older-page response racing live eviction. Regression tests now cover all three. Connection death clears old waits before replay; ready-handshake resync preserves replayed requests. Programmatic overrides are validated, but the normal browser loader currently uses default targets. Deployment configurability is deferred.

Three pre-existing RC50 waveform tests expected the pre-envelope amplitudes and eight analyser reads per catch-up frame. The unchanged RC50 waveform source uses a decaying envelope and one analyser sample per paint. Baseline execution reproduced all three failures; only these test expectations were aligned, including checks that silence eventually returns to the floor. No waveform implementation changed in this patch.
