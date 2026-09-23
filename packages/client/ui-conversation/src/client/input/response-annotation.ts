import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {
  parseResponseAnnotationPayload, RESPONSE_ANNOTATION_SOURCE, responseAnnotationEnvelope,
  type ResponseAnnotationPayload,
} from '../response-annotation.ts'

export { parseResponseAnnotationPayload, RESPONSE_ANNOTATION_SOURCE }
export type { ResponseAnnotationPayload }

/**
 * Codec-only source: selection creates composer attachments directly, so it
 * has no menu candidates. It still serializes a reference that arrives through
 * the shared reference pipeline (for example a pasted durable reference).
 */
export function responseAnnotationSource(): InputTriggerSource {
  return {
    trigger: '@',
    name: RESPONSE_ANNOTATION_SOURCE,
    showGroupTitle: false,
    candidates: () => Promise.resolve([]),
    onPick: () => undefined,
    codec: {
      clipboardText: ref => `Annotation ${parseResponseAnnotationPayload(ref).index}`,
      serialize: ref => Promise.resolve().then(() => responseAnnotationEnvelope([parseResponseAnnotationPayload(ref)])),
    },
  }
}
