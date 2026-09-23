/**
 * SessionInput shell over the pure input machine: the sole machine caller
 * and effect executor. Owns the InputState store (machine state + the queue
 * overlay), the notice channel, and the submit transaction plumbing
 * (adjudicate via the session's InputTriggerController; claim.submit; default
 * sink). Package-private; the hub alone constructs it and wires the scoped
 * event listeners onto it.
 */
import type { ClientContext, ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ArbitrateKey, ArbitrateOutcome, CommandClaim, ConsumeTokenRequest, PickOutcome,
  ReferenceInsert, InputTriggerController, SubmitImageAttachment, SubmitOutcome, TokenSpan,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {
  DraftAttachmentId, EditRange, EditSelection, InputActions, InputEffect, InputNotice, InputState,
  PasteComponent, QueuedMessage, ResponseAnnotationDraft, SessionInput, SubmitAttempt,
} from './contract.ts'
import type { InputSubmitMode } from '../contract/composer-submission.ts'
import { InputMachine } from './machine.ts'
import { parseResponseAnnotationPayload } from './response-annotation.ts'
import {
  RESPONSE_ANNOTATION_ATTACHMENT_OFFSET, RESPONSE_ANNOTATION_COMMENT_MAX_LENGTH, responseAnnotationDisplayPrefix,
  responseAnnotationEnvelope, responseAnnotationLabel,
  type PersistedResponseAnnotation, type ResponseAnnotationPayload, type ResponseAnnotationProjection,
} from '../response-annotation.ts'

/** Popup face the shell needs (dismissal only; typed structurally to avoid a value import). */
export interface PopupDismissFace {
  dismiss(): void
}

/**
 * Construction dependencies of one facade. The slash/popup faces are THUNKS: the
 * shell is created inside the sessions provide materialization (before the
 * scope record is queryable), where `slash.sessionOf`/`command.popupFor`
 * cannot resolve yet — resolution defers to first interactive use.
 */
export interface SessionInputDeps {
  /** Session-scope ctx handed to claim.submit transactions. */
  actx: ClientContext
  /** Enter adjudication face resolver; absent/undefined answer = every '/' line falls to the default sink. */
  inputTriggers?: (() => InputTriggerController | undefined) | undefined
  /** PopupSelect shell face resolver (dismissal on submit lock / escape). */
  popup?: (() => PopupDismissFace | undefined) | undefined
  /** Queue read face; overlaid onto InputState.queue (absent = empty). */
  queue?: ObservableSnapshot<readonly QueuedMessage[]> | undefined
  /**
   * Steer every still-pending queued message into the running turn, in FIFO
   * order (the empty-draft accelerated-Enter gesture); absent = unsupported.
   */
  steerQueue?: (() => void) | undefined
  /** The plain-message sink (send choreography / materialize fork — the hub owns it). */
  defaultSink(
    text: string,
    imageIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal: AbortSignal,
    displayText?: string,
  ): Promise<SubmitOutcome>
  /** Command-plane image plumbing (the hub owns the conversation face and the copy). */
  commandImages: {
    /** Resolve ordered draft ids to wire payloads without sending them; rejects when an id no longer resolves. */
    serialize(ids: readonly DraftAttachmentId[]): Promise<readonly SubmitImageAttachment[]>
    /** Free consumed draft images after a successful command submit. */
    release(ids: readonly DraftAttachmentId[]): void
    /** Localized composer notice for a claimed command that does not accept images. */
    unsupportedNotice(token: string): string
  }
}

/** Guard tier from the machine phase. */
function guardOf(phase: InputState['phase']): 'plain' | 'claimed' | 'frozen' {
  switch (phase) {
    case 'plain': return 'plain'
    case 'claimed': return 'claimed'
    default: return 'frozen' // adjudicating / submitting
  }
}

const EMPTY_QUEUE: readonly QueuedMessage[] = []

/** Renumber annotations 1..N in their current order. */
function renumbered(annotations: readonly ResponseAnnotationPayload[]): ResponseAnnotationPayload[] {
  return annotations.map((annotation, position) => (
    annotation.index === position + 1 ? annotation : { ...annotation, index: position + 1 }
  ))
}

/**
 * Join the annotation display prefix / model envelope with the authored text.
 * Both halves use one separating space so the durable projection of the model
 * text equals the display text.
 */
function withAnnotations(
  annotations: readonly ResponseAnnotationPayload[],
  modelText: string,
  displayText: string,
  references: readonly ResponseAnnotationProjection[] = [],
): { modelText: string; displayText: string } {
  if (annotations.length === 0) return { modelText, displayText }
  const envelope = responseAnnotationEnvelope(annotations, references)
  const prefix = responseAnnotationDisplayPrefix(annotations)
  return {
    modelText: modelText === '' ? envelope : `${envelope} ${modelText}`,
    displayText: displayText === '' ? prefix : `${prefix} ${displayText}`,
  }
}

/** No-pipeline lexicon: zero text-ref decorations. */
const EMPTY_LEXICON: ReadonlyMap<'/' | '@', readonly string[]> = new Map()

/**
 * The per-session input facade: scoped-event application verbs +
 * setDraft/submit + the published InputState store.
 */
export class SessionInputShell implements SessionInput {
  /** Published machine state + queue overlay (the InputZone currency source). */
  readonly state: SnapshotStore<InputState>
  /** Latest surfaced notice (null after clear); the bar renders errors as banners and information inline. */
  readonly notices: SnapshotStore<InputNotice | null> = createSnapshotStore<InputNotice | null>(null)
  /** The public provide-channel action face (one stable identity per session). */
  readonly actions: InputActions = {
    setDraft: (text, annotations) => { this.restoreDraft(text, annotations) },
    addResponseAnnotation: annotation => this.addResponseAnnotation(annotation),
    removeResponseAnnotation: (index) => { this.removeResponseAnnotation(index) },
    clearResponseAnnotations: () => { this.clearResponseAnnotations() },
    commentResponseAnnotation: (index, comment) => { this.commentResponseAnnotation(index, comment) },
    addImages: ids => this.addImages(ids),
    removeImage: (id) => { this.removeImage(id) },
    pruneImages: (ids) => { this.pruneImages(ids) },
    submit: () => { this.submit('queue') },
  }

  /**
   * Add one selected response passage as the next composer annotation. The
   * draft text is untouched; the passage rides the send as a model envelope.
   */
  addResponseAnnotation(annotation: ResponseAnnotationDraft): boolean {
    const text = annotation.text.trim()
    if (text.length === 0) return false
    if (this.annotationsLocked()) return false
    const hasValidAnchor = Number.isSafeInteger(annotation.startOffset)
      && Number.isSafeInteger(annotation.endOffset)
      && Number(annotation.startOffset) >= 0
      && Number(annotation.endOffset) > Number(annotation.startOffset)
    const duplicate = this.annotations.some(existing => existing.messageId === annotation.messageId
      && existing.text === text
      && existing.startOffset === (hasValidAnchor ? annotation.startOffset : undefined)
      && existing.endOffset === (hasValidAnchor ? annotation.endOffset : undefined))
    if (duplicate) return true
    this.annotations = [...this.annotations, {
      index: this.annotations.length + 1,
      messageId: annotation.messageId,
      text,
      ...hasValidAnchor ? {
        startOffset: Number(annotation.startOffset),
        endOffset: Number(annotation.endOffset),
      } : {},
    }]
    this.publish()
    return true
  }

  /** Remove one composer annotation; the rest renumber to stay 1..N. */
  removeResponseAnnotation(index: number): void {
    if (this.annotationsLocked()) return
    const next = this.annotations.filter(annotation => annotation.index !== index)
    if (next.length === this.annotations.length) return
    this.annotations = renumbered(next)
    this.publish()
  }

  /** Remove every composer annotation. */
  clearResponseAnnotations(): void {
    if (this.annotationsLocked() || this.annotations.length === 0) return
    this.annotations = []
    this.publish()
  }

  /** Set (non-empty) or clear (empty) one annotation's comment. */
  commentResponseAnnotation(index: number, comment: string): void {
    if (this.annotationsLocked()) return
    const trimmed = comment.trim().slice(0, RESPONSE_ANNOTATION_COMMENT_MAX_LENGTH)
    const position = this.annotations.findIndex(annotation => annotation.index === index)
    const current = this.annotations[position]
    if (current === undefined || (current.comment ?? '') === trimmed) return
    const { comment: _previous, ...rest } = current
    const next = [...this.annotations]
    next[position] = trimmed === '' ? rest : { ...rest, comment: trimmed }
    this.annotations = next
    this.publish()
  }

  /** Busy admission phases freeze the attachment set that the in-flight send captured. */
  private annotationsLocked(): boolean {
    const phase = this.core.state.phase
    return this.disposed || phase === 'adjudicating' || phase === 'submitting'
  }

  // Real wall clock: the typing-run merge window must actually expire in
  // production (the machine's no-clock default is a constant for pure tests).
  private readonly core = new InputMachine({ now: () => Date.now() })
  private noticeSeq = 0
  private lastMirroredDraft = ''
  private imageIds: readonly DraftAttachmentId[] = []
  /** Composer annotation attachments, always numbered 1..N. */
  private annotations: readonly ResponseAnnotationPayload[] = []
  private disposed = false
  /** Draft persistence mirror (other references use clipboard text; annotations retain their display form). */
  private mirrorFn: ((text: string, annotations?: readonly PersistedResponseAnnotation[]) => void) | undefined
  private lastMirroredAnnotationKey = ''

  constructor(private readonly deps: SessionInputDeps) {
    this.state = createSnapshotStore<InputState>(this.compose())
    deps.queue?.subscribe(() => { this.publish() })
  }

  // ---- SessionInput face ----

  /**
   * Single draft write path (all mutation rides machine events).
   * @param text - the full next draft.
   * @param editRange - the DOM-observed edit shape, when the caller knows it
   * (narrows the machine's occurrence math; absent → diff scan).
   */
  setDraft(text: string, editRange?: EditRange): void {
    this.run(this.core.dispatch({ type: 'draft-changed', draft: text, ...(editRange !== undefined ? { editRange } : {}) }))
  }

  /**
   * Restore a persisted draft and its annotation attachments. Attachments use
   * the attachment offset; a draft persisted while annotations were inline
   * text still carries `@Annotation N` tokens, which move back out of the
   * authored text into attachments. Invalid entries never block the text.
   */
  private restoreDraft(text: string, annotations?: readonly PersistedResponseAnnotation[]): void {
    // Persisted browser storage is a durable boundary: validate every entry.
    const entries: readonly unknown[] = Array.isArray(annotations) ? annotations as readonly unknown[] : []
    if (entries.length > 0 && this.annotationsLocked()) return
    if (entries.length === 0 || this.snapshot.draft !== '' || this.annotations.length > 0) {
      this.setDraft(text)
      return
    }
    const restored: ResponseAnnotationPayload[] = []
    const inlineRanges: { start: number; end: number }[] = []
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const { offset, ref } = entry as { offset?: unknown; ref?: unknown }
      if (typeof ref !== 'string' || typeof offset !== 'number') continue
      try {
        const payload = parseResponseAnnotationPayload(ref)
        if (offset === RESPONSE_ANNOTATION_ATTACHMENT_OFFSET) {
          restored.push(payload)
          continue
        }
        if (!Number.isSafeInteger(offset) || offset < 0) continue
        const label = responseAnnotationLabel(payload.index)
        const end = offset + label.length
        if (text.slice(offset, end) !== label || (text[end] !== undefined && !/\s/u.test(text[end]))) continue
        if (inlineRanges.some(range => offset < range.end && end > range.start)) continue
        inlineRanges.push({ start: offset, end: text[end] === ' ' ? end + 1 : end })
        restored.push(payload)
      } catch {
        // A stale persisted sidecar cannot prevent recovery of the authored text.
      }
    }
    let authored = text
    for (const range of [...inlineRanges].sort((a, b) => b.start - a.start)) {
      authored = authored.slice(0, range.start) + authored.slice(range.end)
    }
    this.annotations = renumbered([...restored].sort((a, b) => a.index - b.index))
    this.setDraft(authored)
    this.publish()
  }

  /** Append ordered image ids unless an admission transaction is locked. */
  addImages(ids: readonly DraftAttachmentId[]): boolean {
    if (this.snapshot.phase === 'adjudicating' || this.snapshot.phase === 'submitting') return false
    if (ids.length === 0) return true
    this.imageIds = [...this.imageIds, ...ids]
    this.publish()
    return true
  }

  /**
   * Remove one image id from this draft. Busy admission phases refuse, like
   * {@link addImages}: a removal landing while a command submit serializes
   * would otherwise vanish from the rail yet still ride the in-flight send.
   */
  removeImage(id: DraftAttachmentId): void {
    if (this.snapshot.phase === 'adjudicating' || this.snapshot.phase === 'submitting') return
    const next = this.imageIds.filter(candidate => candidate !== id)
    if (next.length === this.imageIds.length) return
    this.imageIds = next
    this.publish()
  }

  /**
   * Keep only image ids that still resolve in the browser attachment registry.
   * @param available - live registry ids.
   */
  pruneImages(available: readonly DraftAttachmentId[]): void {
    const keep = new Set(available)
    const next = this.imageIds.filter(id => keep.has(id))
    if (next.length === this.imageIds.length) return
    this.imageIds = next
    this.publish()
  }

  /**
   * Clear the draft as a successful-send commit: no undo unit is recorded and
   * the undo history is cut, so Ctrl/Cmd-Z cannot resurrect sent content
   * (the command path gets the same discipline from submit-settled success).
   * @param imageIds - admitted image ids to remove from this draft.
   */
  commitSend(imageIds: readonly DraftAttachmentId[]): void {
    const submitted = new Set(imageIds)
    this.imageIds = this.imageIds.filter(id => !submitted.has(id))
    this.run(this.core.dispatch({ type: 'send-committed' }))
  }

  /** Undo the latest transaction (InputBar intercepts the platform chord). */
  undo(): void {
    this.run(this.core.dispatch({ type: 'undo' }))
  }

  /** Redo the latest undone transaction. */
  redo(): void {
    this.run(this.core.dispatch({ type: 'redo' }))
  }

  /**
   * Paste text over the selection in one transaction, with any hot-snapshot
   * sync matches componentized inside it.
   * @param text - pasted plain text.
   * @param selection - replaced selection in draft coordinates.
   * @param components - sync-matched reference components (disjoint, inside `text`).
   * @param generation - projection generation for late async-upgrade guards.
   */
  pasteBegin(text: string, selection: EditSelection, components?: readonly PasteComponent[], generation?: number): void {
    this.run(this.core.dispatch({
      type: 'paste-begin', text, selection,
      ...(components !== undefined ? { components } : {}),
      ...(generation !== undefined ? { generation } : {}),
    }))
  }

  /** End the live paste-match attempt (caret/selection ops and Slash updates the machine cannot see). */
  invalidatePaste(): void {
    this.run(this.core.dispatch({ type: 'invalidate-paste' }))
  }

  /**
   * Enter adjudication + submit transaction + default sink. Effects fan out
   * from the machine; this method only feeds the event. Lock entry
   * (adjudicating/submitting) force-closes the transient layers: the popup
   * dismisses and the menu tracks frozen.
   */
  submit(mode: InputSubmitMode = 'queue'): void {
    if (this.disposed) return
    // Claimed pre-gate: a claim that does not declare image acceptance never
    // submits while images are attached — one notice, everything retained.
    // Enter-time adjudication applies the same policy for unclaimed lines
    // inside the command source itself.
    const before = this.snapshot
    if (before.phase === 'claimed' && this.imageIds.length > 0 && before.claim?.images !== true) {
      this.notify('error', this.deps.commandImages.unsupportedNotice(before.claim?.token ?? before.draft))
      return
    }
    this.run(this.core.dispatch({ type: 'enter', mode, hasAttachments: this.imageIds.length > 0 || this.annotations.length > 0 }))
    const phase = this.snapshot.phase
    if (phase === 'adjudicating' || phase === 'submitting') {
      this.deps.popup?.()?.dismiss()
      this.deps.inputTriggers?.()?.track(this.snapshot.draft, 0, { tier: 'frozen' }, this.snapshot.draftRev)
    }
  }

  /**
   * Feed a draft/caret change through trigger detection (guard derived from
   * the machine phase).
   * @param draft - live draft text.
   * @param caret - caret position in draft coordinates.
   */
  track(draft: string, caret: number): void {
    this.deps.inputTriggers?.()?.track(draft, caret, { tier: guardOf(this.snapshot.phase) }, this.snapshot.draftRev)
  }

  /**
   * Keyboard arbitration while the menu is open.
   * @param key - the intercepted key.
   * @param composing - IME composition guard state.
   * @returns the menu's verdict; 'pass' when no pipeline is mounted.
   */
  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome {
    return this.deps.inputTriggers?.()?.arbitrate(key, composing) ?? 'pass'
  }

  /**
   * Steer every still-pending queued message into the running turn (the
   * empty-draft accelerated-Enter gesture). Execution belongs to the hub's
   * queue choreography; absent dep = the gesture falls back to the machine's
   * empty-draft no-op.
   */
  steerQueue(): void {
    this.deps.steerQueue?.()
  }

  /**
   * Space adjudication over the controller's hot state.
   * @returns true = a claim/insert was applied — the caller preventDefaults.
   */
  space(): boolean {
    const inputTriggers = this.deps.inputTriggers?.()
    if (inputTriggers === undefined) return false
    const consumed = inputTriggers.onSpace()
    // Machine-driven draft replacement never passes through onChange, so
    // re-track: the caret lands after the token, where detection sees
    // whitespace and closes the menu.
    if (consumed) {
      const next = this.snapshot
      inputTriggers.track(next.draft, next.draft.length, { tier: guardOf(next.phase) }, next.draftRev)
    }
    return consumed
  }

  /** Dismiss the popupSelect shell (any interaction outside the box). */
  dismissPopup(): void {
    this.deps.popup?.()?.dismiss()
  }

  /**
   * Hot plain-text reference lexicon source for the decoration scan
   * (the plain-text-reference decision;
   * see .agents/notes/implemented/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md):
   * delegates to the controller's aggregated store. Stable
   * identity per shell; without a pipeline the snapshot is the empty Map and
   * subscribers never fire.
   */
  readonly lexicon: ObservableSnapshot<ReadonlyMap<'/' | '@', readonly string[]>> = {
    getSnapshot: () => this.deps.inputTriggers?.()?.lexicon.getSnapshot() ?? EMPTY_LEXICON,
    subscribe: fn => this.deps.inputTriggers?.()?.lexicon.subscribe(fn) ?? (() => {}),
  }

  /**
   * Apply one command claim (scoped begin-command event listener body).
   * @param claim - the command claim from the pick path.
   * @param span - pick-time span snapshot.
   * @returns whether the machine accepted (phase + span CAS passed and the draft mutated).
   */
  beginCommand(claim: CommandClaim, span: TokenSpan): boolean {
    const before = this.core.state.draftRev
    this.run(this.core.dispatch({ type: 'begin-command', claim, span }))
    return this.core.state.phase === 'claimed' && this.core.state.draftRev !== before
  }

  /**
   * Apply one reference insertion (scoped insert-reference event listener body).
   * @param ref - the reference insertion from the pick path.
   * @param span - pick-time span snapshot.
   * @returns whether the machine accepted.
   */
  insertReference(ref: ReferenceInsert, span: TokenSpan): boolean {
    const before = this.core.state.draftRev
    this.run(this.core.dispatch({ type: 'insert-ref', reference: ref, span }))
    return this.core.state.draftRev !== before
  }

  /**
   * Consume one command token after business success (scoped consume-token
   * event listener body). Span guard: revision CAS then splice; bare-token
   * guard: trimmed-draft equality then clear.
   * @param guard - exact span or bare-token guard.
   * @returns whether the token was consumed.
   */
  consumeToken(guard: ConsumeTokenRequest['guard']): boolean {
    const snapshot = this.core.state
    if (guard.kind === 'span') {
      if (guard.span.draftRev !== snapshot.draftRev) return false
      const draft = snapshot.draft
      this.setDraft(draft.slice(0, guard.span.start) + draft.slice(guard.span.end))
      return true
    }
    if (snapshot.draft.trim() !== guard.token) return false
    this.setDraft('')
    return true
  }

  /**
   * Insert plain reference text over the pick-time span (scoped insert-text
   * event listener body; plain-text-reference decision, web-input-machine
   * note). Same CAS-then-splice shape as the
   * consume-token span branch: the machine sees an ordinary draft-changed
   * transaction (one undo step), no occurrence is minted — the chip look is
   * a scan-derived decoration, never state.
   * @param text - the plain reference text to splice in (e.g. `/name `).
   * @param span - pick-time span snapshot (draftRev CAS).
   * @param keepCompleting - re-track at the caret after the splice so an open
   * token (a directory pick's trailing slash) reopens the menu.
   * @returns whether the text was applied.
   */
  insertText(text: string, span: TokenSpan, keepCompleting = false): boolean {
    const snapshot = this.core.state
    if (span.draftRev !== snapshot.draftRev) return false
    const draft = snapshot.draft
    this.setDraft(draft.slice(0, span.start) + text + draft.slice(span.end))
    if (keepCompleting) {
      // Machine-driven draft replacement never passes through onChange, so
      // re-track at the caret inside the still-open token (see space()).
      const next = this.snapshot
      this.deps.inputTriggers?.()?.track(next.draft, span.start + text.length, { tier: guardOf(next.phase) }, next.draftRev)
    }
    return true
  }

  /**
   * Surface a notice from outside the machine (detached command results).
   * @param level - severity tier.
   * @param text - notice body.
   */
  notify(level: 'info' | 'error', text: string): void {
    this.noticeSeq += 1
    this.notices.set({ level, text, seq: this.noticeSeq })
  }

  // ---- wiring-layer extras (not on the frozen SessionInput face) ----

  /** Teardown: abort any in-flight attempt and stop accepting async settlements. */
  dispose(): void {
    this.disposed = true
    this.run(this.core.dispatch({ type: 'release' }))
  }

  /** Read the live machine state (guard derivation reads here). */
  get snapshot(): InputState {
    return this.state.getSnapshot()
  }

  /**
   * Bind the draft persistence mirror (chat store write). Adopt-on-bind: the
   * store draft may hold a persisted value from a previous mount; the caller
   * seeds it via setDraft BEFORE binding, and afterwards every machine-adopted
   * draft mirrors out.
   * @param write - store draft write.
   * @returns the unbind disposer.
   */
  bindMirror(write: (text: string, annotations?: readonly PersistedResponseAnnotation[]) => void): () => void {
    this.mirrorFn = write
    return () => {
      if (this.mirrorFn === write) this.mirrorFn = undefined
    }
  }

  // ---- effect executor ----

  private run(effects: readonly InputEffect[]): void {
    for (const fx of effects) this.execute(fx)
    this.publish()
  }

  private execute(fx: InputEffect): void {
    switch (fx.type) {
      case 'notice': {
        this.noticeSeq += 1
        this.notices.set({ level: fx.level, text: fx.text, seq: this.noticeSeq })
        return
      }
      case 'adjudicate': {
        this.adjudicate(fx.attempt, fx.draft)
        return
      }
      case 'begin-submit': {
        this.beginSubmit(fx.attempt, fx.claim, fx.args)
        return
      }
      case 'default-sink': {
        this.sinkSerialized(fx.attempt, fx.draft, fx.mode)
        return
      }
      default:
        return // machine-internal effects (mirror rides publish)
    }
  }

  /**
   * Prompt serialization before the sink: expand each
   * inline reference range to its owner's model form via the session controller's
   * codec routing. Owner missing / serialize failure / disposal blocks the
   * send — notice + draft and chips retained, never a silent downgrade to
   * the clipboard text. Chip-free drafts skip the async detour.
   */
  private sinkSerialized(attempt: SubmitAttempt, draft: string, mode: InputSubmitMode): void {
    const imageIds = [...this.imageIds]
    const annotations = this.annotations
    const occurrences = this.core.state.occurrences
    if (occurrences.length === 0) {
      const text = withAnnotations(annotations, draft.trim(), draft.trim())
      this.settleSubmit(
        attempt,
        annotations.length === 0
          ? this.callSink(text.modelText, imageIds, mode, attempt.signal)
          : this.callSink(text.modelText, imageIds, mode, attempt.signal, text.displayText),
        imageIds,
        annotations,
      )
      return
    }
    const inputTriggers = this.deps.inputTriggers?.()
    const controller = new AbortController()
    void Promise.all(occurrences.map(async (o) => {
      if (inputTriggers === undefined) throw new Error(`no serializer for reference source "${o.source}"`)
      return {
        offset: o.offset,
        length: o.length,
        text: await inputTriggers.serializeReference(o.source, o.ref, controller.signal),
      }
    })).then(
      (parts) => {
        if (this.dead(attempt)) return
        // Splice model forms over their display ranges (offsets are draft-time;
        // parts arrive offset-sorted since the table is).
        let out = ''
        let cursor = 0
        const references: ResponseAnnotationProjection[] = []
        for (const part of parts) {
          out += draft.slice(cursor, part.offset)
          references.push({
            modelStart: out.length,
            displayStart: part.offset,
            model: part.text,
            display: draft.slice(part.offset, part.offset + part.length),
          })
          out += part.text
          cursor = part.offset + part.length
        }
        out += draft.slice(cursor)
        const modelLeading = out.length - out.trimStart().length
        const displayLeading = draft.length - draft.trimStart().length
        const displayEnd = draft.trimEnd().length
        const projections = references.map(reference => ({
          ...reference,
          modelStart: reference.modelStart - modelLeading,
          displayStart: reference.displayStart - displayLeading,
          display: reference.display.slice(0, Math.max(0, displayEnd - reference.displayStart)),
        }))
        const text = withAnnotations(annotations, out.trim(), draft.trim(), projections)
        this.settleSubmit(
          attempt,
          this.callSink(text.modelText, imageIds, mode, attempt.signal, text.displayText),
          imageIds,
          annotations,
        )
      },
      (error: unknown) => {
        controller.abort()
        if (this.dead(attempt)) return
        const message = error instanceof Error ? error.message : String(error)
        this.run(this.core.dispatch({ type: 'submit-settled', attempt, ok: false, message }))
      },
    )
  }

  /** Synchronous service-resolution failures settle through the same path as rejected sends. */
  private callSink(...args: Parameters<SessionInputDeps['defaultSink']>): Promise<SubmitOutcome> {
    try {
      return this.deps.defaultSink(...args)
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** Remove exactly the annotations a successful send captured, renumbering later additions. */
  private consumeAnnotations(submitted: readonly ResponseAnnotationPayload[]): void {
    if (submitted.length === 0) return
    const sent = new Set(submitted)
    this.annotations = renumbered(this.annotations.filter(annotation => !sent.has(annotation)))
  }

  /** Settle one admission attempt; successful sends consume only their captured images and annotations. */
  private settleSubmit(
    attempt: SubmitAttempt,
    pending: Promise<SubmitOutcome>,
    imageIds: readonly DraftAttachmentId[] = [],
    annotations: readonly ResponseAnnotationPayload[] = [],
  ): void {
    pending.then(
      (outcome) => {
        if (this.dead(attempt)) return
        if (outcome.kind === 'success' && imageIds.length > 0) {
          const submitted = new Set(imageIds)
          this.imageIds = this.imageIds.filter(id => !submitted.has(id))
        }
        if (outcome.kind === 'success') this.consumeAnnotations(annotations)
        this.run(this.core.dispatch({
          type: 'submit-settled',
          attempt,
          ok: outcome.kind === 'success',
          outcome,
        }))
      },
      (error: unknown) => {
        if (this.dead(attempt)) return
        this.run(this.core.dispatch({
          type: 'submit-settled',
          attempt,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }))
      },
    )
  }

  /** Enter adjudication: poll the session controller; failure = notice + draft retained (never a silent downgrade). */
  private adjudicate(attempt: SubmitAttempt, draft: string): void {
    const inputTriggers = this.deps.inputTriggers?.()
    if (inputTriggers === undefined) {
      // No pipeline mounted: the '/' line is an ordinary message.
      this.run(this.core.dispatch({ type: 'adjudicated', attempt, outcome: undefined }))
      return
    }
    inputTriggers.adjudicate(draft.trim(), attempt.signal, { images: this.imageIds.length }).then(
      (outcome: PickOutcome) => {
        if (this.dead(attempt)) return
        this.run(this.core.dispatch({ type: 'adjudicated', attempt, outcome }))
      },
      (error: unknown) => {
        if (this.dead(attempt)) return
        const message = error instanceof Error ? error.message : String(error)
        this.run(this.core.dispatch({ type: 'adjudication-failed', attempt, message }))
      },
    )
  }

  /**
   * The submit transaction: claim.submit against the session scope; ok maps
   * from the outcome kind. An accepting claim receives the serialized draft
   * images, which are cleared and released only on a success outcome; a
   * failure (serialize, transport, or handler error) keeps draft and images
   * for correction.
   */
  private beginSubmit(attempt: SubmitAttempt, claim: CommandClaim, args: string): void {
    const imageIds = claim.images === true ? [...this.imageIds] : []
    Promise.resolve()
      .then(async () => {
        const images = imageIds.length > 0 ? await this.deps.commandImages.serialize(imageIds) : []
        // Serialization may outlive the attempt (large files, session
        // teardown); a dead attempt must not reach the Host executor.
        if (this.dead(attempt)) return undefined
        return claim.submit(args, this.deps.actx, images)
      })
      .then(
        (outcome) => {
          if (outcome === undefined || this.dead(attempt)) return
          if (outcome.kind === 'success' && imageIds.length > 0) {
            const submitted = new Set(imageIds)
            this.imageIds = this.imageIds.filter(id => !submitted.has(id))
            this.deps.commandImages.release(imageIds)
          }
          this.run(this.core.dispatch({
            type: 'submit-settled', attempt, ok: outcome.kind === 'success', outcome,
            ...(outcome.kind === 'error' && outcome.text === undefined ? { message: 'command failed' } : {}),
          }))
        },
        (error: unknown) => {
          if (this.dead(attempt)) return
          const message = error instanceof Error ? error.message : String(error)
          this.run(this.core.dispatch({ type: 'submit-settled', attempt, ok: false, message }))
        },
      )
  }

  /** Late-settlement guard: superseded attempts and disposed facades drop silently. */
  private dead(attempt: SubmitAttempt): boolean {
    return this.disposed || attempt.signal.aborted
  }

  private compose(): InputState {
    const core = this.core.state
    return {
      ...core,
      imageIds: this.imageIds,
      annotations: this.annotations,
      queue: this.deps.queue?.getSnapshot() ?? EMPTY_QUEUE,
    }
  }

  private publish(): void {
    const next = this.compose()
    this.state.set(next)
    let mirroredDraft = ''
    let cursor = 0
    for (const occurrence of next.occurrences) {
      mirroredDraft += next.draft.slice(cursor, occurrence.offset) + occurrence.clipboardText
      cursor = occurrence.offset + occurrence.length
    }
    mirroredDraft += next.draft.slice(cursor)
    const annotations: PersistedResponseAnnotation[] = next.annotations.map(annotation => ({
      offset: RESPONSE_ANNOTATION_ATTACHMENT_OFFSET,
      ref: JSON.stringify(annotation),
    }))
    const annotationKey = annotations.map(item => item.ref).join('\n')
    if (mirroredDraft !== this.lastMirroredDraft || annotationKey !== this.lastMirroredAnnotationKey) {
      this.lastMirroredDraft = mirroredDraft
      this.lastMirroredAnnotationKey = annotationKey
      if (annotations.length > 0) this.mirrorFn?.(mirroredDraft, annotations)
      else this.mirrorFn?.(mirroredDraft)
    }
  }
}
