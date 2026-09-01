/** The default composer body: the 'conversation.composer.bar' slot entry.
 * Machine state arrives through the standard provide channel
 * (useInput + inputActions); the keyboard/DOM command face and stop arrive
 * through this entry's own inject, whose hooks compartment binds
 * useNotices/useLexicon; layout-phase inputs (variant, placeholder,
 * region-slot content) ride the owner props. Session facts
 * (running/removed/promptError) are self-selected via useSession. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconMicrophoneOutline16, IconPlusOutline16, IconWarningOutline16, Toast, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: the `plan` projection key merge (the TodoDock posture — the
// composer reads a host-computed value; the domain owns the key).
import type {} from '@deepseek-ai/dsh-plan-mode/client'
// Type-only: the `goal` projection key merge (hint disambiguation).
import type {} from '@deepseek-ai/dsh-goal/client'
// The `imageLimits` projection key merge (intake pre-check) arrives with the
// wire types: apiproxy's sessions contract declares it, and client-runtime's
// api-remotes import already places it in every client program.
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposerBarProps } from '../contract/slots.ts'
import type { InputSubmitMode } from '../contract/composer-submission.ts'
import { deriveDecorations } from '../input/decorations.ts'
import type { DraftDecorations } from '../input/decorations.ts'
import type { EditRange } from '../input/contract.ts'
import {
  parseResponseAnnotationPayload, RESPONSE_ANNOTATION_SOURCE,
} from '../input/response-annotation.ts'
import { attachmentErrorText, imageSizeText } from '../image-labels.ts'
import { ReferenceIcon } from '../reference/ReferenceIcon.tsx'
import { ContextMeter } from './ContextMeter.tsx'
import {
  IDLE_DICTATION_STATE, reduceDictation, resolveIndonesianTranscriptionUrl,
} from './dictation.ts'
import { PermissionSelect } from './PermissionSelect.tsx'
import { isSafariBrowser, repairSafariTextareaLayout } from './safari.ts'
import css from './InputBar.module.css'

/** Decoration product of the no-session state (no machine, empty draft). */
const INERT_DECORATIONS: DraftDecorations = { token: null, chips: [], textRefs: [], hint: null }

const DICTATION_WAVEFORM_BARS = 72
const DICTATION_WAVEFORM_FLOOR = 0.08
/** Target time for one sample to traverse the full visible waveform. */
export const DICTATION_WAVEFORM_TRAVEL_MS = 7_000
const DICTATION_WAVEFORM_STEP_MS = DICTATION_WAVEFORM_TRAVEL_MS / DICTATION_WAVEFORM_BARS

function fallbackWaveformAmplitude(frame: number): number {
  const carrier = (Math.sin(frame * 0.47) + 1) * 0.14
  const detail = (Math.sin(frame * 0.19 + 1.3) + 1) * 0.08
  return Math.min(0.72, DICTATION_WAVEFORM_FLOOR + carrier + detail)
}

function analyserWaveformAmplitude(analyser: AnalyserNode, values: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(values)
  let energy = 0
  for (const value of values) {
    const normalized = (value - 128) / 128
    energy += normalized * normalized
  }
  const rms = Math.sqrt(energy / values.length)
  return Math.max(DICTATION_WAVEFORM_FLOOR, Math.min(1, rms * 3.5))
}

function paintWaveform(element: HTMLSpanElement | null, samples: readonly number[]): void {
  if (element === null) return
  const bars = element.children
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars.item(index)
    if (bar instanceof HTMLElement) {
      bar.style.setProperty('--dictation-amplitude', samples[index]?.toFixed(3) ?? '0.08')
    }
  }
}

function dictationDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0')
  return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`
}

/** The selection and edit family a `beforeinput` recorded, with the draft length it applied to. */
interface PendingEdit {
  readonly start: number
  readonly end: number
  readonly draftLength: number
  readonly inputType: string
}

/**
 * Resolve one edit's range from the record taken before it applied.
 * A selection the edit replaces is the range outright. A caret delete replaces
 * nothing and reports the bare caret, so the removed span is whatever the draft
 * lost, on the side `inputType` names — measured, because one caret gesture can
 * remove a multi-unit grapheme, a word, or a line.
 * @param pending - record taken at `beforeinput`, null when none was seen.
 * @param prevLength - length of the draft the edit applied to.
 * @param nextLength - length of the resulting draft.
 * @returns the exact range, or undefined when the record cannot describe this
 * edit and the machine's diff scan has to recover it.
 */
function editRangeOf(pending: PendingEdit | null, prevLength: number, nextLength: number): EditRange | undefined {
  if (pending === null || pending.draftLength !== prevLength) return undefined
  const { start, end, inputType } = pending
  // A DOM selection cannot invert; the check keeps that a precondition of the
  // math below rather than an assumption about the element.
  if (start > end || end > prevLength) return undefined
  const insertedLength = nextLength - prevLength + (end - start)
  if (insertedLength >= 0) return { start, end, insertedLength }
  if (start !== end) return undefined
  const removed = prevLength - nextLength
  if (inputType.endsWith('Backward')) {
    return removed <= start ? { start: start - removed, end: start, insertedLength: 0 } : undefined
  }
  if (inputType.endsWith('Forward')) {
    return start + removed <= prevLength ? { start, end: start + removed, insertedLength: 0 } : undefined
  }
  return undefined
}

export type InputBarProps = ComposerBarProps

export function InputBar({
  useSession, useInput, inputActions, keyboard, addImages, removeImage, draftImages,
  resolveSubmitMode, toggleCommandMenu, stop, command, t,
  renderSlot, useNotices, useLexicon, useMenuLauncher,
  useProjection, sessionId, variant, disabled: inert = false, blocked,
  workspacePickerOpen = false, onRequestWorkspace,
  placeholder, accessory, overlay, leftItems, rightItems, footer,
}: InputBarProps) {
  const input = useInput(s => s)
  const notice = useNotices(s => s)
  const lexicon = useLexicon(s => s)
  const commandMenuOpen = useMenuLauncher(source => source === 'command')
  const promptError = useSession(s => s.promptError) ?? null
  const running = useSession(s => s.running) ?? false
  const subagent = useSession(s => s.subagent) ?? null
  const removed = useSession(s => s.removed) ?? false
  // Plan mode swaps the textarea placeholder (the projection is the folded
  // host value; owner-prop placeholders — hero, session-unavailable — win).
  const planActive = useProjection('plan', plan => plan !== undefined && (plan.pending ? !plan.active : plan.active))
  // Absent (undefined: no frame yet) and cleared (null) both mean no goal.
  const hasGoal = useProjection('goal', goal => goal != null)
  // Session-maybe: the machine faces are absent together while no session is
  // current; the bar renders the same DOM inert instead of a parallel tree.
  const live = input !== undefined && keyboard !== undefined && inputActions !== undefined
  const draft = input?.draft ?? ''
  const attachments = useMemo(
    () => input === undefined || draftImages === undefined ? [] : draftImages(input.imageIds),
    [draftImages, input?.imageIds],
  )
  const empty = draft.trim() === '' && attachments.length === 0
  // Transient error banner (machine notices, image-intake rejections, and
  // prompt failures): the seq keys the Toast so an identical repeated message
  // restarts the hold-then-fade cycle instead of reusing the faded one.
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const [dictation, dispatchDictation] = useReducer(reduceDictation, IDLE_DICTATION_STATE)
  const [submitModeOverride, setSubmitModeOverride] = useState<InputSubmitMode | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordingStreamRef = useRef<MediaStream | null>(null)
  const waveformRef = useRef<HTMLSpanElement | null>(null)
  const waveformFrameRef = useRef<number | null>(null)
  const waveformAudioRef = useRef<{
    readonly context: AudioContext
    readonly source: MediaStreamAudioSourceNode
    readonly analyser: AnalyserNode
    readonly values: Uint8Array<ArrayBuffer>
  } | null>(null)
  const recordedAudioRef = useRef<Blob | null>(null)
  const dictationOperationRef = useRef(0)
  const transcriptionAbortRef = useRef<AbortController | null>(null)
  const dictationSubmitModeRef = useRef<'queue' | 'steer'>('queue')
  const dictationAutoSubmitRef = useRef(false)
  const dictationSessionRef = useRef(sessionId)
  const toastSeq = useRef(0)
  const showToast = useCallback((text: string) => {
    toastSeq.current += 1
    setToast({ seq: toastSeq.current, text })
  }, [])
  const dismissToast = useCallback(() => { setToast(null) }, [])
  useEffect(() => { setSubmitModeOverride(null) }, [sessionId])
  useEffect(() => {
    if (!running || subagent !== null) setSubmitModeOverride(null)
  }, [running, subagent])
  const submitModeFor = useCallback((gesture: 'enter' | 'accelerated'): InputSubmitMode => {
    if (!running || subagent !== null || submitModeOverride === null) {
      return resolveSubmitMode(running, gesture, subagent === null)
    }
    if (gesture === 'enter') return submitModeOverride
    return submitModeOverride === 'queue' ? 'steer' : 'queue'
  }, [resolveSubmitMode, running, subagent, submitModeOverride])
  const primaryMode = submitModeFor('enter')
  // The deployment's image-intake limits (absent while no attachment service
  // is composed — the pre-check below then defers entirely to the host).
  const imageLimits = useProjection('imageLimits')
  // Prompt failures are ordinary failures (no create/attach transaction exists
  // anymore): the toast announces promptError, the draft stays in the machine,
  // and the user resubmits. A remount over a session whose machine still holds
  // an unresolved promptError deliberately re-announces it once — the failure
  // is still pending, and a transient banner is its only surface. Attachment
  // rejections show product copy keyed by the wire reason; other codes are
  // developer-facing and keep the raw message plus code.
  useEffect(() => {
    if (promptError === null) return
    showToast(promptError.error.code === 'attachment-error'
      ? attachmentErrorText(t, promptError.error.details.reason, imageLimits)
      : `${promptError.error.message} (${promptError.error.code})`)
  }, [promptError, showToast, t, imageLimits])
  useEffect(() => {
    if (notice?.level === 'error') showToast(notice.text)
  }, [notice, showToast])
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const mirrorRef = useRef<HTMLDivElement | null>(null)
  const safari = useMemo(() => isSafariBrowser(navigator), [])
  const safariNativeShrinkRef = useRef(false)
  // IME guard: composition Enter picks a candidate, it must not send. The ref outlives renders;
  // clearing is deferred one tick because Safari delivers the closing keydown AFTER compositionend.
  const composingRef = useRef(false)
  const onCompositionStart = (): void => {
    composingRef.current = true
  }
  const onCompositionEnd = (): void => {
    setTimeout(() => {
      composingRef.current = false
    }, 10)
  }

  // The Access seat's data: the host-computed permissions projection
  // (undefined = capability absent → the chip renders nothing).
  const permissions = useProjection('permissions')

  // A continuable child without its live parent cannot accept human input,
  // but its independent Stop below stays available while it runs.
  const continuable = subagent?.address.mode === 'continuable'
  const parentOffline = continuable && !subagent.parentAvailable
  // Running input stays free; locked = session removed, the
  // inert no-workspace state, the machine faces absent (no session), or a
  // parent-offline continuable child. An owner block also disables input;
  // adjudicating and submitting render read-only so the draft stays visible.
  const disabled = removed || inert || !live || blocked !== undefined || parentOffline
  const locked = disabled
  // The model seat is the ONE control a block leaves live: every block this
  // contract has is cleared by choosing a model, so locking it too would leave
  // the composer asking for the only thing it prevents. The other reasons to
  // be disabled do lock it — there is no session to choose a model for.
  const modelSeatLocked = removed || inert || !live
  const machineBusy = input?.phase === 'adjudicating' || input?.phase === 'submitting'
  // The no-workspace textarea remains the resident DOM node but acts as the
  // existing picker trigger. Message controls stay locked until a Session
  // exists; the trigger itself is read-only rather than disabled so pointer
  // and keyboard users can reach the recovery action.
  const workspaceTrigger = inert && !removed && onRequestWorkspace !== undefined
  const textareaDisabled = removed || (locked && !workspaceTrigger)
  const canSteerQueue = !locked && !machineBusy && !commandMenuOpen && empty && running && subagent === null
    && input.queue.some(row => row.placement === 'queued')

  const releaseWaveform = useCallback((): void => {
    if (waveformFrameRef.current !== null) {
      cancelAnimationFrame(waveformFrameRef.current)
      waveformFrameRef.current = null
    }
    const audio = waveformAudioRef.current
    waveformAudioRef.current = null
    if (audio === null) return
    audio.source.disconnect()
    audio.analyser.disconnect()
    if (audio.context.state !== 'closed') {
      void audio.context.close().catch(() => {})
    }
  }, [])

  const startWaveform = useCallback((stream: MediaStream): void => {
    releaseWaveform()
    const AudioContextConstructor = globalThis.AudioContext
      ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (AudioContextConstructor !== undefined) {
      let context: AudioContext | null = null
      let source: MediaStreamAudioSourceNode | null = null
      try {
        context = new AudioContextConstructor()
        source = context.createMediaStreamSource(stream)
        const analyser = context.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.72
        source.connect(analyser)
        waveformAudioRef.current = {
          context,
          source,
          analyser,
          values: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
        }
        if (context.state === 'suspended') void context.resume().catch(() => {})
      } catch {
        source?.disconnect()
        if (context !== null && context.state !== 'closed') void context.close().catch(() => {})
        waveformAudioRef.current = null
      }
    }

    const samples = Array<number>(DICTATION_WAVEFORM_BARS).fill(DICTATION_WAVEFORM_FLOOR)
    const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    let frame = 0
    let lastPaint = Number.NEGATIVE_INFINITY
    const advance = (timestamp: number): void => {
      const audio = waveformAudioRef.current
      const element = waveformRef.current
      if (element !== null) {
        element.dataset.waveformSource = audio === null ? 'fallback' : 'microphone'
        element.dataset.waveformMotion = reducedMotion ? 'reduced' : 'live'
        element.dataset.waveformTravelMs = String(DICTATION_WAVEFORM_TRAVEL_MS)
      }
      const cadence = reducedMotion ? 250 : DICTATION_WAVEFORM_STEP_MS
      if (timestamp - lastPaint >= cadence) {
        const amplitude = audio === null
          ? fallbackWaveformAmplitude(frame)
          : analyserWaveformAmplitude(audio.analyser, audio.values)
        if (reducedMotion) {
          samples.fill(amplitude)
        } else {
          samples.shift()
          samples.push(amplitude)
        }
        paintWaveform(element, samples)
        lastPaint = timestamp
        frame += 1
      }
      waveformFrameRef.current = requestAnimationFrame(advance)
    }
    waveformFrameRef.current = requestAnimationFrame(advance)
  }, [releaseWaveform])

  const releaseRecording = useCallback((): void => {
    releaseWaveform()
    recordingStreamRef.current?.getTracks().forEach((track) => { track.stop() })
    recordingStreamRef.current = null
    recorderRef.current = null
  }, [releaseWaveform])

  const cancelDictation = useCallback((reset = true): void => {
    dictationOperationRef.current += 1
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
    dictationAutoSubmitRef.current = false
    if (reset) dispatchDictation({ type: 'reset' })
  }, [releaseRecording])

  useEffect(() => () => { cancelDictation(false) }, [cancelDictation])
  useEffect(() => {
    if (dictationSessionRef.current === sessionId) return
    dictationSessionRef.current = sessionId
    cancelDictation()
  }, [cancelDictation, sessionId])
  useEffect(() => {
    if ((locked || machineBusy) && (dictation.phase === 'requesting-permission'
      || dictation.phase === 'recording' || dictation.phase === 'transcribing')) {
      cancelDictation()
    }
  }, [cancelDictation, dictation.phase, locked, machineBusy])

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
        method: 'POST',
        body: form,
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const result = await response.json() as { text?: unknown }
      const transcript = typeof result.text === 'string' ? result.text.trim() : ''
      if (transcript === '') throw new Error('No speech was recognized')
      if (dictationOperationRef.current !== operation || keyboard === undefined) return
      const current = keyboard.snapshot.draft
      const separator = current === '' || /\s$/u.test(current) ? '' : ' '
      const inserted = `${separator}${transcript}`
      keyboard.setDraft(`${current}${inserted}`, {
        start: current.length,
        end: current.length,
        insertedLength: inserted.length,
      })
      dispatchDictation({ type: 'transcribed', transcript })
      const autoSubmit = dictationAutoSubmitRef.current
      dictationAutoSubmitRef.current = false
      requestAnimationFrame(() => {
        if (dictationOperationRef.current !== operation) return
        if (autoSubmit) {
          keyboard.submit(dictationSubmitModeRef.current)
          if (keyboard.snapshot.phase === 'adjudicating' || keyboard.snapshot.phase === 'submitting') {
            dispatchDictation({ type: 'send' })
          }
        }
        inputRef.current?.focus()
      })
    } catch (error) {
      if (controller.signal.aborted || dictationOperationRef.current !== operation) return
      const message = error instanceof Error ? error.message : String(error)
      dispatchDictation({ type: 'transcription-failed', message: t('input.dictation.failed', { message }) })
    } finally {
      if (transcriptionAbortRef.current === controller) transcriptionAbortRef.current = null
    }
  }, [keyboard, t])

  const requestDictation = useCallback(async (): Promise<void> => {
    if (locked || machineBusy) return
    const operation = dictationOperationRef.current + 1
    dictationOperationRef.current = operation
    recordedAudioRef.current = null
    dispatchDictation({ type: 'request-permission' })
    try {
      const mediaDevices = (navigator as { mediaDevices?: MediaDevices }).mediaDevices
      if (mediaDevices?.getUserMedia === undefined) throw new Error('Microphone capture is unavailable')
      const Recorder = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder
      if (Recorder === undefined) throw new Error('Audio recording is unavailable')
      const stream = await mediaDevices.getUserMedia({ audio: true })
      if (dictationOperationRef.current !== operation) {
        stream.getTracks().forEach((track) => { track.stop() })
        return
      }
      recordingStreamRef.current = stream
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
        if (dictationOperationRef.current !== operation) return
        recorderFailed = true
        const detail = event as Event & { readonly error?: DOMException }
        const message = detail.error?.message ?? 'Media recorder error'
        releaseRecording()
        dispatchDictation({ type: 'transcription-failed', message: t('input.dictation.failed', { message }) })
      }
      recorder.onstop = () => {
        if (dictationOperationRef.current !== operation || recorderFailed) return
        const audio = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
        recordedAudioRef.current = audio
        releaseRecording()
        void transcribeDictation(audio, operation)
      }
      recorder.start(250)
      startWaveform(stream)
      dispatchDictation({ type: 'permission-granted', at: Date.now() })
    } catch (error) {
      if (dictationOperationRef.current !== operation) return
      releaseRecording()
      const message = error instanceof Error ? error.message : String(error)
      dispatchDictation({ type: 'permission-failed', message: t('input.dictation.failed', { message }) })
    }
  }, [keyboard, locked, machineBusy, releaseRecording, startWaveform, t, transcribeDictation])

  const stopDictation = useCallback((): void => {
    const recorder = recorderRef.current
    if (dictation.phase !== 'recording' || recorder === null || recorder.state !== 'recording') return
    releaseWaveform()
    dispatchDictation({ type: 'stop-recording' })
    recorder.stop()
  }, [dictation.phase, releaseWaveform])

  const stopDictationAndSend = useCallback((): void => {
    if (dictation.phase !== 'recording') return
    dictationAutoSubmitRef.current = true
    dictationSubmitModeRef.current = submitModeFor('enter')
    stopDictation()
  }, [dictation.phase, stopDictation, submitModeFor])

  const toggleDictation = useCallback((): void => {
    if (dictation.phase === 'recording') stopDictation()
    else if (dictation.phase !== 'requesting-permission'
      && dictation.phase !== 'transcribing' && dictation.phase !== 'sending') void requestDictation()
  }, [dictation.phase, requestDictation, stopDictation])

  useEffect(() => {
    if (dictation.phase === 'review' && draft.trim() === '') {
      recordedAudioRef.current = null
      dispatchDictation({ type: 'reset' })
    }
  }, [dictation.phase, draft])

  useEffect(() => {
    if (dictation.phase !== 'sending' || machineBusy) return
    if (draft.trim() === '') {
      recordedAudioRef.current = null
      dispatchDictation({ type: 'reset' })
      return
    }
    const message = promptError?.error.message ?? (notice?.level === 'error' ? notice.text : 'Message was not sent')
    dispatchDictation({ type: 'send-failed', message })
  }, [dictation.phase, draft, machineBusy, notice, promptError])

  const retryDictation = (): void => {
    if (dictation.phase !== 'error' || locked || machineBusy) return
    if (dictation.retry === 'transcription') {
      const audio = recordedAudioRef.current
      if (audio === null) {
        void requestDictation()
        return
      }
      const operation = dictationOperationRef.current + 1
      dictationOperationRef.current = operation
      dispatchDictation({ type: 'retry-transcription' })
      void transcribeDictation(audio, operation)
      return
    }
    if (dictation.retry === 'sending') {
      keyboard.submit(dictationSubmitModeRef.current)
      if (keyboard.snapshot.phase === 'adjudicating' || keyboard.snapshot.phase === 'submitting') {
        dispatchDictation({ type: 'retry-send' })
      }
      return
    }
    void requestDictation()
  }

  useEffect(() => {
    if (input === undefined || inputActions === undefined) return
    if (attachments.length !== input.imageIds.length) {
      inputActions.pruneImages(attachments.map(attachment => attachment.id))
    }
  }, [attachments, input?.imageIds, inputActions])

  // A native Safari edit that shortens the draft may leave the previous
  // soft-wrap layout behind after the mirror shrinks. The native-change signal
  // keeps ordinary typing and programmatic draft updates from reading layout;
  // the helper then repairs only measured overflow before paint while
  // preserving native editing state. See
  // .agents/notes/implemented/bug-fix/2026-08-13-safari-textarea-soft-wrap-reflow.md.
  useLayoutEffect(() => {
    const nativeShrink = safariNativeShrinkRef.current
    safariNativeShrinkRef.current = false
    if (safari && nativeShrink) repairSafariTextareaLayout(inputRef.current)
  }, [draft, safari])
  // Scroll the draft scrollport the minimum that brings `caret` into view — the
  // browser's own behavior for typing, performed for the paths where it does
  // not act.
  //
  // The mirror is the caret's ruler: it renders the same draft at the same
  // metrics and the same wrap width in the same stack (that is what makes it
  // the height authority), so a Range collapsed at the caret's index reports
  // where the caret is without a caret API.
  const revealCaret = (caret: number): void => {
    const scrollEl = scrollRef.current
    const mirrorEl = mirrorRef.current
    const text = mirrorEl?.firstChild
    if (scrollEl === null || mirrorEl === null || !(text instanceof Text)) return
    // A box that cannot scroll has nothing to reveal: the draft fits, so every
    // caret is already in view and the assignment below would clamp to itself.
    if (scrollEl.scrollHeight <= scrollEl.clientHeight) return
    const at = Math.min(caret, text.data.length)
    // A caret straight after a newline sits on a line with nothing on it to
    // measure — the shape a trailing-newline draft ends in — and the engines
    // disagree there: chromium returns NO client rects at all (an all-zero box,
    // which would scroll the wrong way), firefox reports the line above, WebKit
    // the right one. Measure the newline itself instead, which is the line the
    // caret just left, and step one line down; that they all agree on.
    const afterNewline = at > 0 && text.data[at - 1] === '\n'
    const range = document.createRange()
    range.setStart(text, afterNewline ? at - 1 : at)
    if (afterNewline) range.setEnd(text, at)
    else range.collapse(true)
    const line = afterNewline ? Number.parseFloat(getComputedStyle(mirrorEl).lineHeight) : 0
    const rect = range.getBoundingClientRect()
    const box = scrollEl.getBoundingClientRect()
    if (rect.bottom + line > box.bottom) scrollEl.scrollTop += rect.bottom + line - box.bottom
    else if (rect.top + line < box.top) scrollEl.scrollTop -= box.top - rect.top - line
  }

  // Reveal the focus end of the current selection. Today's entry paths leave a
  // collapsed selection, but honoring direction keeps a future range-preserving
  // path from revealing its anchor instead of its focus.
  const revealSelectionFocus = (el: HTMLTextAreaElement): void => {
    // selectionStart/End are number|null in lib.dom; the type-aware lint program narrows them.
    const caret = el.selectionDirection === 'backward' ? el.selectionStart : el.selectionEnd
    revealCaret(caret ?? el.value.length)
  }

  // Unlock (mount / session switch) returns focus to the box, and owns the
  // reveal that comes with it. `preventScroll` because this focus is ours, not
  // a gesture: the textarea is as tall as the draft, so the browser's reveal
  // would walk up to the conversation scrollport and move the transcript under
  // a user who only switched session. That leaves the caret to us — the DOM is
  // reused across sessions, so switching to a longer draft keeps the previous
  // offset while the value swap puts the caret at the new draft's end, which is
  // off screen (measured on all three engines: offset 0 with the caret 940px
  // down). Suppress the walk, then reveal in our own box.
  useEffect(() => {
    const el = inputRef.current
    if (locked || el === null) return
    el.focus({ preventScroll: true })
    revealSelectionFocus(el)
  }, [locked, sessionId])

  // A persisted draft arrives AFTER the unlock effect: ConversationSession
  // adopts it in its own mount effect, and a parent's mount effect runs after
  // its children's. Reveal when the draft becomes non-empty so a restored long
  // draft does not stay at its head with the caret at its end. This effect does
  // not focus: send-clear, failed-send restore, and first-character transitions
  // must not steal focus from another control the user moved to.
  useEffect(() => {
    const el = inputRef.current
    if (locked || draft === '' || el === null) return
    revealSelectionFocus(el)
  }, [draft !== ''])

  // Caret restore after an edit the composer performs itself. The machine owns
  // the draft and the undo log, so paste and cut suppress the native edit and
  // write the value through the machine — and a
  // programmatic selection change reveals nothing: measured in chromium and
  // WebKit, pasting a long block leaves the view where it was while the caret
  // sits at the end of the draft. Native typing gets its reveal from the
  // browser; these two have to ask for it, so they share one restore.
  const restoreCaret = (el: HTMLTextAreaElement, caret: number): void => {
    requestAnimationFrame(() => {
      el.setSelectionRange(caret, caret)
      revealCaret(caret)
    })
  }

  // Wheel chaining on the draft scrollport, one lifetime (it is never
  // unmounted — the inert state renders the same element disabled). While the
  // capped box can still move in this direction, keep the native scroll; only
  // at its own edge forward the delta to the active conversation scrollport, so
  // a short draft never traps the gesture and a long draft stays scrollable.
  // Hero mounts have no host and keep native wheel scrolling.
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const onWheel = (e: WheelEvent): void => {
      const host = el.closest('[data-conversation-scroll]')
      if (!(host instanceof HTMLElement) || e.deltaY === 0) return
      const atTop = el.scrollTop <= 0
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 1
      if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atEnd)) return
      e.preventDefault()
      host.scrollTop += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel) }
  }, [])

  // selectionStart/End are number|null in lib.dom; the type-aware lint program narrows them.
  const selectionOf = (el: HTMLTextAreaElement) => ({
    start: el.selectionStart ?? 0,
    end: el.selectionEnd ?? el.selectionStart ?? 0,
  })

  // The machine's occurrence math needs the edit's real range, and a controlled
  // textarea's change event carries only the resulting string. `beforeinput`
  // fires while the element still holds the pre-edit selection, which is
  // exactly the range about to be replaced; a textarea exposes it no other way
  // (`getTargetRanges()` is empty for form controls). Recovering the range by
  // diffing the two drafts instead is ambiguous whenever the typed text repeats
  // what it lands against — typing the trigger char before a reference reads as
  // landing inside that reference, which drops it. One lifetime, like the wheel
  // listener above: the textarea is never unmounted.
  const pendingEditRef = useRef<PendingEdit | null>(null)
  useEffect(() => {
    const el = inputRef.current
    if (el === null) return
    const onBeforeInput = (e: InputEvent): void => {
      // Only the families whose reported selection describes the edit. A
      // history replay reports wherever the caret happens to sit, which would
      // survive every check in editRangeOf while naming the wrong span.
      if (!e.inputType.startsWith('insert') && !e.inputType.startsWith('delete')) {
        pendingEditRef.current = null
        return
      }
      const { start, end } = selectionOf(el)
      pendingEditRef.current = { start, end, draftLength: el.value.length, inputType: e.inputType }
    }
    el.addEventListener('beforeinput', onBeforeInput)
    return () => { el.removeEventListener('beforeinput', onBeforeInput) }
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (workspaceTrigger) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onRequestWorkspace()
      }
      return
    }
    // Absent machine without a Workspace recovery action stays disabled; the
    // guard narrows the faces for the paths below.
    if (input === undefined || keyboard === undefined || inputActions === undefined) return
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
      e.preventDefault()
      toggleDictation()
      return
    }
    if (e.key === 'Escape' && dictation.phase === 'recording') {
      e.preventDefault()
      cancelDictation()
      return
    }
    // Shift+Enter is the native newline UNCONDITIONALLY — decided before the
    // IME guard so a composition-closing Shift+Enter still breaks the line.
    if (e.key === 'Enter' && e.shiftKey) return
    // keyCode 229 is the legacy IME-composition signal engines emit without isComposing.
    const composing = composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229
    if (!composing && !machineBusy && !locked
      && (e.key === 'Backspace' || e.key === 'Delete')) {
      const selection = selectionOf(e.currentTarget)
      if (selection.start === selection.end) {
        const occurrence = input.occurrences.find(o => e.key === 'Backspace'
          ? o.offset + o.length === selection.start
          : o.offset === selection.start)
        if (occurrence !== undefined) {
          e.preventDefault()
          const start = occurrence.offset
          const end = occurrence.offset + occurrence.length
          keyboard.setDraft(draft.slice(0, start) + draft.slice(end), { start, end, insertedLength: 0 })
          restoreCaret(e.currentTarget, start)
          keyboard.track(keyboard.snapshot.draft, start)
          return
        }
      }
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (keyboard.arbitrate(e.key === 'ArrowUp' ? 'up' : 'down', composing) === 'consumed') e.preventDefault()
      return
    }
    if (e.key === 'Escape') {
      // Escape layering: an open overlay closes; claimed without an overlay
      // does NOT release (backspacing the token is the only exit gesture).
      keyboard.dismissPopup()
      if (keyboard.arbitrate('escape', composing) === 'consumed') e.preventDefault()
      return
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
      // The machine owns the undo/redo log (chip transactions have semantics
      // the browser stack cannot represent); never let the native stack run.
      e.preventDefault()
      if (machineBusy || locked) return
      const redo = e.key === 'y' || e.shiftKey
      if (redo) keyboard.redo()
      else keyboard.undo()
      return
    }
    if (e.key === ' ') {
      if (composing) return
      if (keyboard.space()) e.preventDefault() // claim token already carries the trailing separator
      return
    }
    if (e.key !== 'Enter') return
    if (composing) return
    // Menu-open Enter picks the highlight through arbitration; a no-highlight
    // menu passes down to the machine's own adjudication.
    const arbitrated = keyboard.arbitrate('enter', composing)
    if (arbitrated !== 'pass') {
      e.preventDefault()
      return
    }
    e.preventDefault()
    if (e.repeat) return // held-down Enter must not machine-gun sends
    if (locked || machineBusy) return
    const accelerated = e.ctrlKey || e.metaKey
    // Empty-draft accelerated Enter acts on the queue instead of the (empty)
    // draft: the machine rejects empty drafts, so the gesture steers every
    // still-pending queued message into the running turn (the dock's per-row
    // steer button applied to the whole queue). Steering needs the same
    // window as the per-row button: a running ordinary session.
    if (accelerated && canSteerQueue) {
      keyboard.steerQueue()
      return
    }
    const mode = submitModeFor(accelerated ? 'accelerated' : 'enter')
    keyboard.submit(mode)
    if (dictation.phase === 'review'
      && (keyboard.snapshot.phase === 'adjudicating' || keyboard.snapshot.phase === 'submitting')) {
      dictationSubmitModeRef.current = mode
      dispatchDictation({ type: 'send' })
    }
  }

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    if (keyboard === undefined || locked) return // disabled/read-only states cannot edit the draft
    if (machineBusy) return // submitting is the read-only span; adjudicating holds the pending lock
    const next = e.target.value
    const pending = pendingEditRef.current
    pendingEditRef.current = null
    safariNativeShrinkRef.current = safari && next.length < draft.length
    keyboard.setDraft(next, editRangeOf(pending, draft.length, next.length))
    // selectionStart is number|null in lib.dom; the type-aware lint program narrows it.
    keyboard.track(next, e.target.selectionStart ?? next.length)
  }

  const onCopyOrCut = (e: React.ClipboardEvent<HTMLTextAreaElement>, cut: boolean): void => {
    if (input === undefined || keyboard === undefined) return // absent machine: no draft can be copied or cut
    const el = e.currentTarget
    const { start, end } = selectionOf(el)
    if (start === end) return
    const touched = input.occurrences.filter(o => o.offset < end && o.offset + o.length > start)
    if (touched.length === 0 && !cut) return // plain copy of plain text: native path is fine
    e.preventDefault()
    const copyStart = touched.reduce((value, o) => Math.min(value, o.offset), start)
    const copyEnd = touched.reduce((value, o) => Math.max(value, o.offset + o.length), end)
    // Expand structured ranges to their owner clipboard projections.
    let text = ''
    let cursor = copyStart
    for (const o of touched) {
      text += draft.slice(cursor, o.offset) + o.clipboardText
      cursor = o.offset + o.length
    }
    text += draft.slice(cursor, copyEnd)
    e.clipboardData.setData('text/plain', text)
    if (cut && !machineBusy && !locked) {
      keyboard.setDraft(
        draft.slice(0, copyStart) + draft.slice(copyEnd),
        { start: copyStart, end: copyEnd, insertedLength: 0 },
      )
      restoreCaret(el, copyStart)
    }
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    if (keyboard === undefined) return // absent machine: no draft can accept a paste
    if (machineBusy || locked) return
    const files = Array.from(e.clipboardData.items)
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length > 0) intakeImages(files)
    const text = e.clipboardData.getData('text/plain')
    if (text === '') {
      if (files.length > 0) e.preventDefault()
      return
    }
    e.preventDefault()
    const el = e.currentTarget
    const sel = selectionOf(el)
    // Sync components stay empty at this layer: hot-snapshot matching needs
    // the Slash roster, which lives behind keyboard.track — the paste attempt
    // opens in the machine and the controller upgrades tokens as matches
    // land (paste-upgrade). The DOM layer only starts the transaction.
    keyboard.pasteBegin(text, sel)
    const caret = sel.start + text.length
    restoreCaret(el, caret)
    keyboard.track(keyboard.snapshot.draft, caret)
  }

  // Intake pre-check (DeepSeek Chat semantics): an addition that would break
  // a projected limit is refused as a whole batch, announced immediately, and
  // never enters the rail — no more submit-time failure rolling the rail
  // back. The host enforces the same limits at submit for callers that bypass
  // this composer.
  const intakeImages = useCallback((files: readonly File[]): void => {
    if (addImages === undefined || files.length === 0) return
    const rejected = ((): string | null => {
      if (imageLimits !== undefined) {
        // Format precedes limits (DeepSeek Chat's filter order): a batch with
        // a non-image must announce the format problem, not a count or size
        // it could never pass anyway — addImages rejects it authoritatively.
        if (files.some(file => !(imageLimits.mediaTypes as readonly string[]).includes(file.type))) {
          return addImages(files)
        }
        if (attachments.length + files.length > imageLimits.maxImagesPerMessage) {
          return t('image.tooMany', { count: imageLimits.maxImagesPerMessage })
        }
        if (files.some(file => file.size > imageLimits.maxImageBytes)) {
          return t('image.fileTooLarge', { size: imageSizeText(imageLimits.maxImageBytes) })
        }
        const total = attachments.reduce((sum, attachment) => sum + attachment.file.size, 0)
          + files.reduce((sum, file) => sum + file.size, 0)
        if (total > imageLimits.maxMessageImageBytes) {
          return t('image.totalTooLarge', { size: imageSizeText(imageLimits.maxMessageImageBytes) })
        }
      }
      return addImages(files)
    })()
    if (rejected !== null) showToast(rejected)
  }, [addImages, attachments, imageLimits, showToast, t])

  const canAcceptDrop = !locked && !machineBusy && addImages !== undefined

  const onSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>): void => {
    // Any caret/selection gesture ends a live paste attempt (the machine
    // cannot observe DOM selection). Cheap no-op when none is live.
    if (keyboard !== undefined && keyboard.snapshot.paste !== undefined) keyboard.invalidatePaste()
    void e
  }

  // Button presses steal focus from the textarea; suppress at mousedown so
  // typing continues seamlessly. `preventScroll` for the same reason as the
  // unlock effect, and with no reveal of its own: the caret has not moved, and
  // the next keystroke gets the browser's native one.
  const keepFocus = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault()
    inputRef.current?.focus({ preventScroll: true })
  }

  const onToggleCommandMenu = (): void => {
    const el = inputRef.current
    if (el !== null) toggleCommandMenu?.(selectionOf(el))
  }

  // Running ordinary sessions and continuable children keep Send available
  // beside an independent Stop so pointer users can queue or steer a follow-up
  // without cancelling the active turn.
  const interruptible = running && (subagent === null || continuable)
  const primaryLabel = dictation.phase === 'recording'
    ? t('input.dictation.stopAndSend')
    : running
      ? t(primaryMode === 'steer' ? 'input.steer' : 'input.queue')
      : t('input.send')
  const onPrimary = (): void => {
    if (keyboard === undefined) return // absent machine: the button is disabled
    if (dictation.phase === 'recording') {
      stopDictationAndSend()
      return
    }
    /* v8 ignore next -- defensive: the primary button is disabled while empty||disabled, so a click cannot reach the false arm. */
    if (!empty && !disabled && !machineBusy) {
      keyboard.submit(primaryMode)
      if (dictation.phase === 'review'
        && (keyboard.snapshot.phase === 'adjudicating' || keyboard.snapshot.phase === 'submitting')) {
        dictationSubmitModeRef.current = primaryMode
        dispatchDictation({ type: 'send' })
      }
    }
  }

  // The Access seat: the projection-fed permission chip (renders nothing
  // while the permissions key is absent — permission-less host or Draft —
  // or while the command face is absent with the session).
  const accessSelect: ReactNode = command === undefined
    ? null
    : <PermissionSelect key={sessionId} value={permissions} locked={locked} command={command} t={t} />

  const responseAnnotations = input?.occurrences.flatMap((occurrence) => {
    if (occurrence.source !== RESPONSE_ANNOTATION_SOURCE) return []
    try {
      return [{ occurrenceId: occurrence.occurrenceId, ...parseResponseAnnotationPayload(occurrence.ref) }]
    } catch {
      return []
    }
  }) ?? []
  const navigateToAnnotation = (index: number): void => {
    const marker = document.querySelector<HTMLElement>(`[data-response-annotation-marker="${index}"]`)
    if (marker === null) return
    marker.scrollIntoView({ behavior: 'smooth', block: 'center' })
    marker.focus({ preventScroll: true })
  }

  // Mirror-layer decorations: a visible backdrop with transparent textarea
  // text. Claim tokens and references retain the draft's own glyph metrics,
  // so their decoration cannot drift from wrapping, selection, or the caret.
  const deco = input === undefined ? INERT_DECORATIONS : deriveDecorations(input, lexicon)
  const backdrop: ReactNode[] = []
  {
    // Segment boundaries: the token range end, every structured-reference
    // offset, and every text-ref range — merged in draft order (the sources never
    // overlap: structured references own their ranges, text-refs own plain tokens, the
    // claim token only leads).
    let cursor = 0
    const pushPlain = (upTo: number): void => {
      if (upTo > cursor) backdrop.push(draft.slice(cursor, upTo))
      cursor = upTo
    }
    if (deco.token !== null) {
      backdrop.push(
        <mark key="token" className={css.hlToken} data-decoration="token">
          {draft.slice(deco.token.start, deco.token.end)}
        </mark>,
      )
      cursor = deco.token.end
    }
    type Boundary =
      | { at: number; kind: 'chip'; chip: (typeof deco.chips)[number] }
      | { at: number; kind: 'text-ref'; ref: (typeof deco.textRefs)[number]; ordinal: number }
    const boundaries: Boundary[] = [
      ...deco.chips.map(chip => ({ at: chip.offset, kind: 'chip' as const, chip })),
      ...deco.textRefs.map((ref, ordinal) => ({ at: ref.start, kind: 'text-ref' as const, ref, ordinal })),
    ].sort((a, b) => a.at - b.at)
    for (const b of boundaries) {
      if (b.at < cursor) continue // claim-token overlap: the leading mark wins
      pushPlain(b.at)
      if (b.kind === 'chip') {
        const chip = b.chip
        backdrop.push(
          <span
            key={`chip-${chip.occurrenceId}`}
            className={clsx(css.chip, chip.invalid && css.chipInvalid)}
            data-decoration="chip"
            data-reference-appearance={chip.appearance}
            data-occurrence={chip.occurrenceId}
            data-invalid={chip.invalid || undefined}
            title={chip.label}
          >
            {chip.appearance === undefined
              ? chip.text[0]
              : (
                <span className={css.chipTrigger}>
                  <span className={css.chipTriggerGlyph}>{chip.text[0]}</span>
                  <ReferenceIcon kind={chip.appearance} size={16} className={css.chipIcon} />
                </span>
              )}
            <span>{chip.text.slice(1)}</span>
          </span>,
        )
        cursor = chip.offset + chip.length
      } else {
        // Plain-range highlight: the glyphs stay the
        // textarea's (advance untouched); the mark paints the chip look.
        // The key is the draft-order ordinal: a fresh scan derives these
        // ranges every render, so none of them carries identity past its
        // position, and a draft-offset key would unmount the mark and its
        // icon for every character typed ahead of it. Structured references
        // key by occurrenceId, the identity their occurrence table owns.
        const text = draft.slice(b.ref.start, b.ref.end)
        backdrop.push(
          <mark key={`ref-${b.ordinal}`} className={css.textRef} data-decoration="text-ref">
            {b.ref.appearance === 'folder'
              ? (
                <>
                  <span className={css.textRefTrigger}>
                    <span className={css.textRefTriggerGlyph}>{text[0]}</span>
                    <ReferenceIcon kind="folder" size={16} className={css.textRefIcon} />
                  </span>
                  {text.slice(1)}
                </>
              )
              : text}
          </mark>,
        )
        cursor = b.ref.end
      }
    }
    pushPlain(draft.length)
    if (deco.hint !== null) {
      // Claim tokens have the `/name ` format (trailing space); trim to the bare name.
      const commandName = input?.claim?.token.slice(1).trim() ?? ''
      const hintKey = `hint.${commandName === 'goal' && hasGoal ? 'goal.active' : commandName}`
      // Dynamic lookup by claimed command name: unknown commands miss the
      // dictionary and keep the machine's own hint, so the call is wide.
      const translated = (t as Translate)(hintKey)
      const displayHint = translated !== hintKey ? translated : deco.hint
      backdrop.push(<span key="hint" className={css.hint} data-decoration="hint">{displayHint}</span>)
    }
  }

  const dictationStatusText = dictation.phase === 'requesting-permission'
    ? t('input.dictation.requestingPermission')
    : dictation.phase === 'recording'
      ? `${t('input.dictation.stop')} · ${dictationDuration(dictation.elapsedSeconds)}`
      : dictation.phase === 'transcribing'
        ? t('input.dictation.transcribing')
        : dictation.phase === 'review'
          ? t('input.dictation.ready')
          : dictation.phase === 'sending'
            ? t('input.dictation.sending')
            : dictation.phase === 'error' ? dictation.message : null
  const dictationControlLabel = dictation.phase === 'recording'
    ? t('input.dictation.stop')
    : dictation.phase === 'transcribing'
      ? t('input.dictation.transcribing')
      : dictation.phase === 'requesting-permission' || dictation.phase === 'sending'
        ? dictationStatusText ?? t('input.dictation.start')
        : t('input.dictation.start')

  return (
    <div className={clsx(css.root, variant === 'hero' && css.hero)}>
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          anchor={cardRef.current}
          onDone={dismissToast}
        />
      )}
      {notice?.level === 'info' && (
        <div className={css.notice} role="status">
          {notice.text}
        </div>
      )}
      {/* Trigger clicks land on the card, not the textarea: the toolbar row's
          disabled controls swallow clicks otherwise (the CSS state disarms
          their pointer events), so the WHOLE capsule is the pick target.
          pointerdown stops here so the Menu's outside-close cannot race the
          click's reopen (close-then-open flickers the chip's open echo). */}
      <div
        ref={cardRef}
        className={clsx(css.card, workspaceTrigger && css.cardWorkspaceTrigger)}
        data-composer-card
        onClick={workspaceTrigger ? onRequestWorkspace : undefined}
        onPointerDown={workspaceTrigger ? (e) => { e.stopPropagation() } : undefined}
      >
        {overlay !== undefined && <div className={css.overlayAnchor}>{overlay}</div>}
        {accessory !== undefined && <div className={css.accessory}>{accessory}</div>}
        {renderSlot('conversation.input.attachments', {
          attachments,
          canAcceptDrop,
          onAddImages: intakeImages,
          onRemoveImage: (id) => { removeImage?.(id) },
          dropLimits: imageLimits === undefined ? undefined : {
            count: imageLimits.maxImagesPerMessage,
            size: imageSizeText(imageLimits.maxImageBytes),
          },
        })}
        {responseAnnotations.length > 0 && (
          <div
            className={css.annotationRail}
            role="list"
            aria-label={t('annotation.rail', { count: responseAnnotations.length })}
          >
            {responseAnnotations.map(annotation => (
              <span key={annotation.occurrenceId} role="listitem">
                <button
                  type="button"
                  className={css.annotationBubble}
                  aria-label={t('annotation.item', { index: annotation.index, text: annotation.text })}
                  title={annotation.text}
                  onMouseDown={(event) => { event.preventDefault() }}
                  onClick={() => { navigateToAnnotation(annotation.index) }}
                >
                  {annotation.index}
                </button>
              </span>
            ))}
          </div>
        )}
        {/* One scrollport, two text layers. The hidden mirror renders draft+'\n' and stretches the
            stack to the draft's FULL height (counting rows by '\n' cannot see soft wraps); the
            absolutely-positioned backdrop and textarea ride that height, and .scroll — capped at 14
            lines in CSS — is the only thing that scrolls. The caret belongs to the textarea and the
            glyphs to the backdrop, so they can only stay together by moving together: one scroll
            offset the browser applies to both layers at once, never a JS mirror between two boxes,
            which a compositor-driven gesture outruns and leaves the words trailing the caret. */}
        <div ref={scrollRef} className={css.scroll} data-input-scroll>
          <div className={css.grow}>
            <div
              aria-hidden
              className={clsx(css.backdrop, textareaDisabled && css.backdropDisabled)}
              data-input-backdrop
              data-disabled={textareaDisabled || undefined}
            >
              {backdrop}
            </div>
            <textarea
              ref={inputRef}
              className={css.input}
              value={draft}
              disabled={textareaDisabled}
              readOnly={machineBusy || workspaceTrigger}
              aria-label={workspaceTrigger ? t('hero.chooseWorkspace') : undefined}
              aria-haspopup={workspaceTrigger ? 'menu' : undefined}
              aria-expanded={workspaceTrigger ? workspacePickerOpen : undefined}
              data-phase={input?.phase ?? 'inert'}
              placeholder={placeholder ?? (parentOffline
                ? t('placeholder.parentOffline')
                : disabled
                  ? t('placeholder.unavailable')
                  // The steer hint deliberately outranks the plan placeholder:
                  // while it shows, the whole-queue gesture is genuinely available
                  // (the gate never consults plan mode), so the actionable hint wins.
                  : canSteerQueue
                    ? t('placeholder.steerQueue')
                    : planActive ? t('placeholder.plan') : t('placeholder.default'))}
              rows={2}
              onChange={onChange}
              onKeyDown={onKeyDown}
              onSelect={onSelect}
              onCopy={(e) => { onCopyOrCut(e, false) }}
              onCut={(e) => { onCopyOrCut(e, true) }}
              onPaste={onPaste}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
            />
            <div ref={mirrorRef} aria-hidden className={css.mirror} data-input-mirror>{`${draft}\n`}</div>
          </div>
        </div>
        {dictationStatusText !== null && (
          <div
            className={clsx(css.dictationStatus, dictation.phase === 'recording' && css.dictationStatusRecording)}
            data-dictation-state={dictation.phase}
            role={dictation.phase === 'error' ? 'alert' : 'status'}
            aria-live={dictation.phase === 'recording' ? 'off' : 'polite'}
            aria-atomic="true"
          >
            {dictation.phase === 'recording'
              ? (
                <span ref={waveformRef} className={css.dictationWaveform} data-dictation-waveform aria-hidden>
                  {Array.from({ length: DICTATION_WAVEFORM_BARS }, (_, index) => (
                    <span
                      key={index}
                      className={css.dictationBar}
                      data-waveform-bar
                    />
                  ))}
                </span>
              )
              : <span className={css.dictationIndicator} aria-hidden />}
            <span className={css.dictationStatusText}>{dictationStatusText}</span>
            {dictation.phase === 'error' && (
              <button
                type="button"
                className={css.retry}
                aria-label={t('retry')}
                onMouseDown={keepFocus}
                onClick={retryDictation}
              >
                {t('retry')}
              </button>
            )}
          </div>
        )}
        <div className={css.row}>
          <div className={css.tools}>
            <Tooltip label={t('input.commands')} side="top" delayMs={500}>
              <button
                type="button"
                className={css.add}
                aria-label={t('input.commands')}
                aria-haspopup="listbox"
                aria-expanded={commandMenuOpen}
                disabled={locked || toggleCommandMenu === undefined}
                onMouseDown={keepFocus}
                onClick={onToggleCommandMenu}
              >
                <IconPlusOutline16 size={14} />
              </button>
            </Tooltip>
            <div className={css.modes}>
              {accessSelect}
              {renderSlot('conversation.input.plan', { locked })}
              {running && subagent === null && (
                <div className={css.deliveryModes} role="group" aria-label={t('input.delivery.label')}>
                  {(['queue', 'steer'] as const).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      className={css.deliveryMode}
                      data-selected={primaryMode === mode}
                      aria-pressed={primaryMode === mode}
                      disabled={locked || machineBusy}
                      onMouseDown={keepFocus}
                      onClick={() => { setSubmitModeOverride(mode) }}
                    >
                      {t(mode === 'queue' ? 'input.delivery.quickQueue' : 'input.delivery.steer')}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {leftItems}
          </div>
          <div className={css.trailing} data-composer-trailing>
            {rightItems}
            {renderSlot('conversation.input.model', { locked: modelSeatLocked })}
            <ContextMeter useProjection={useProjection} t={t} />
            <Tooltip label={dictationControlLabel} side="top" delayMs={500}>
              <button
                type="button"
                className={clsx(css.add, dictation.phase === 'recording' && css.voiceActive)}
                aria-label={dictationControlLabel}
                aria-keyshortcuts="Control+Shift+M Meta+Shift+M"
                aria-pressed={dictation.phase === 'recording'}
                data-dictation-state={dictation.phase}
                disabled={locked || machineBusy || dictation.phase === 'requesting-permission'
                  || dictation.phase === 'transcribing' || dictation.phase === 'sending'}
                onMouseDown={keepFocus}
                onClick={toggleDictation}
              >
                <IconMicrophoneOutline16 size={16} />
              </button>
            </Tooltip>
            {interruptible && (
              <Tooltip label={t('input.stop')} side="top" delayMs={500}>
                <button
                  type="button"
                  className={css.primary}
                  aria-label={t('input.stop')}
                  disabled={stop === undefined}
                  onMouseDown={keepFocus}
                  onClick={stop}
                >
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                    <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
                  </svg>
                </button>
              </Tooltip>
            )}
            <Tooltip label={primaryLabel} side="top" delayMs={500}>
              <button
                type="button"
                className={css.primary}
                aria-label={primaryLabel}
                data-primary-action
                data-submit-mode={dictation.phase === 'recording' ? 'dictation' : primaryMode}
                disabled={(dictation.phase !== 'recording' && empty) || disabled || machineBusy}
                onMouseDown={keepFocus}
                onClick={onPrimary}
              >
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                  <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
                </svg>
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
      {footer}
    </div>
  )
}
