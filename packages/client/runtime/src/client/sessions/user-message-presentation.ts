import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'

const ANNOTATION_ENVELOPE = /<response-annotations>\r?\n([^\r\n]+)\r?\n<\/response-annotations>/gu

function legacyAnnotationDisplayText(text: string): string | undefined {
  let found = false
  let valid = true
  const projected = text.replace(ANNOTATION_ENVELOPE, (_envelope, body: string) => {
    try {
      const parsed: unknown = JSON.parse(body)
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('empty annotation envelope')
      const labels = parsed.map((item) => {
        if (typeof item !== 'object' || item === null) throw new Error('invalid annotation item')
        const record = item as Record<string, unknown>
        if (!Number.isSafeInteger(record['index']) || Number(record['index']) < 1
          || typeof record['sourceMessageId'] !== 'string' || record['sourceMessageId'].length === 0
          || typeof record['text'] !== 'string' || record['text'].trim().length === 0) {
          throw new Error('invalid annotation item')
        }
        return `@Annotation ${Number(record['index'])}`
      })
      found = true
      return labels.join(' ')
    } catch {
      valid = false
      return _envelope
    }
  })
  return found && valid ? projected : undefined
}

/** Resolve the optional presentation text for a direct human message. */
export function userMessageDisplayText(
  content: readonly ContentBlock[],
  source: unknown,
): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const candidate = source as { kind?: unknown; displayText?: unknown }
  if (candidate.kind !== 'user') return undefined
  if (typeof candidate.displayText === 'string') return candidate.displayText
  const firstText = content.find(block => block.type === 'text')
  return firstText?.type === 'text' ? legacyAnnotationDisplayText(firstText.text) : undefined
}

/**
 * Project browser-authored display text without changing the durable,
 * model-facing message. Direct prompt sources may carry this optional hint
 * beside the serialized content so every client surface renders consistently.
 */
export function userMessageDisplayContent(
  content: readonly ContentBlock[],
  source: unknown,
): ContentBlock[] {
  const displayText = userMessageDisplayText(content, source)
  if (displayText === undefined) return [...content]

  let replaced = false
  return content.map((block) => {
    if (block.type !== 'text' || replaced) return block
    replaced = true
    return { type: 'text' as const, text: displayText }
  })
}
