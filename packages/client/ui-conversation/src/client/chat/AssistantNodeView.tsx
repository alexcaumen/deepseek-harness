import { memo, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type { ChatNodeViewProps, TurnTailOwnerProps } from '../contract/slots.ts'
import {
  parseResponseAnnotationPayload, RESPONSE_ANNOTATION_SOURCE,
  type ResponseAnnotationPresentation,
} from '../response-annotation.ts'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'
import {
  ResponseSelectionActions, type ResponseAnnotationOccurrence,
} from './ResponseSelectionActions.tsx'

interface AnnotationPreview {
  readonly text: string
  readonly left: number
  readonly top: number
  readonly above: boolean
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
  const show = (target: EventTarget): void => {
    const marker = annotationMarker(target)
    if (marker === null || marker.title === '') return
    const rect = marker.getBoundingClientRect()
    const above = rect.bottom + 56 > window.innerHeight
    setPreview({
      text: marker.title,
      left: Math.min(window.innerWidth - 12, Math.max(12, rect.left + rect.width / 2)),
      top: above ? rect.top - 8 : rect.bottom + 8,
      above,
    })
  }
  const hide = (target: EventTarget, relatedTarget: EventTarget | null): void => {
    const marker = annotationMarker(target)
    if (marker !== null && relatedTarget instanceof Node && marker.contains(relatedTarget)) return
    setPreview(null)
  }

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
          role="tooltip"
          data-response-annotation-preview="source"
          style={{
            position: 'fixed',
            zIndex: 1000,
            left: preview.left,
            top: preview.top,
            maxWidth: 'min(320px, calc(100vw - 24px))',
            transform: preview.above ? 'translate(-50%, -100%)' : 'translateX(-50%)',
            padding: '6px 8px',
            borderRadius: 4,
            background: 'var(--dsw-alias-bg-inverse, #202124)',
            color: 'var(--dsw-alias-label-inverse, #fff)',
            font: '12px/1.4 var(--dsw-font-family)',
            whiteSpace: 'normal',
            pointerEvents: 'none',
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
  const activeOccurrences = useInput(state => state.occurrences)
  const activeAnnotations = useMemo<readonly ResponseAnnotationOccurrence[]>(() => activeOccurrences.flatMap(
    (occurrence): ResponseAnnotationOccurrence[] => {
      if (occurrence.source !== RESPONSE_ANNOTATION_SOURCE) return []
      try {
        return [{ ...parseResponseAnnotationPayload(occurrence.ref), occurrenceId: occurrence.occurrenceId }]
      } catch {
        return []
      }
    },
  ), [activeOccurrences])
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
