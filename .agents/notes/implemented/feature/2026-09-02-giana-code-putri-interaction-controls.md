# Agent Note: Giana Code Putri interaction controls

Status: implemented

English | [中文](2026-09-02-giana-code-putri-interaction-controls.zh.md)

## Problem

The Giana Code Putri desktop candidate inherited capable Web conversation mechanisms but exposed several of them through incomplete or misleading product surfaces. Model-visible context still named the upstream harness, response annotations occupied verbose lines instead of remaining attached to their selected source, reasoning content opened too prominently, the ask-question takeover lacked dictation, the composer did not make Queue versus Steer discoverable, the dictation waveform moved too quickly to read comfortably, and a forced unavailable R5300 route could remain selected. The separate GianaOS Putri ACP launcher also used inconsistent SSH host identities, so child startup failures could appear as generic agent failures rather than a causal, redacted diagnostic.

Fixing these gaps by renaming internal packages, duplicating speech or steering services, or changing durable session semantics would increase migration risk and could disconnect existing sessions, tools, or provenance from the candidate. The product layer needs to present one coherent Giana Code Putri identity while preserving the existing runtime authorities and compatibility identifiers.

## Decision

### Product identity

The assembled product and model-facing product context identify the application as Giana Code Putri. Internal `@deepseek-ai/dsh-*` package names, `DSH_*` compatibility variables, harness protocol identifiers, repository history, licensing, and upstream provenance remain unchanged. User- and model-visible product copy is therefore distinct from the technical identifiers required to build, load, diagnose, and attribute the software.

### Response annotations

A response selection records optional start and end offsets alongside the selected text and response identity. Complete safe offsets render a numbered source highlight and marker, while incomplete or legacy payloads retain the text-only behavior. The composer renders annotations as compact numbered controls with hover and focus previews plus source navigation; sent user messages project the same annotations as compact numbered bubbles. Structured payloads remain backward compatible and no second annotation store is introduced.

### Reasoning presentation

Reasoning remains available through the transcript's existing collapsed disclosure, but its collapsed summary no longer exposes a moving line from the model's private reasoning stream. The row reports only running or completed status, avoids a misleading independent timer, and expands the full reasoning only on user action. Reasoning blocks remain separate from the final answer so streaming and settlement still surface one final answer exactly once.

### Composer and question controls

While a primary turn runs, an explicit Queue or Steer selector drives the existing canonical submission mode. It does not cancel the active turn, replace the strict per-row steer action, change the host wire contract, or alter the empty-draft whole-queue gesture described by [Steer the whole Web queue with an empty-draft Cmd/Ctrl+Enter](2026-08-06-web-queue-steer-all-gesture.md). The underlying delivery and race semantics remain owned by [Steer a queued Web message into the active turn](2026-07-30-web-queue-steer-action.md).

The ask-question composer provides microphone start, stop, transcription, retry, cancellation, and teardown states. It appends the transcript to the custom answer and reuses the conversation package's canonical Indonesian transcription resolver and dictation reducer through an explicit client-package dependency. It does not create a speech endpoint, router, credential path, or recording store. The presentation remains an extension of [Ask-question Web presentation](2026-07-29-ask-question-web-presentation.md).

The main composer waveform uses a fixed 72-bar history and advances one sample about every 97 milliseconds, producing one full traversal in about seven seconds. Its animation rate is time-based rather than tied to render frequency or model throughput.

### Route and launcher guards

A forced R5300 speech route persists only after the returned route state reports ready. An unavailable or failed route restores Automatic, prevents immediate reselection until status refresh, and explains the failure without claiming R5300 is active. Automatic routing continues to report the ready route selected by the existing compute authority.

The GianaOS Putri ACP launcher applies one pinned SSH host identity and strict known-host verification to its probes and launch path. Child failures report the causal stage and sanitized stderr while redacting tokens and private payloads. The launcher keeps the existing ACP, session, tool, and provider authorities; it adds no wrapper service or fallback router.

## Verification

Focused component and contract suites cover product awareness, offset and legacy annotation payloads, source navigation, collapsed reasoning and final-answer separation, Queue and Steer selection, the seven-second waveform, ask-question dictation lifecycle, R5300 rollback, and ACP launch diagnostics. Client package verification proves the ask-question package declares its conversation dependency rather than reaching through another package's source tree. Repository type checking and the production build pass for the isolated staging worktree.

The existing application is not restarted or replaced by this source change. Packaged-candidate Human Experience QA, session compatibility against a read-consistent copy, controlled promotion, rollback proof, and production smoke remain release gates for the exact immutable candidate.

Built-browser replay expectations include the collapsed Thinking status, question dictation, and busy-message selector. The optionless answer uses a stretching grid so the textarea fills its reserved frame despite the dictation wrapper. The fresh-round-trip scenario executes the native shell: Windows adapts a temporary copy of the recorded Bash fixture to PowerShell while preserving the command and using a separate Windows accessibility snapshot. It does not install a Bash alias, suppress tool errors, or alter the shared recording. Recording that fixture remains POSIX-only.

## Supersession and related decisions

This decision fully supersedes the moving latest-line preview and horizontal tail-follow mechanism recorded in the historical [Web thinking tail scroll](../../archived/feature/2026-08-02-web-thinking-tail-scroll.md). The old note's motivation remains relevant: a collapsed row must truthfully show whether reasoning is active without forcing the full reasoning body open. The replacement deliberately gives up the text-motion throughput signal and uses running or completed status instead.

It partially supersedes [Frame-coalesced reasoning-chunk publication and browser stress validation](../testing/2026-08-03-opt-in-reasoning-chunk-browser-stress.md): frame-coalesced snapshot publication and the opt-in stress lane remain current, while Think-summary tail-follow scheduling no longer exists. The queue and steer lifecycle notes and the ask-question presentation note remain canonical for their mechanisms. [Prompt variables and tool-guidance ownership](../architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md) remains the owner of the `harness:identity` prompt section; this decision changes the product value contributed through that owner. No active Agent Note previously owned response-selection annotations, the seven-second waveform, speech-route persistence, or the ACP launcher identity rule.

## Alternatives considered

**Rename internal packages and compatibility identifiers.** Rejected because those names are build, configuration, session, and provenance inputs rather than ordinary product copy. Replacing them would widen the migration and rollback surface without improving the user-visible identity.

**Store annotations as formatted text in the draft.** Rejected because line-oriented labels lose exact source association, cannot provide reliable navigation or hover previews, and force every model to reconstruct structure from prose. Optional offsets preserve structure while retaining legacy payload compatibility.

**Hide reasoning permanently or expand it by default.** Rejected because permanent removal prevents user inspection and default expansion overwhelms the answer surface. Collapsed, user-expandable reasoning preserves both access and focus.

**Animate a collapsed reasoning marquee independently of streaming.** Rejected because it would continue moving during provider stalls and make a paused model appear active. Status is a more truthful collapsed signal than synthetic motion.

**Keep the latest reasoning line or a fixed suffix in the collapsed summary.** Rejected because it exposes private reasoning fragments in the primary answer surface, can cut words or graphemes, and makes throughput legibility depend on content length. The complete body remains available only after expansion.

**Auto-scroll the expanded reasoning body.** Rejected because the expanded row is a reading surface; forced following would fight a user who scrolls back to inspect earlier reasoning.

**Add a second dictation service for ask-question answers.** Rejected because the main composer already owns transcription routing and lifecycle semantics. A second service would duplicate credentials, cancellation, route selection, and failure behavior.

**Implement Queue and Steer through a new host operation.** Rejected because the existing input mode and strict row-steer operations already own the required semantics. The selector is a presentation control over those mechanisms, not a new delivery protocol.

**Keep an unavailable forced R5300 selection.** Rejected because persisted intent would be displayed as active routing even when no ready route exists. Restoring Automatic makes the visible state truthful and recoverable.

**Use whichever SSH alias resolves first.** Rejected because identity drift makes known-host verification and failure attribution nondeterministic. One pinned alias keeps probe and launch evidence comparable.

## Consequences

Giana Code Putri presents a coherent interaction layer without changing existing session identities, durable history, model/provider routes, tool authorities, or internal package provenance. Users gain compact source-linked annotations, optional reasoning visibility, question dictation, explicit busy-turn delivery choice, a calmer waveform, and truthful compute selection.

The collapsed reasoning row no longer conveys token cadence through a moving text preview. It conveys only running or completed state until the user expands it; this trades passive throughput detail for a quieter answer surface and stronger separation between reasoning and the final answer.

The annotation payload has optional source offsets, so clients must continue accepting text-only legacy payloads. The ask-question package now carries one explicit client dependency on the conversation package. Product-awareness maintenance must distinguish ordinary surface copy from technical provenance rather than globally replacing upstream terms.

Source and automated gates can establish an immutable release candidate, but they do not establish production green. Activation still requires the current application to stop, the exact packaged candidate to pass Human Experience QA and session compatibility checks, rollback to be proven, and the accepted artifact to pass a bounded production smoke.
