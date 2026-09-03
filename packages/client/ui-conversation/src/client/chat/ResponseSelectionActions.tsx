import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type { InputActions, InputState } from '../input/contract.ts'
import {
  parseResponseAnnotationPayload, RESPONSE_ANNOTATION_SOURCE,
  type ResponseAnnotationPayload,
} from '../response-annotation.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { responseAnnotationRange } from './response-annotation-location.ts'
import css from './ResponseSelectionActions.module.css'

interface SelectionState {
  readonly text: string
  readonly startOffset: number
  readonly endOffset: number
  readonly left: number
  readonly top: number
}

interface AnnotationMarker extends ResponseAnnotationPayload {
  readonly occurrenceId: number
}

interface MarkerLayout {
  readonly annotation: AnnotationMarker
  readonly highlights: readonly { left: number; top: number; width: number; height: number }[]
  readonly left: number
  readonly top: number
}

function renderedOffset(host: HTMLElement, container: Node, offset: number): number {
  const range = document.createRange()
  range.selectNodeContents(host)
  range.setEnd(container, offset)
  return range.toString().length
}

export interface ResponseSelectionActionsProps {
  readonly messageId: MessageId
  readonly occurrences: InputState['occurrences']
  readonly inputActions: InputActions
  readonly t: ChatViewSlotProps['t']
  readonly children: ReactNode
}

/** Selection-local Add to chat action for one finalized assistant response. */
export function ResponseSelectionActions({
  messageId, occurrences, inputActions, t, children,
}: ResponseSelectionActionsProps): ReactNode {
  const root = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<SelectionState | null>(null)
  const [markers, setMarkers] = useState<readonly MarkerLayout[]>([])
  const annotations = useMemo(() => occurrences.flatMap((occurrence): AnnotationMarker[] => {
    if (occurrence.source !== RESPONSE_ANNOTATION_SOURCE) return []
    try {
      const annotation = parseResponseAnnotationPayload(occurrence.ref)
      return annotation.messageId === messageId ? [{ ...annotation, occurrenceId: occurrence.occurrenceId }] : []
    } catch {
      return []
    }
  }), [messageId, occurrences])

  const capture = useCallback(() => {
    const selection = window.getSelection()
    const host = content.current
    if (host === null || selection === null || selection.isCollapsed || selection.rangeCount === 0) {
      setSelected(null)
      return
    }
    const range = selection.getRangeAt(0)
    if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) {
      setSelected(null)
      return
    }
    const text = selection.toString().trim()
    if (text.length === 0) {
      setSelected(null)
      return
    }
    const rect = range.getBoundingClientRect()
    setSelected({
      text,
      startOffset: renderedOffset(host, range.startContainer, range.startOffset),
      endOffset: renderedOffset(host, range.endContainer, range.endOffset),
      left: Math.min(window.innerWidth - 64, Math.max(64, rect.left + rect.width / 2)),
      top: Math.max(44, rect.top - 6),
    })
  }, [])

  useLayoutEffect(() => {
    const host = content.current
    const container = root.current
    if (host === null || container === null || annotations.length === 0) {
      setMarkers([])
      return
    }
    const measure = (): void => {
      const origin = container.getBoundingClientRect()
      const next = annotations.flatMap((annotation): MarkerLayout[] => {
        const range = responseAnnotationRange(host, annotation)
        if (range === null || typeof range.getClientRects !== 'function') return []
        const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0)
        if (rects.length === 0) return []
        const [first] = rects
        if (first === undefined) return []
        return [{
          annotation,
          highlights: rects.map(rect => ({
            left: rect.left - origin.left,
            top: rect.top - origin.top,
            width: rect.width,
            height: rect.height,
          })),
          left: first.right - origin.left,
          top: first.top - origin.top,
        }]
      })
      setMarkers(next)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(host)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [annotations])

  useEffect(() => {
    const dismiss = () => { setSelected(null) }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [])

  const add = () => {
    if (selected === null) return
    if (!inputActions.addResponseAnnotation({
      messageId,
      text: selected.text,
      startOffset: selected.startOffset,
      endOffset: selected.endOffset,
    })) return
    window.getSelection()?.removeAllRanges()
    setSelected(null)
  }

  return (
    <div ref={root} className={css.root}>
      <div
        ref={content}
        className={css.content}
        data-response-message-id={messageId}
        onPointerUp={capture}
        onKeyUp={capture}
      >
        {children}
      </div>
      {markers.flatMap(marker => marker.highlights.map((highlight, index) => (
        <span
          key={`highlight-${marker.annotation.occurrenceId}-${index}`}
          className={css.highlight}
          style={highlight}
          aria-hidden
        />
      )))}
      {markers.map(marker => (
        <button
          key={`marker-${marker.annotation.occurrenceId}`}
          type="button"
          className={css.marker}
          data-response-annotation-marker={marker.annotation.index}
          aria-label={t('annotation.sourceMarker', { index: marker.annotation.index, text: marker.annotation.text })}
          title={marker.annotation.text}
          style={{ left: marker.left, top: marker.top }}
        >
          {marker.annotation.index}
        </button>
      ))}
      {selected !== null && createPortal(
        <div
          className={css.toolbar}
          role="toolbar"
          aria-label={t('annotation.toolbar')}
          style={{ left: selected.left, top: selected.top }}
        >
          <button type="button" className={css.action} onClick={add}>
            {t('annotation.addToChat')}
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}
