import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type { ChatNodeViewProps, TurnTailOwnerProps } from '../contract/slots.ts'
import type { ResponseAnnotationPresentation } from '../response-annotation.ts'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'
import {
  ResponseSelectionActions, type ResponseAnnotationOccurrence,
} from './ResponseSelectionActions.tsx'

interface AnnotationPreview {
  readonly text: string
  readonly marker: HTMLButtonElement
}

function annotationMarker(target: EventTarget): HTMLButtonElement | null {
  return target instanceof Element
    ? target.closest<HTMLButtonElement>('[data-response-annotation-marker]')
    : null
}

/** Give source markers a visible hover/focus preview without changing their geometry owner. */
function AnnotationMarkerPreviewScope({ messageId, children }: {
  readonly messageId: MessageId
  readonly children: ReactNode
}): ReactNode {
  const [preview, setPreview] = useState<AnnotationPreview | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const tooltipRef = useRef<HTMLSpanElement | null>(null)
  const show = (target: EventTarget): void => {
    const marker = annotationMarker(target)
    if (marker === null || marker.title === '') return
    if (preview?.marker !== marker) setPosition(null)
    setPreview(current => current?.marker === marker && current.text === marker.title
      ? current : { text: marker.title, marker })
  }
  const hide = (target: EventTarget, relatedTarget: EventTarget | null): void => {
    const marker = annotationMarker(target)
    if (marker !== null && relatedTarget instanceof Node && marker.contains(relatedTarget)) return
    if (relatedTarget instanceof Node && tooltipRef.current?.contains(relatedTarget)) return
    setPreview(null)
  }
  useLayoutEffect(() => {
    if (preview === null) return
    const place = (): void => {
      const tooltip = tooltipRef.current
      if (tooltip === null) return
      if (!preview.marker.isConnected) {
        setPreview(null)
        return
      }
      const anchor = preview.marker.getBoundingClientRect()
      const box = tooltip.getBoundingClientRect()
      const margin = 12
      const gap = 8
      const below = window.innerHeight - anchor.bottom - gap - margin
      const above = anchor.top - gap - margin
      const useAbove = box.height > below && above > below
      const preferredTop = useAbove ? anchor.top - gap - box.height : anchor.bottom + gap
      setPosition((current) => {
        const next = {
          left: Math.max(margin, Math.min(anchor.left + anchor.width / 2 - box.width / 2,
            window.innerWidth - margin - box.width)),
          top: Math.max(margin, Math.min(preferredTop, window.innerHeight - margin - box.height)),
        }
        return current?.left === next.left && current.top === next.top ? current : next
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [preview])

  return (
    <div
      style={{ display: 'contents' }}
      data-response-annotation-source-message-id={messageId}
      onMouseOver={(event) => { show(event.target) }}
      onMouseOut={(event) => { hide(event.target, event.relatedTarget) }}
      onFocusCapture={(event) => { show(event.target) }}
      onBlurCapture={(event) => { hide(event.target, event.relatedTarget) }}
    >
      {children}
      {preview !== null && (
        <span
          ref={tooltipRef}
          role="tooltip"
          data-response-annotation-preview="source"
          style={{
            position: 'fixed',
            zIndex: 1000,
            left: position?.left ?? 12,
            top: position?.top ?? 12,
            maxWidth: 'min(320px, calc(100vw - 24px))',
            maxHeight: 'calc(100vh - 24px)',
            overflowY: 'auto',
            overflowWrap: 'anywhere',
            visibility: position === null ? 'hidden' : 'visible',
            padding: '6px 8px',
            borderRadius: 4,
            background: 'var(--dsw-alias-bg-inverse, #202124)',
            color: 'var(--dsw-alias-label-inverse, #fff)',
            font: '12px/1.4 var(--dsw-font-family)',
            whiteSpace: 'normal',
          }}
          onMouseLeave={(event) => {
            if (event.relatedTarget instanceof Node && preview.marker.contains(event.relatedTarget)) return
            setPreview(null)
          }}
        >
          {preview.text}
        </span>
      )}
    </div>
  )
}

function annotationIdentity(annotation: {
  readonly index: number
  readonly messageId: MessageId
  readonly text: string
  readonly startOffset?: number
  readonly endOffset?: number
}): string {
  return JSON.stringify([
    annotation.messageId, annotation.index, annotation.startOffset, annotation.endOffset, annotation.text,
  ])
}

/** Project durable annotation envelopes back into the occurrence shape consumed by source markers. */
const EMPTY_OCCURRENCES: readonly ResponseAnnotationOccurrence[] = Object.freeze([])
type DurableOccurrenceIndex = ReadonlyMap<MessageId, readonly ResponseAnnotationOccurrence[]>
const durableOccurrenceIndexes = new WeakMap<
  ChatSnapshot['nodes'], WeakMap<readonly string[], DurableOccurrenceIndex>
>()

/** Build one response-annotation index per immutable Chat snapshot, not once per Assistant row. */
function durableAnnotationOccurrences(chat: ChatSnapshot, messageId: MessageId): readonly ResponseAnnotationOccurrence[] {
  let byOrder = durableOccurrenceIndexes.get(chat.nodes)
  if (byOrder === undefined) {
    byOrder = new WeakMap()
    durableOccurrenceIndexes.set(chat.nodes, byOrder)
  }
  let index = byOrder.get(chat.order)
  if (index !== undefined) return index.get(messageId) ?? EMPTY_OCCURRENCES

  const mutable = new Map<MessageId, ResponseAnnotationOccurrence[]>()
  for (const key of chat.order) {
    const node = chat.nodes.get(key)
    if (node === undefined) continue
    if (node.kind !== 'user' && node.kind !== 'steering') continue
    const annotations = (node.data as {
      readonly responseAnnotations?: readonly ResponseAnnotationPresentation[]
    }).responseAnnotations ?? []
    for (const annotation of annotations) {
      const occurrences = mutable.get(annotation.messageId) ?? []
      occurrences.push({
        occurrenceId: -(occurrences.length + 1),
        index: annotation.index,
        messageId: annotation.messageId,
        text: annotation.text,
        ...annotation.startOffset === undefined ? {} : {
          startOffset: annotation.startOffset,
          endOffset: annotation.endOffset,
        },
      })
      mutable.set(annotation.messageId, occurrences)
    }
  }
  index = new Map([...mutable].map(([id, occurrences]) => [id, Object.freeze(occurrences)]))
  byOrder.set(chat.order, index)
  return index.get(messageId) ?? EMPTY_OCCURRENCES
}

/** Streaming, settled, and interrupted Assistant states share one keyed renderer instance. */
export const AssistantNodeView = memo(function AssistantNodeView({
  node, useTurnData, useSession, useInput, openFile, renderMessageImages, fileMentions, inputActions, t,
}: ChatNodeViewProps<'assistant-step'>) {
  const data = node.data
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  const tail = useTurnData('turn-tail')
  const owner = useMemo<TurnTailOwnerProps | undefined>(() => {
    if (turn?.status !== 'closed' || data.finalNode === undefined) return undefined
    if (tail?.closing?.finalNode.seq !== data.finalNode.seq) return undefined
    return { turn, seq: data.finalNode.seq, openFile }
  }, [data.finalNode, openFile, tail, turn])
  const mentions = useMemo(
    () => owner === undefined ? undefined : fileMentions(owner),
    [fileMentions, owner],
  )
  const content = (
    <AssistantMarkdown
      blocks={data.blocks}
      streaming={data.status === 'running'}
      interrupted={data.status === 'interrupted'}
      renderMessageImages={renderMessageImages}
      mentions={mentions}
      t={t}
    />
  )
  const messageId = data.finalNode?.messageId
  const composerAnnotations = useInput(state => state.annotations)
  // Composer attachments use their positive index as occurrence id; durable
  // occurrences use negative ids, so marker keys stay disjoint.
  const activeAnnotations = useMemo<readonly ResponseAnnotationOccurrence[]>(
    () => composerAnnotations.map(annotation => ({ ...annotation, occurrenceId: annotation.index })),
    [composerAnnotations],
  )
  const durableOccurrences = useSession(state => messageId === undefined
    ? EMPTY_OCCURRENCES
    : durableAnnotationOccurrences(state.chat, messageId))
  const occurrences = useMemo<readonly ResponseAnnotationOccurrence[]>(() => {
    if (messageId === undefined) return activeAnnotations
    const active = new Set(activeAnnotations.map(annotationIdentity))
    return [
      ...activeAnnotations,
      ...durableOccurrences.filter((occurrence) => {
        return !active.has(annotationIdentity(occurrence))
      }),
    ]
  }, [activeAnnotations, durableOccurrences, messageId])
  return messageId === undefined
    ? content
    : (
      <AnnotationMarkerPreviewScope messageId={messageId}>
        <ResponseSelectionActions
          messageId={messageId}
          occurrences={occurrences}
          inputActions={inputActions}
          t={t}
        >
          {content}
        </ResponseSelectionActions>
      </AnnotationMarkerPreviewScope>
    )
})
