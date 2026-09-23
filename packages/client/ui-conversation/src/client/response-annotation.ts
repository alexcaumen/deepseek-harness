import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'

const ANNOTATION_ENVELOPE = /<response-annotations>\r?\n([^\r\n]+)\r?\n<\/response-annotations>/gu

/** Stable codec owner used by response-selection references. */
export const RESPONSE_ANNOTATION_SOURCE = 'response-annotation'

/** Longest user comment retained on one annotation. */
export const RESPONSE_ANNOTATION_COMMENT_MAX_LENGTH = 2000

/** One selected response passage retained as a composer annotation attachment. */
export interface ResponseAnnotationPayload {
  readonly index: number
  readonly messageId: MessageId
  readonly text: string
  readonly startOffset?: number
  readonly endOffset?: number
  /** Optional user comment delivered to the model with the quote. */
  readonly comment?: string
}

/** Durable annotation data plus its exact range in projected user text. */
export interface ResponseAnnotationPresentation extends ResponseAnnotationPayload {
  readonly displayStart: number
  readonly displayEnd: number
}

/** Exact model/display splice for a reference beside an annotation. */
export interface ResponseAnnotationProjection {
  readonly modelStart: number
  readonly displayStart: number
  readonly model: string
  readonly display: string
}

/**
 * Structured annotation retained beside the persisted draft. `offset` is
 * {@link RESPONSE_ANNOTATION_ATTACHMENT_OFFSET} for a composer attachment;
 * a non-negative offset marks a draft written before annotations left the
 * draft text, whose `@Annotation N` token is removed on restore.
 */
export interface PersistedResponseAnnotation {
  readonly offset: number
  readonly ref: string
}

/** Persisted offset of an annotation held as a composer attachment rather than draft text. */
export const RESPONSE_ANNOTATION_ATTACHMENT_OFFSET = -1

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
  const comment = record['comment']
  if (comment !== undefined && (typeof comment !== 'string'
    || comment.length > RESPONSE_ANNOTATION_COMMENT_MAX_LENGTH)) {
    throw new Error('Response annotation payload is invalid')
  }
  return {
    index: Number(record['index']),
    messageId: record[messageIdKey] as MessageId,
    text: record['text'],
    ...hasAnchor ? { startOffset: Number(startOffset), endOffset: Number(endOffset) } : {},
    ...typeof comment === 'string' && comment.trim().length > 0 ? { comment: comment.trim() } : {},
  }
}

/** Display label of one annotation inside sent user text. */
export function responseAnnotationLabel(index: number): string {
  return `@Annotation ${index}`
}

/**
 * Model-facing envelope for composer annotations, in index order. Its
 * projection is the labels joined by one space, which is the display prefix
 * produced by {@link responseAnnotationDisplayPrefix}.
 */
export function responseAnnotationEnvelope(
  payloads: readonly ResponseAnnotationPayload[],
  references: readonly ResponseAnnotationProjection[] = [],
): string {
  const annotations = payloads.map(payload => ({
    index: payload.index,
    sourceMessageId: payload.messageId,
    text: payload.text,
    ...payload.startOffset === undefined ? {} : {
      sourceStart: payload.startOffset,
      sourceEnd: payload.endOffset,
    },
    ...payload.comment === undefined ? {} : { comment: payload.comment },
  }))
  const body = JSON.stringify(references.length === 0 ? annotations : { annotations, references })
  return `<response-annotations>\n${body}\n</response-annotations>`
}

/** Display-text prefix matching {@link responseAnnotationEnvelope}'s projection. */
export function responseAnnotationDisplayPrefix(payloads: readonly ResponseAnnotationPayload[]): string {
  return payloads.map(payload => responseAnnotationLabel(payload.index)).join(' ')
}

/** Parse one persisted response-annotation reference. */
export function parseResponseAnnotationPayload(ref: string): ResponseAnnotationPayload {
  const value: unknown = JSON.parse(ref)
  if (typeof value !== 'object' || value === null) throw new Error('Response annotation payload is invalid')
  return responseAnnotationPayload(value as Record<string, unknown>, 'messageId', 'startOffset', 'endOffset')
}

function parseEnvelope(body: string): {
  annotations: readonly ResponseAnnotationPayload[]
  references: readonly ResponseAnnotationProjection[]
} | undefined {
  try {
    const value: unknown = JSON.parse(body)
    const wrapped = !Array.isArray(value) && typeof value === 'object' && value !== null
      ? value as Record<string, unknown>
      : undefined
    const items = wrapped?.['annotations'] ?? value
    if (!Array.isArray(items) || items.length === 0) throw new Error('Response annotation payload is invalid')
    const annotations = items.map((item) => {
      if (typeof item !== 'object' || item === null) throw new Error('Response annotation payload is invalid')
      return responseAnnotationPayload(
        item as Record<string, unknown>,
        'sourceMessageId',
        'sourceStart',
        'sourceEnd',
      )
    })
    const rawReferences = wrapped?.['references'] ?? []
    if (!Array.isArray(rawReferences)) throw new Error('Response annotation projection is invalid')
    const references = rawReferences.map((item): ResponseAnnotationProjection => {
      if (typeof item !== 'object' || item === null) throw new Error('Response annotation projection is invalid')
      const ref = item as Record<string, unknown>
      if (!Number.isSafeInteger(ref['modelStart']) || Number(ref['modelStart']) < 0
        || !Number.isSafeInteger(ref['displayStart']) || Number(ref['displayStart']) < 0
        || typeof ref['model'] !== 'string' || ref['model'].length === 0
        || typeof ref['display'] !== 'string' || ref['display'].length === 0) {
        throw new Error('Response annotation projection is invalid')
      }
      return ref as unknown as ResponseAnnotationProjection
    })
    return { annotations, references }
  } catch {
    return undefined
  }
}

function projectReferences(model: string, references: readonly ResponseAnnotationProjection[]): string | undefined {
  let projected = ''
  let modelCursor = 0
  for (const reference of references) {
    if (reference.modelStart < modelCursor || reference.displayStart !== projected.length
      + reference.modelStart - modelCursor
      || model.slice(reference.modelStart, reference.modelStart + reference.model.length) !== reference.model) {
      return undefined
    }
    projected += model.slice(modelCursor, reference.modelStart) + reference.display
    modelCursor = reference.modelStart + reference.model.length
  }
  return projected + model.slice(modelCursor)
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
  readonly valid: boolean
} {
  let projected = ''
  let cursor = 0
  const annotations: ResponseAnnotationPresentation[] = []
  for (const match of text.matchAll(ANNOTATION_ENVELOPE)) {
    const envelopeStart = match.index
    const envelope = match[0]
    const body = match[1]
    if (body === undefined) continue
    projected += text.slice(cursor, envelopeStart)
    const parsed = parseEnvelope(body)
    if (parsed === undefined) {
      projected += envelope
    } else {
      if (parsed.references.length > 0) {
        // Reference offsets are relative to the suffix after this envelope.
        // Such envelopes are emitted only at the start of a user message.
        const suffix = text.slice(envelopeStart + envelope.length)
        if (envelopeStart !== 0 || !suffix.startsWith(' ')) return { text: '', annotations: [], valid: false }
        const displaySuffix = projectReferences(suffix.slice(1), parsed.references)
        if (displaySuffix === undefined) return { text: '', annotations: [], valid: false }
        parsed.annotations.forEach((payload, index) => {
          if (index > 0) projected += ' '
          const label = responseAnnotationLabel(payload.index)
          const displayStart = projected.length
          projected += label
          annotations.push({ ...payload, displayStart, displayEnd: projected.length })
        })
        return { text: `${projected} ${displaySuffix}`, annotations, valid: true }
      }
      parsed.annotations.forEach((payload, index) => {
        if (index > 0) projected += ' '
        const label = responseAnnotationLabel(payload.index)
        const displayStart = projected.length
        projected += label
        annotations.push({ ...payload, displayStart, displayEnd: projected.length })
      })
    }
    cursor = envelopeStart + envelope.length
  }
  projected += text.slice(cursor)
  return { text: projected, annotations, valid: true }
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
    if (!projected.valid) return []
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
