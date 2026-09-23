# Agent Note: GCP annotation attachments and waveform travel

Status: implemented

English | [中文](2026-09-23-gcp-annotation-attachments-and-waveform-travel.zh.md)

## Problem

The product owner rejected the Giana Cowork Preview RC47 composer annotation and dictation waveform after live use. A response selection inserted an editable `@Annotation N` structured reference into the draft and also rendered a separate numbered bubble row inside the composer, so one annotation appeared twice and user prose shared a buffer with generated labels. The waveform advanced every bar one slot per 97 ms step, so each bar jumped to its neighbour's height, and each sample came from one short analyser read, so adjacent bars differed sharply. The rejected references are the Codex composer, where one compact "1 annotation" chip opens a card with each selected passage and its edit and delete controls, while numbered markers stay beside the source passage.

## Decision

### Annotations are composer attachments

The session input shell keeps annotations in a separate ordered list, numbered 1..N, beside draft text and image ids; `InputState.annotations` publishes it. Adding a selection never edits the draft. Removing one renumbers the rest. Each annotation may carry an optional comment of at most 2,000 characters. Busy admission phases freeze the list that an in-flight send captured.

The composer renders one chip, "N annotations", with a remove-all control. Pointer hover or keyboard focus opens a card that lists every passage with its number, a "Selected text" caption, a comment editor, and delete; activating a passage scrolls to its source marker. Source markers in the conversation read the same list.

On send, the shell prepends one `<response-annotations>` envelope to the model text and the labels `@Annotation 1 … @Annotation N` to the display text, joined to the authored text by one space. The envelope's existing projection therefore reproduces the display text, so history derives numbered bubbles from the durable message exactly as before; the envelope adds an optional `comment` field. An annotation-only send is allowed. A successful send consumes exactly the captured annotations; a failure keeps them.

Persisted drafts store annotations beside the text with offset `-1`. A draft saved while annotations were inline references still carries `@Annotation N` tokens with non-negative offsets; restore moves each matching token out of the text into the list and ignores stale entries.

### Waveform travel is continuous and smoothed

The analyser is read once on every animation frame into the current step's bucket. At each 97 ms step the sample is 60 percent mean plus 40 percent peak of that bucket. The retained RC52 envelope decays by 0.86 per elapsed slot and preserves the visible tail, then passes an asymmetric smoother (rise 0.6, decay 0.25) that snaps to the floor once silence settles within 0.005 of it. Catch-up fills elapsed slots, caps work at 72 samples, and never multiplies analyser reads by missed frames. RC52's quiet-speech gain and silence threshold remain unchanged. The 72 bars sit on a track one bar pitch wider than the viewport; the track slides one pitch per step through `--dictation-progress`, so bars move continuously and the newest enters from the right edge. Travel remains about seven seconds. Reduced motion uses one uniform, unsmoothed level without sliding.

Attachment-only sends enter the same input-machine transaction as text sends. Repeated Enter and attachment mutations are refused during admission, disposal aborts the attempt, and synchronous or asynchronous failures retain annotations for retry. Successful settlement preserves text appended after the captured draft. Session mount restores annotation-only drafts even when the authored text is empty; legacy migration removes only complete matching tokens. An open comment editor closes when deletion renumbers its annotation, preventing a stale comment from reaching another passage.

## Verification

Client suites cover draft-free annotation attachment, renumbering, comments in the envelope, annotation-only sends, failure retention, projection of the sent model text back to the display prefix, restore of attachment and legacy inline drafts, stale-sidecar rejection, the composer chip and card with keyboard focus, navigation, edit, delete, and remove-all. Waveform tests pin the smoothed onset, sub-step progress, calm decay, throttled catch-up, floor settling, reduced motion, and resource release.

Packaged acceptance still requires the exact portable EXE: one to three annotations with scroll, resize, send, and reload, and a recording of at least 15 seconds of real speech and silence with measured travel at the recorded display scale. Only the product owner's visual acceptance closes either row.

## Supersession and related decisions

This decision partially supersedes [Giana Code Putri interaction controls](2026-09-02-giana-code-putri-interaction-controls.md): its composer annotation controls and step-only waveform advance are replaced, while its source offsets, durable projection, navigation rules, and seven-second travel target remain current.

## Alternatives considered

**Mask the inline token with a label.** Rejected because the characters stay in the editable draft, the caret can enter them, and the separate bubble row still duplicates the annotation.

**Animate each bar height with a CSS transition.** Rejected because bars then morph in place instead of travelling, and the per-step jumps remain.

**Store annotations only in the model text.** Rejected because the composer needs numbered, editable, removable items before send, and history rendering already depends on the envelope-to-display projection.

## Consequences

User prose and annotations no longer share a buffer, so typing, undo, and copy operate only on authored text. The durable wire form is unchanged apart from the optional comment, so earlier histories render as before. The waveform reads the analyser on every frame instead of once per step, a small constant cost during recording.
