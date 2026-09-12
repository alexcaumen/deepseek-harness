import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'

const ANNOTATION_ENVELOPE = /<response-annotations>\r?\n([^\r\n]+)\r?\n<\/response-annotations>/gu

/** Stable codec owner used by response-selection references. */
export const RESPONSE_ANNOTATION_SOURCE = 'response-annotation'

/** One selected response passage retained by a composer reference. */
export interface ResponseAnnotationPayload {
  readonly index: number
  readonly messageId: MessageId
  readonly text: string
  readonly startOffset?: number
  readonly endOffset?: number
}

/** Durable annotation data plus its exact range in projected user text. */
export interface ResponseAnnotationPresentation extends ResponseAnnotationPayload {
  readonly displayStart: number
  readonly displayEnd: number
}

/** Structured reference retained beside the persisted display-only draft. */
export interface PersistedResponseAnnotation {
  readonly offset: number
  readonly ref: string
}

function responseAnnotationPayload(
  record: Record<string, unknown>,
  messageIdKey: 'messageId' | 'sourceMessageId',
  startKey: 'startOffset' | 'sourceStart',
  endKey: 'endOffset' | 'sourceEnd',
): ResponseAnnotationPayload {
  if (!Number.isSafeInteger(record['index']) || Number(record['index']) < 1
    || typeof record[messageIdKey] !== 'string' || record[messageIdKey].length === 0
    || typeof record['text'] !== 'string' || record['text'].trim().length === 0) {
    throw new Error('Response annotation payload is invalid')
  }
  const startOffset = record[startKey]
  const endOffset = record[endKey]
  const hasAnchor = startOffset !== undefined || endOffset !== undefined
  if (hasAnchor && (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset)
    || Number(startOffset) < 0 || Number(endOffset) <= Number(startOffset))) {
    throw new Error('Response annotation payload is invalid')
  }
  return {
    index: Number(record['index']),
    messageId: record[messageIdKey] as MessageId,
    text: record['text'],
    ...hasAnchor ? { startOffset: Number(startOffset), endOffset: Number(endOffset) } : {},
  }
}

/** Parse one persisted response-annotation reference. */
export function parseResponseAnnotationPayload(ref: string): ResponseAnnotationPayload {
  const value: unknown = JSON.parse(ref)
  if (typeof value !== 'object' || value === null) throw new Error('Response annotation payload is invalid')
  return responseAnnotationPayload(value as Record<string, unknown>, 'messageId', 'startOffset', 'endOffset')
}

function parseEnvelope(body: string): readonly ResponseAnnotationPayload[] | undefined {
  try {
    const value: unknown = JSON.parse(body)
    if (!Array.isArray(value) || value.length === 0) throw new Error('Response annotation payload is invalid')
    return value.map((item) => {
      if (typeof item !== 'object' || item === null) throw new Error('Response annotation payload is invalid')
      return responseAnnotationPayload(
        item as Record<string, unknown>,
        'sourceMessageId',
        'sourceStart',
        'sourceEnd',
      )
    })
  } catch {
    return undefined
  }
}

function textBlocks(content: readonly unknown[]): readonly string[] {
  return content.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const candidate = block as { type?: unknown; text?: unknown }
    return candidate.type === 'text' && typeof candidate.text === 'string' ? [candidate.text] : []
  })
}

function projectModelText(text: string): {
  readonly text: string
  readonly annotations: readonly ResponseAnnotationPresentation[]
} {
  let projected = ''
  let cursor = 0
  const annotations: ResponseAnnotationPresentation[] = []
  for (const match of text.matchAll(ANNOTATION_ENVELOPE)) {
    const envelopeStart = match.index
    const envelope = match[0]
    const body = match[1]
    if (envelopeStart === undefined || envelope === undefined || body === undefined) continue
    projected += text.slice(cursor, envelopeStart)
    const payloads = parseEnvelope(body)
    if (payloads === undefined) {
      projected += envelope
    } else {
      payloads.forEach((payload, index) => {
        if (index > 0) projected += ' '
        const label = `@Annotation ${payload.index}`
        const displayStart = projected.length
        projected += label
        annotations.push({ ...payload, displayStart, displayEnd: projected.length })
      })
    }
    cursor = envelopeStart + envelope.length
  }
  projected += text.slice(cursor)
  return { text: projected, annotations }
}

/**
 * Recover structured annotations from durable model text when its envelope
 * projection exactly matches the displayed user text.
 */
export function responseAnnotationPresentations(
  modelContent: readonly unknown[],
  displayContent: readonly unknown[],
): readonly ResponseAnnotationPresentation[] {
  let projectedText = ''
  const annotations: ResponseAnnotationPresentation[] = []
  for (const text of textBlocks(modelContent)) {
    const projected = projectModelText(text)
    const base = projectedText.length
    projectedText += projected.text
    annotations.push(...projected.annotations.map(annotation => ({
      ...annotation,
      displayStart: base + annotation.displayStart,
      displayEnd: base + annotation.displayEnd,
    })))
  }
  if (annotations.length === 0 || textBlocks(displayContent).join('') !== projectedText) return []
  return annotations
}
