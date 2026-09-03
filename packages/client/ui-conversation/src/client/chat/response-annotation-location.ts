import type { ResponseAnnotationPayload } from '../response-annotation.ts'

function rangeAt(host: HTMLElement, startOffset: number, endOffset: number): Range | null {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  let cursor = 0
  let start: { node: Text; offset: number } | undefined
  let end: { node: Text; offset: number } | undefined
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text
    const next = cursor + text.data.length
    if (start === undefined && startOffset >= cursor && startOffset <= next) {
      start = { node: text, offset: startOffset - cursor }
    }
    if (endOffset >= cursor && endOffset <= next) {
      end = { node: text, offset: endOffset - cursor }
      break
    }
    cursor = next
  }
  if (start === undefined || end === undefined) return null
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  return range
}

function uniqueTextRange(host: HTMLElement, text: string): Range | null {
  const fullText = host.textContent
  const start = fullText.indexOf(text)
  if (start < 0 || fullText.indexOf(text, start + 1) >= 0) return null
  return rangeAt(host, start, start + text.length)
}

/** Resolve the exact source range, rejecting stale anchors and ambiguous legacy text. */
export function responseAnnotationRange(
  host: HTMLElement,
  annotation: ResponseAnnotationPayload,
): Range | null {
  if (annotation.startOffset === undefined || annotation.endOffset === undefined) {
    return uniqueTextRange(host, annotation.text)
  }
  const anchored = rangeAt(host, annotation.startOffset, annotation.endOffset)
  return anchored?.toString().trim() === annotation.text.trim() ? anchored : null
}

function responseMessageHost(from: Element, messageId: string): HTMLElement | null {
  const root = from.closest('[data-chat-flow]') ?? document
  for (const candidate of root.querySelectorAll<HTMLElement>('[data-response-message-id]')) {
    if (candidate.dataset.responseMessageId === messageId) return candidate
  }
  return null
}

/** Select and reveal the exact source passage for one submitted annotation. */
export function navigateToResponseAnnotation(
  from: Element,
  annotation: ResponseAnnotationPayload,
): boolean {
  const host = responseMessageHost(from, annotation.messageId)
  if (host === null) return false
  const range = responseAnnotationRange(host, annotation)
  if (range === null) return false
  const selection = window.getSelection()
  if (selection === null) return false
  selection.removeAllRanges()
  selection.addRange(range)
  const target = range.startContainer.parentElement ?? host
  if (typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'center', inline: 'nearest' })
  }
  return true
}
