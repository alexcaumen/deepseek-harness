import type {
  InputTriggerSource, ReferenceInsert,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {
  parseResponseAnnotationPayload, RESPONSE_ANNOTATION_SOURCE, type ResponseAnnotationPayload,
} from '../response-annotation.ts'

export { parseResponseAnnotationPayload, RESPONSE_ANNOTATION_SOURCE }
export type { ResponseAnnotationPayload }

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
