/** Assistant reasoning disclosure, independent of Tool-call presentation. */
import { useState } from 'react'
import { DisclosureRow, IconThinkOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import a11yCss from './accessibility.module.css'
import css from './ReasoningRow.module.css'

/**
 * Render one assistant reasoning block as a collapsed Thinking disclosure.
 * @param props.text - complete or streaming reasoning text.
 * @param props.running - whether this block is the streaming tail.
 * @param props.t - conversation locale seat for the status label.
 * @returns the reasoning disclosure.
 */
export function ReasoningRow({ text, running, t }: { text: string; running: boolean; t: ChatViewSlotProps['t'] }) {
  const [expanded, setExpanded] = useState(false)
  const status = running ? t('row.running') : t('command.done')

  return (
    <div
      className={css.root}
      data-assistant-block-kind="reasoning"
      data-state={running ? 'running' : 'ok'}
    >
      <span
        className={a11yCss.visuallyHidden}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        Thinking {status}
      </span>
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<IconThinkOutline14 size={14} />}
        title="Thinking"
        open={expanded}
        expandable
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={(
          <span className={css.status} aria-hidden>
            <span>{status}</span>
          </span>
        )}
      >
        <div className={css.thinkBody}>{text}</div>
      </DisclosureRow>
    </div>
  )
}
