import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'

/**
 * Project browser-authored display text without changing the durable,
 * model-facing message. Direct prompt sources may carry this optional hint
 * beside the serialized content so every client surface renders consistently.
 */
export function userMessageDisplayContent(
  content: readonly ContentBlock[],
  source: unknown,
): ContentBlock[] {
  if (typeof source !== 'object' || source === null) return [...content]
  const candidate = source as { kind?: unknown; displayText?: unknown }
  if (candidate.kind !== 'user' || typeof candidate.displayText !== 'string') return [...content]

  let replaced = false
  return content.map((block) => {
    if (block.type !== 'text' || replaced) return block
    replaced = true
    return { type: 'text' as const, text: candidate.displayText as string }
  })
}
