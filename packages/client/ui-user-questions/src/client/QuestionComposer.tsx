import {
  useCallback, useEffect, useMemo, useReducer, useRef, useState,
  type ChangeEvent, type KeyboardEvent,
} from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutline14, IconChevronDownOutline14, IconChevronLeftOutline14,
  IconChevronRightOutline14, IconChevronUpOutline14, IconCloseOutline16,
  IconEditOutline16, IconMicrophoneOutline16, IconStopFill16, MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IDLE_DICTATION_STATE, reduceDictation, resolveIndonesianTranscriptionUrl,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  PendingQuestion, planReviewOf,
  type QuestionAnswer, type QuestionComposerProps,
} from './contract/slots.ts'
import { PlanReviewPanel } from './PlanReviewPanel.tsx'
import css from './QuestionComposer.module.css'

interface DraftAnswer {
  selected: string[]
  custom: string
  skipped: boolean
}

/**
 * Displayed feedback: validation feedback is stored as a dictionary KEY and
 * translated at render, so already-shown feedback follows a locale switch;
 * runtime failure messages (finished strings from the wire) pass through
 * verbatim.
 */
type Feedback = { key: 'error.incomplete' | 'error.unanswered' } | { text: string }

/**
 * Split the conventional recommendation suffix without changing the answer value.
 * @param label - Original option label returned if selected.
 * @returns Display label plus recommendation state.
 */
export function parseRecommendedLabel(label: string): { label: string; recommended: boolean } {
  const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i
  return suffix.test(label)
    ? { label: label.replace(suffix, ''), recommended: true }
    : { label, recommended: false }
}

/** Return whether a text-field key event belongs to an active IME composition. */
function isComposing(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  // keyCode 229 is the legacy IME-composition signal engines emit without isComposing.
  return event.nativeEvent.isComposing || Reflect.get(event.nativeEvent, 'keyCode') === 229
}

/** The free-text answer field shared by both question shapes. */
interface AnswerFieldProps {
  /** Which shape the field takes: the custom row's inline column, or the optionless question's own framed block. */
  variant: 'inline' | 'block'
  /** Current draft text. */
  value: string
  /** Empty-field prompt. */
  placeholder: string
  /** Whether a submission in flight has frozen the field. */
  disabled: boolean
  /** Whether this field takes focus on mount. */
  autoFocus?: boolean
  /** Called when the field takes focus. */
  onFocus?: () => void
  /** Called with each edit of the draft. */
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void
  /** Called with each key press, before the browser's own handling. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  /** Add one completed transcript to the answer draft. */
  onTranscript: (transcript: string) => void
  /** Question-namespace translator used by the dictation status surface. */
  t: QuestionComposerProps['t']
}

/** Format a recording duration for the live status without locale-dependent punctuation. */
function dictationDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0')
  return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`
}

/**
 * Auto-growing free-text answer: a textarea, so a long answer soft-wraps and
 * Shift+Enter breaks a line, over a hidden mirror that owns the height.
 *
 * The mirror renders the draft plus a trailing newline in normal flow and so
 * sizes the grid row (counting rows by '\n' cannot see soft wraps); the
 * textarea shares that one cell and stretches to it, and `rows={1}` keeps the
 * control's own intrinsic height out of the row sizing so the mirror alone
 * decides. Past the mirror's cap the textarea scrolls itself — it is the only
 * scrollport in the stack, there being no second glyph layer to keep aligned.
 * Mirror and textarea MUST share font, line-height, padding and wrapping rules
 * or the two heights diverge.
 *
 * @param props - field shape, draft text, and the field's event handlers.
 * @returns The mirrored auto-growing field.
 */
function AnswerField(props: AnswerFieldProps) {
  const [dictation, dispatchDictation] = useReducer(reduceDictation, IDLE_DICTATION_STATE)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recordedAudioRef = useRef<Blob | null>(null)
  const operationRef = useRef(0)
  const transcriptionAbortRef = useRef<AbortController | null>(null)

  const releaseRecording = useCallback((): void => {
    streamRef.current?.getTracks().forEach((track) => { track.stop() })
    streamRef.current = null
    recorderRef.current = null
  }, [])

  const cancelDictation = useCallback((reset = true): void => {
    operationRef.current += 1
    transcriptionAbortRef.current?.abort()
    transcriptionAbortRef.current = null
    const recorder = recorderRef.current
    if (recorder !== null) {
      recorder.ondataavailable = null
      recorder.onerror = null
      recorder.onstop = null
      if (recorder.state !== 'inactive') recorder.stop()
    }
    releaseRecording()
    recordedAudioRef.current = null
    if (reset) dispatchDictation({ type: 'reset' })
  }, [releaseRecording])

  useEffect(() => () => { cancelDictation(false) }, [cancelDictation])
  useEffect(() => {
    if (props.disabled && (dictation.phase === 'requesting-permission'
      || dictation.phase === 'recording' || dictation.phase === 'transcribing')) {
      cancelDictation()
    }
  }, [cancelDictation, dictation.phase, props.disabled])
  useEffect(() => {
    if (dictation.phase !== 'recording') return
    const tick = (): void => { dispatchDictation({ type: 'tick', at: Date.now() }) }
    const timer = globalThis.setInterval(tick, 250)
    return () => { globalThis.clearInterval(timer) }
  }, [dictation.phase])

  const transcribeDictation = useCallback(async (audio: Blob, operation: number): Promise<void> => {
    const controller = new AbortController()
    transcriptionAbortRef.current = controller
    try {
      const form = new FormData()
      form.append('audio', audio, 'dictation.webm')
      form.append('language', 'auto')
      const response = await fetch(resolveIndonesianTranscriptionUrl(), {
        method: 'POST', body: form, signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const result = await response.json() as { text?: unknown }
      const transcript = typeof result.text === 'string' ? result.text.trim() : ''
      if (transcript === '') throw new Error('No speech was recognized')
      if (operationRef.current !== operation) return
      recordedAudioRef.current = null
      props.onTranscript(transcript)
      dispatchDictation({ type: 'transcribed', transcript })
      requestAnimationFrame(() => {
        if (operationRef.current === operation) inputRef.current?.focus()
      })
    } catch (cause) {
      if (controller.signal.aborted || operationRef.current !== operation) return
      const message = cause instanceof Error ? cause.message : String(cause)
      dispatchDictation({
        type: 'transcription-failed',
        message: props.t('custom.dictation.failed', { message }),
      })
    } finally {
      if (transcriptionAbortRef.current === controller) transcriptionAbortRef.current = null
    }
  }, [props])

  const requestDictation = useCallback(async (): Promise<void> => {
    if (props.disabled) return
    const operation = operationRef.current + 1
    operationRef.current = operation
    recordedAudioRef.current = null
    dispatchDictation({ type: 'request-permission' })
    try {
      const mediaDevices = (navigator as { mediaDevices?: MediaDevices }).mediaDevices
      if (mediaDevices?.getUserMedia === undefined) throw new Error('Microphone capture is unavailable')
      const Recorder = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder
      if (Recorder === undefined) throw new Error('Audio recording is unavailable')
      const stream = await mediaDevices.getUserMedia({ audio: true })
      if (operationRef.current !== operation) {
        stream.getTracks().forEach((track) => { track.stop() })
        return
      }
      streamRef.current = stream
      const preferred = Recorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : undefined
      const recorder = new Recorder(stream, preferred === undefined ? undefined : { mimeType: preferred })
      const chunks: BlobPart[] = []
      let recorderFailed = false
      recorderRef.current = recorder
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }
      recorder.onerror = (event) => {
        if (operationRef.current !== operation) return
        recorderFailed = true
        const detail = event as Event & { readonly error?: DOMException }
        const message = detail.error?.message ?? 'Media recorder error'
        // Invalidate before stopping tracks: some implementations enqueue
        // `stop` beside `error`, and that stale callback must not transcribe.
        cancelDictation(false)
        dispatchDictation({
          type: 'transcription-failed',
          message: props.t('custom.dictation.failed', { message }),
        })
      }
      recorder.onstop = () => {
        if (operationRef.current !== operation || recorderFailed) return
        const audio = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
        recordedAudioRef.current = audio
        releaseRecording()
        void transcribeDictation(audio, operation)
      }
      recorder.start(250)
      dispatchDictation({ type: 'permission-granted', at: Date.now() })
    } catch (cause) {
      if (operationRef.current !== operation) return
      releaseRecording()
      const message = cause instanceof Error ? cause.message : String(cause)
      dispatchDictation({
        type: 'permission-failed',
        message: props.t('custom.dictation.failed', { message }),
      })
    }
  }, [cancelDictation, props, releaseRecording, transcribeDictation])

  const stopDictation = useCallback((): void => {
    const recorder = recorderRef.current
    if (dictation.phase !== 'recording' || recorder === null || recorder.state !== 'recording') return
    dispatchDictation({ type: 'stop-recording' })
    recorder.stop()
  }, [dictation.phase])

  const toggleDictation = (): void => {
    if (dictation.phase === 'recording') stopDictation()
    else if (dictation.phase !== 'requesting-permission' && dictation.phase !== 'transcribing') {
      void requestDictation()
    }
  }

  const retryDictation = (): void => {
    if (dictation.phase !== 'error' || props.disabled) return
    if (dictation.retry === 'transcription' && recordedAudioRef.current !== null) {
      const operation = operationRef.current + 1
      operationRef.current = operation
      dispatchDictation({ type: 'retry-transcription' })
      void transcribeDictation(recordedAudioRef.current, operation)
      return
    }
    void requestDictation()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'm') {
      event.preventDefault()
      toggleDictation()
      return
    }
    if (event.key === 'Escape' && (dictation.phase === 'requesting-permission'
      || dictation.phase === 'recording' || dictation.phase === 'transcribing')) {
      event.preventDefault()
      cancelDictation()
      return
    }
    props.onKeyDown(event)
  }

  const statusText = dictation.phase === 'requesting-permission'
    ? props.t('custom.dictation.requestingPermission')
    : dictation.phase === 'recording'
      ? `${props.t('custom.dictation.recording')} ${dictationDuration(dictation.elapsedSeconds)}`
      : dictation.phase === 'transcribing'
        ? props.t('custom.dictation.transcribing')
        : dictation.phase === 'review'
          ? props.t('custom.dictation.success')
          : dictation.phase === 'error' ? dictation.message : null
  const controlLabel = dictation.phase === 'recording'
    ? props.t('custom.dictation.stop')
    : dictation.phase === 'requesting-permission'
      ? props.t('custom.dictation.requestingPermission')
      : dictation.phase === 'transcribing'
        ? props.t('custom.dictation.transcribing')
        : props.t('custom.dictation.start')

  return (
    <div className={clsx(css.field, props.variant === 'inline' ? css.customInline : css.customBlock)}>
      <div className={css.fieldStack}>
        <div aria-hidden className={css.fieldMirror}>{`${props.value}\n`}</div>
        <textarea
          ref={inputRef}
          autoFocus={props.autoFocus}
          className={css.fieldInput}
          value={props.value}
          disabled={props.disabled}
          rows={1}
          placeholder={props.placeholder}
          onFocus={props.onFocus}
          onChange={props.onChange}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className={clsx(css.dictationButton, dictation.phase === 'recording' && css.dictationButtonRecording)}
          aria-label={controlLabel}
          aria-keyshortcuts="Control+Shift+M Meta+Shift+M"
          aria-pressed={dictation.phase === 'recording'}
          title={controlLabel}
          data-question-dictation={dictation.phase}
          disabled={props.disabled || dictation.phase === 'requesting-permission'
            || dictation.phase === 'transcribing'}
          onMouseDown={(event) => {
            event.preventDefault()
            inputRef.current?.focus({ preventScroll: true })
          }}
          onClick={toggleDictation}
        >
          {dictation.phase === 'recording'
            ? <IconStopFill16 size={14} />
            : <IconMicrophoneOutline16 size={16} />}
        </button>
      </div>
      {statusText !== null && (
        <div
          className={css.dictationStatus}
          data-question-dictation-status={dictation.phase}
          role={dictation.phase === 'error' ? 'alert' : 'status'}
          aria-live={dictation.phase === 'recording' ? 'off' : 'polite'}
          aria-atomic="true"
        >
          <span className={css.dictationIndicator} aria-hidden />
          <span className={css.dictationStatusText}>{statusText}</span>
          {dictation.phase === 'error' && (
            <button type="button" className={css.dictationRetry} onClick={retryDictation}>
              {props.t('custom.dictation.retry')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Composer takeover boundary; the carrier key keys local drafts, so a
 * same-request replay (same key, new carrier object) preserves them.
 *
 * One takeover, two shapes: a request that declares a presentation intent this
 * package renders takes that shape (a plan review is one decision over one
 * plan, not a question set), and every other request takes the generic flow.
 * The routing lives here, at the one entry that owns the composer seat, so
 * neither shape can claim a request the other is already rendering.
 *
 * @param props - the selector-matched pending question carrier plus the framework standard kit.
 * @returns The question flow, or the intent's own surface, for this request.
 */
export function QuestionComposer(props: QuestionComposerProps) {
  // Domain-face mint rides the carrier's stable identity (never minted in a
  // select/render dispatch — per-dispatch minting would churn memo identity).
  const question = useMemo(() => new PendingQuestion(props.matched), [props.matched])
  const review = useMemo(() => planReviewOf(question.questions), [question])
  return review === undefined
    ? <QuestionFlow key={question.key} pending={question} t={props.t} />
    : <PlanReviewPanel key={question.key} pending={question} review={review} t={props.t} />
}

function QuestionFlow({ pending, t }: { pending: PendingQuestion } & Pick<QuestionComposerProps, 't'>) {
  const questions = pending.questions
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<DraftAnswer[]>(() => questions.map(() => ({
    selected: [], custom: '', skipped: false,
  })))
  const [busy, setBusy] = useState<'answer' | 'cancel' | null>(null)
  const [error, setError] = useState<Feedback | null>(null)
  // Collapsed to the header strip so the conversation above stays readable
  // while the user decides; the drafts survive because the state lives here.
  const [minimized, setMinimized] = useState(false)
  // The free-form textarea autofocuses on first presentation; re-expanding a
  // collapsed question must not steal focus from the expand toggle back into
  // the input, so focus is granted once per question index.
  const focusedQuestions = useRef(new Set<number>())
  // index stays in bounds (every setIndex site clamps) and drafts mirrors questions 1:1.
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const question = questions[index]!
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const draft = drafts[index]!
  const hasOptions = (question.options?.length ?? 0) > 0

  const cancelFlow = (): void => {
    setBusy('cancel')
    setError(null)
    void pending.cancel().catch((cause: unknown) => {
      setBusy(null)
      setError({ text: cause instanceof Error ? cause.message : String(cause) })
    })
  }

  const updateDraft = (update: (current: DraftAnswer) => DraftAnswer): void => {
    setDrafts(current => current.map((item, itemIndex) => itemIndex === index ? update(item) : item))
    setError(null)
  }

  const choose = (label: string): void => {
    updateDraft((current) => {
      if (question.multiSelect === true) {
        const selected = current.selected.includes(label)
          ? current.selected.filter(item => item !== label)
          : [...current.selected, label]
        return { ...current, selected, skipped: false }
      }
      return { selected: [label], custom: '', skipped: false }
    })
    if (question.multiSelect !== true && index < questions.length - 1) {
      setIndex(current => current + 1)
    }
  }

  const answered = (item: DraftAnswer): boolean =>
    item.selected.length > 0 || item.custom.trim() !== ''

  const completed = (item: DraftAnswer): boolean => answered(item) || item.skipped

  const submitDrafts = (values: DraftAnswer[]): void => {
    const missing = values.findIndex(item => !completed(item))
    if (missing >= 0) {
      setIndex(missing)
      setError({ key: 'error.incomplete' })
      return
    }
    const answer: QuestionAnswer = {
      answers: questions.map((item, itemIndex) => {
        const value = values[itemIndex] as DraftAnswer
        if (value.skipped) return { id: item.id, selected: [] }
        const custom = value.custom.trim()
        return {
          id: item.id,
          selected: custom === '' || item.multiSelect === true ? value.selected : [],
          ...(custom === '' ? {} : { custom }),
        }
      }),
    }
    setBusy('answer')
    setError(null)
    void pending.answer(answer).catch((cause: unknown) => {
      setBusy(null)
      setError({ text: cause instanceof Error ? cause.message : String(cause) })
    })
  }

  const continueFlow = (): void => {
    if (!answered(draft)) {
      setError({ key: 'error.unanswered' })
      return
    }
    if (index < questions.length - 1) {
      setIndex(current => current + 1)
      setError(null)
      return
    }
    submitDrafts(drafts)
  }

  // Shared by the inline custom field and the optionless one: a multi-select
  // draft retains checked labels, while a single-select custom answer replaces
  // its selection. Enter continues the flow, Shift+Enter breaks a line.
  const draftCustom = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const value = event.target.value
    updateDraft(current => ({
      ...current,
      selected: question.multiSelect === true ? current.selected : [],
      custom: value,
      skipped: false,
    }))
  }

  const appendTranscript = (transcript: string): void => {
    updateDraft((current) => {
      const separator = current.custom === '' || /\s$/u.test(current.custom) ? '' : ' '
      return {
        ...current,
        selected: question.multiSelect === true ? current.selected : [],
        custom: `${current.custom}${separator}${transcript}`,
        skipped: false,
      }
    })
  }

  const continueFromCustom = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || isComposing(event)) return
    event.preventDefault()
    continueFlow()
  }

  const skipQuestion = (): void => {
    const nextDrafts = drafts.map((item, itemIndex) => itemIndex === index
      ? { selected: [], custom: '', skipped: true }
      : item)
    setDrafts(nextDrafts)
    setError(null)
    if (index < questions.length - 1) {
      setIndex(current => current + 1)
      return
    }
    submitDrafts(nextDrafts)
  }

  return (
    <div className={css.frame} data-question-key={pending.key}>
      <section
        className={clsx(css.card, minimized && css.cardMinimized)}
        aria-labelledby={`question-${pending.key}-${String(index)}`}
      >
        <header className={css.header}>
          <div className={css.headingBlock}>
            {question.header !== undefined && <div className={css.eyebrow}>{question.header}</div>}
            <h2 className={css.title} id={`question-${pending.key}-${String(index)}`}>
              {question.question}
            </h2>
          </div>
          <div className={css.headerActions}>
            <button
              type="button" className={css.iconButton}
              aria-label={t(minimized ? 'nav.maximize' : 'nav.minimize')}
              title={t(minimized ? 'nav.maximize' : 'nav.minimize')}
              aria-expanded={!minimized}
              disabled={busy !== null}
              onClick={() => { setMinimized(current => !current) }}
            >
              {minimized ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
            </button>
            <button
              type="button" className={css.iconButton} aria-label={t('nav.cancel')}
              title={t('nav.cancel')}
              disabled={busy !== null} onClick={cancelFlow}
            >
              <IconCloseOutline16 />
            </button>
          </div>
        </header>

        {!minimized && (
          <>
            <div className={css.body} data-question-scroll>
              {question.detail !== undefined && (
                <div className={css.detail}><MarkdownText text={question.detail} /></div>
              )}
              <div className={css.options} role={question.multiSelect === true ? 'group' : 'radiogroup'}>
                {(question.options ?? []).map((option, optionIndex) => {
                  const selected = draft.selected.includes(option.label)
                  const display = parseRecommendedLabel(option.label)
                  return (
                    <button
                      type="button" key={`${option.label}-${String(optionIndex)}`}
                      className={clsx(css.option, selected && question.multiSelect !== true && css.optionSelected)}
                      role={question.multiSelect === true ? 'checkbox' : 'radio'}
                      aria-checked={selected}
                      aria-label={display.label}
                      disabled={busy !== null}
                      onClick={() => { choose(option.label) }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' || !drafts.every(completed)) return
                        event.preventDefault()
                        submitDrafts(drafts)
                      }}
                    >
                      {question.multiSelect === true
                        ? (
                          <span className={clsx(css.checkbox, selected && css.checkboxChecked)} aria-hidden="true">
                            {selected && <IconCheckOutline14 size={12} />}
                          </span>
                        )
                        : <span className={css.number}>{optionIndex + 1}</span>}
                      <span className={css.optionCopy}>
                        <span className={css.optionLine}>
                          <span className={css.optionLabel}>{display.label}</span>
                          {display.recommended && (
                            <span className={css.badge}>{t('option.recommended')}</span>
                          )}
                          {option.description !== undefined && (
                            <span className={css.description}>{option.description}</span>
                          )}
                        </span>
                      </span>
                    </button>
                  )
                })}

                {hasOptions
                  ? (
                    <div className={clsx(css.customRow, draft.custom !== '' && css.customRowActive)}>
                      {question.multiSelect === true
                        ? (
                          <span
                            className={clsx(css.checkbox, draft.custom !== '' && css.checkboxChecked)}
                            aria-hidden="true"
                          >
                            {draft.custom !== '' && <IconCheckOutline14 size={12} />}
                          </span>
                        )
                        : (
                          <span className={css.number} aria-hidden="true">
                            <IconEditOutline16 size={12} />
                          </span>
                        )}
                      <AnswerField
                        key={`${question.id}:${String(index)}`}
                        variant="inline"
                        value={draft.custom}
                        disabled={busy !== null}
                        placeholder={t('custom.placeholder')}
                        t={t}
                        onChange={draftCustom}
                        onKeyDown={continueFromCustom}
                        onTranscript={appendTranscript}
                      />
                    </div>
                  )
                  : (
                    <AnswerField
                      key={`${question.id}:${String(index)}`}
                      autoFocus={!focusedQuestions.current.has(index)}
                      variant="block"
                      value={draft.custom}
                      disabled={busy !== null}
                      placeholder={t('custom.placeholder')}
                      t={t}
                      onFocus={() => { focusedQuestions.current.add(index) }}
                      onChange={draftCustom}
                      onKeyDown={continueFromCustom}
                      onTranscript={appendTranscript}
                    />
                  )}
              </div>
            </div>

            <footer className={css.footer}>
              <div className={css.pager}>
                <button
                  type="button" className={css.iconButton} aria-label={t('nav.prev')}
                  disabled={index === 0 || busy !== null}
                  onClick={() => { setIndex(index - 1); setError(null) }}
                >
                  <IconChevronLeftOutline14 />
                </button>
                <span className={css.progress}>{index + 1} / {questions.length}</span>
                <button
                  type="button" className={css.iconButton} aria-label={t('nav.next')}
                  disabled={index === questions.length - 1 || busy !== null}
                  onClick={() => { setIndex(index + 1); setError(null) }}
                >
                  <IconChevronRightOutline14 />
                </button>
              </div>
              <div className={css.feedback} role="status">
                {error === null ? null : 'key' in error ? t(error.key) : error.text}
              </div>
              <div className={css.footerActions}>
                <Button variant="outline" disabled={busy !== null} onClick={skipQuestion}>
                  {t('action.skip')}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy !== null || !answered(draft)} onClick={continueFlow}
                >
                  {busy === 'answer'
                    ? t('submitting')
                    : index === questions.length - 1 ? t('submit') : t('action.next')}
                </Button>
              </div>
            </footer>
          </>
        )}
      </section>
    </div>
  )
}
