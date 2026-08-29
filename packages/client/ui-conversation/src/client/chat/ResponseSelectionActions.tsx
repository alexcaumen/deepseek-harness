import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type { InputActions } from '../input/contract.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './ResponseSelectionActions.module.css'

interface SelectionState {
  readonly text: string
  readonly left: number
  readonly top: number
}

export interface ResponseSelectionActionsProps {
  readonly messageId: MessageId
  readonly inputActions: InputActions
  readonly t: ChatViewSlotProps['t']
  readonly children: ReactNode
}

/** Selection-local Add to chat action for one finalized assistant response. */
export function ResponseSelectionActions({
  messageId, inputActions, t, children,
}: ResponseSelectionActionsProps): ReactNode {
  const root = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<SelectionState | null>(null)

  const capture = useCallback(() => {
    const selection = window.getSelection()
    const host = root.current
    if (host === null || selection === null || selection.isCollapsed || selection.rangeCount === 0) {
      setSelected(null)
      return
    }
    const range = selection.getRangeAt(0)
    if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) {
      setSelected(null)
      return
    }
    const text = selection.toString().trim()
    if (text.length === 0) {
      setSelected(null)
      return
    }
    const rect = range.getBoundingClientRect()
    setSelected({
      text,
      left: Math.min(window.innerWidth - 64, Math.max(64, rect.left + rect.width / 2)),
      top: Math.max(44, rect.top - 6),
    })
  }, [])

  useEffect(() => {
    const dismiss = () => { setSelected(null) }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [])

  const add = () => {
    if (selected === null) return
    if (!inputActions.addResponseAnnotation({ messageId, text: selected.text })) return
    window.getSelection()?.removeAllRanges()
    setSelected(null)
  }

  return (
    <div ref={root} className={css.root} onPointerUp={capture} onKeyUp={capture}>
      {children}
      {selected !== null && createPortal(
        <div
          className={css.toolbar}
          role="toolbar"
          aria-label={t('annotation.toolbar')}
          style={{ left: selected.left, top: selected.top }}
        >
          <button type="button" className={css.action} onClick={add}>
            {t('annotation.addToChat')}
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}
