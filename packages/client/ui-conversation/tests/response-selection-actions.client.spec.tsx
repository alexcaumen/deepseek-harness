// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type { InputActions } from '../src/client/input/contract.ts'
import type { ChatViewSlotProps } from '../src/client/contract/slots.ts'
import { ResponseSelectionActions } from '../src/client/chat/ResponseSelectionActions.tsx'

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  cleanup()
})

describe('response selection actions', () => {
  it('adds only the selected assistant passage to the active composer', () => {
    const addResponseAnnotation = vi.fn(() => true)
    const inputActions = {
      setDraft: vi.fn(),
      addResponseAnnotation,
      removeResponseAnnotation: vi.fn(),
      clearResponseAnnotations: vi.fn(),
      commentResponseAnnotation: vi.fn(),
      addImages: vi.fn(),
      removeImage: vi.fn(),
      pruneImages: vi.fn(),
      submit: vi.fn(),
    } satisfies InputActions
    const t: ChatViewSlotProps['t'] = key => key === 'annotation.addToChat'
      ? 'Add to chat'
      : 'Selected response actions'
    const view = render(
      <ResponseSelectionActions
        messageId={'assistant-message-1' as MessageId}
        occurrences={[]}
        inputActions={inputActions}
        t={t}
      >
        <p>alpha selected passage omega</p>
      </ResponseSelectionActions>,
    )
    const paragraph = view.getByText('alpha selected passage omega')
    const text = paragraph.firstChild
    if (!(text instanceof Text)) throw new Error('fixture text node missing')
    const range = document.createRange()
    range.setStart(text, 6)
    range.setEnd(text, 22)
    Object.defineProperty(range, 'getBoundingClientRect', {
      value: () => ({ left: 100, top: 100, width: 80, height: 20, right: 180, bottom: 120, x: 100, y: 100, toJSON: () => ({}) }),
    })
    window.getSelection()?.addRange(range)

    fireEvent.pointerUp(paragraph)
    fireEvent.click(view.getByRole('button', { name: 'Add to chat' }))

    expect(addResponseAnnotation).toHaveBeenCalledWith({
      messageId: 'assistant-message-1',
      text: 'selected passage',
      startOffset: 6,
      endOffset: 22,
    })
    expect(window.getSelection()?.rangeCount).toBe(0)
  })

  it('marks an active annotation at its source and exposes its text on hover', () => {
    const original = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [{ left: 10, top: 20, right: 90, bottom: 40, width: 80, height: 20 }],
    })
    try {
      const inputActions = {
        setDraft: vi.fn(), addResponseAnnotation: vi.fn(() => true),
        removeResponseAnnotation: vi.fn(), clearResponseAnnotations: vi.fn(), commentResponseAnnotation: vi.fn(), addImages: vi.fn(),
        removeImage: vi.fn(), pruneImages: vi.fn(), submit: vi.fn(),
      } satisfies InputActions
      const view = render(
        <ResponseSelectionActions
          messageId={'assistant-message-1' as MessageId}
          occurrences={[{
            occurrenceId: 7,
            index: 1,
            messageId: 'assistant-message-1' as MessageId,
            text: 'selected passage',
            startOffset: 6,
            endOffset: 22,
          }]}
          inputActions={inputActions}
          t={(key, values) => key === 'annotation.sourceMarker'
            ? `Annotation ${String(values?.index)} source: ${String(values?.text)}`
            : key}
        >
          <p>alpha selected passage omega</p>
        </ResponseSelectionActions>,
      )
      const marker = view.getByRole('button', { name: 'Annotation 1 source: selected passage' })
      expect(marker.getAttribute('title')).toBe('selected passage')
      expect(marker.getAttribute('data-response-annotation-marker')).toBe('1')
      expect(view.container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1)
    } finally {
      if (original === undefined) delete (Range.prototype as { getClientRects?: unknown }).getClientRects
      else Object.defineProperty(Range.prototype, 'getClientRects', original)
    }
  })

  it('does not place an anchorless legacy marker on ambiguous duplicate text', () => {
    const original = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [{ left: 10, top: 20, right: 50, bottom: 40, width: 40, height: 20 }],
    })
    try {
      const inputActions = {
        setDraft: vi.fn(), addResponseAnnotation: vi.fn(() => true),
        removeResponseAnnotation: vi.fn(), clearResponseAnnotations: vi.fn(), commentResponseAnnotation: vi.fn(), addImages: vi.fn(),
        removeImage: vi.fn(), pruneImages: vi.fn(), submit: vi.fn(),
      } satisfies InputActions
      const view = render(
        <ResponseSelectionActions
          messageId={'assistant-message-1' as MessageId}
          occurrences={[{
            occurrenceId: 8,
            index: 2,
            messageId: 'assistant-message-1' as MessageId,
            text: 'repeated passage',
          }]}
          inputActions={inputActions}
          t={key => key}
        >
          <p>repeated passage then repeated passage</p>
        </ResponseSelectionActions>,
      )

      expect(view.container.querySelector('[data-response-annotation-marker="2"]')).toBeNull()
      expect(view.container.querySelector('[aria-hidden="true"]')).toBeNull()
    } finally {
      if (original === undefined) delete (Range.prototype as { getClientRects?: unknown }).getClientRects
      else Object.defineProperty(Range.prototype, 'getClientRects', original)
    }
  })
})
