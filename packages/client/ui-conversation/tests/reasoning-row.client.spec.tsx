// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)
const renderMessageImages: AssistantMarkdownProps['renderMessageImages'] = () => null

describe('ReasoningRow', () => {
  it('is collapsed by default with an accessible completed status', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    const disclosure = view.getByRole('button', { name: /Thinking/ })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText(/Inspect the session\s+Check persistence/)).toBeNull()
    expect(view.getByRole('status').textContent).toBe('Thinking 已完成')
  })

  it('expands and collapses from the keyboard without losing replayed reasoning', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    const disclosure = view.getByRole('button', { name: /Thinking/ })

    fireEvent.keyDown(disclosure, { key: 'Enter' })
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(/Inspect the session\s+Check persistence/)).toBeTruthy()

    fireEvent.keyDown(disclosure, { key: ' ' })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText(/Inspect the session\s+Check persistence/)).toBeNull()
  })

  it('keeps streaming updates collapsed and reports completion without auto-opening', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    const disclosure = view.getByRole('button', { name: /Thinking/ })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(view.getByRole('status').textContent).toBe('Thinking 运行中')
    view.rerender(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText(/Inspect the session\s+Newest reasoning tokens/)).toBeNull()

    view.rerender(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByRole('status').textContent).toBe('Thinking 已完成')
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps the final answer visible as one separate text block', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[
          { kind: 'reasoning', text: 'Private chain of thought' },
          { kind: 'text', text: 'The final answer stays visible.' },
        ]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByRole('button', { name: /Thinking/ }).getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText('Private chain of thought')).toBeNull()
    expect(view.getByText('The final answer stays visible.')).toBeTruthy()
    expect(view.container.querySelectorAll('[data-assistant-block-kind="text"]')).toHaveLength(1)
  })
})
