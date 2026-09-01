import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type {
  InputTriggerSource, ReferenceInsert,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'

/** Stable codec owner used by response-selection references. */
export const RESPONSE_ANNOTATION_SOURCE = 'response-annotation'

export interface ResponseAnnotationPayload {
  readonly index: number
  readonly messageId: MessageId
  readonly text: string
  readonly startOffset?: number
  readonly endOffset?: number
}

/** Parse one persisted response-annotation reference. */
export function parseResponseAnnotationPayload(ref: string): ResponseAnnotationPayload {
  const value: unknown = JSON.parse(ref)
  if (typeof value !== 'object' || value === null) throw new Error('Response annotation payload is invalid')
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record['index']) || Number(record['index']) < 1
    || typeof record['messageId'] !== 'string' || record['messageId'].length === 0
    || typeof record['text'] !== 'string' || record['text'].trim().length === 0) {
    throw new Error('Response annotation payload is invalid')
  }
  const startOffset = record['startOffset']
  const endOffset = record['endOffset']
  const hasAnchor = startOffset !== undefined || endOffset !== undefined
  if (hasAnchor && (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset)
    || Number(startOffset) < 0 || Number(endOffset) <= Number(startOffset))) {
    throw new Error('Response annotation payload is invalid')
  }
  return {
    index: Number(record['index']),
    messageId: record['messageId'] as MessageId,
    text: record['text'],
    ...hasAnchor ? { startOffset: Number(startOffset), endOffset: Number(endOffset) } : {},
  }
}

/** Build the structured composer reference for one selected response passage. */
export function responseAnnotationReference(payload: ResponseAnnotationPayload): ReferenceInsert {
  return {
    source: RESPONSE_ANNOTATION_SOURCE,
    ref: JSON.stringify(payload),
    label: `Annotation ${payload.index}`,
    clipboardText: `Annotation ${payload.index}`,
  }
}

/** Recover an annotation index for numbering and tests. */
export function responseAnnotationIndex(ref: string): number | undefined {
  try {
    return parseResponseAnnotationPayload(ref).index
  } catch {
    return undefined
  }
}

/** Codec-only source: selection creates references directly, so it has no menu candidates. */
export function responseAnnotationSource(): InputTriggerSource {
  return {
    trigger: '@',
    name: RESPONSE_ANNOTATION_SOURCE,
    showGroupTitle: false,
    candidates: () => Promise.resolve([]),
    onPick: () => undefined,
    codec: {
      clipboardText: ref => `Annotation ${parseResponseAnnotationPayload(ref).index}`,
      serialize: ref => Promise.resolve().then(() => {
        const payload = parseResponseAnnotationPayload(ref)
        const body = JSON.stringify([{
          index: payload.index,
          sourceMessageId: payload.messageId,
          text: payload.text,
          ...payload.startOffset === undefined ? {} : {
            sourceStart: payload.startOffset,
            sourceEnd: payload.endOffset,
          },
        }])
        return `<response-annotations>\n${body}\n</response-annotations>`
      }),
    },
  }
}
