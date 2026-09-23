/** Compact composer attachment for selected response passages (Codex-style "N annotations" chip). */

import { useEffect, useId, useRef, useState } from 'react'
import type { FocusEvent, KeyboardEvent, ReactNode } from 'react'
import {
  IconCloseOutline16, IconEditOutline16, IconListPenOutline16, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComposerBarProps } from '../contract/slots.ts'
import type { ResponseAnnotationPayload } from '../response-annotation.ts'
import { RESPONSE_ANNOTATION_COMMENT_MAX_LENGTH } from '../response-annotation.ts'
import css from './AnnotationAttachment.module.css'

const OPEN_DELAY_MS = 150
const CLOSE_GRACE_MS = 200

/**
 * Render the composer annotation chip and its preview card.
 * @param props.annotations - composer annotations numbered 1..N.
 * @param props.locked - admission in flight; editing controls are disabled.
 * @param props.onRemove - remove one annotation by index.
 * @param props.onClear - remove every annotation.
 * @param props.onComment - set or clear one annotation's comment.
 * @param props.onNavigate - scroll to the annotation's source marker.
 * @param props.t - conversation translator.
 * @returns the chip, or null when there are no annotations.
 */
export function AnnotationAttachment({
  annotations, locked, onRemove, onClear, onComment, onNavigate, t,
}: {
  readonly annotations: readonly ResponseAnnotationPayload[]
  readonly locked: boolean
  readonly onRemove: (index: number) => void
  readonly onClear: () => void
  readonly onComment: (index: number, comment: string) => void
  readonly onNavigate: (annotation: ResponseAnnotationPayload) => void
  readonly t: ComposerBarProps['t']
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<ResponseAnnotationPayload | null>(null)
  const [draft, setDraft] = useState('')
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const chipRef = useRef<HTMLButtonElement | null>(null)
  const suppressFocusOpen = useRef(false)
  const cardId = useId()

  const clearTimers = (): void => {
    if (openTimer.current !== null) clearTimeout(openTimer.current)
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    openTimer.current = null
    closeTimer.current = null
  }
  useEffect(() => clearTimers, [])
  useEffect(() => {
    if (annotations.length === 0) {
      clearTimers()
      setOpen(false)
      setEditing(null)
    } else if (editing !== null && !annotations.includes(editing)) {
      setEditing(null)
    }
  }, [annotations, editing])

  if (annotations.length === 0) return null

  const scheduleOpen = (): void => {
    clearTimers()
    if (open) return
    openTimer.current = setTimeout(() => { setOpen(true) }, OPEN_DELAY_MS)
  }
  const scheduleClose = (): void => {
    if (editing !== null || rootRef.current?.contains(document.activeElement) === true) return
    clearTimers()
    closeTimer.current = setTimeout(() => { setOpen(false) }, CLOSE_GRACE_MS)
  }
  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (rootRef.current?.contains(event.relatedTarget) === true) return
    if (editing !== null) return
    clearTimers()
    setOpen(false)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    clearTimers()
    setEditing(null)
    setOpen(false)
    suppressFocusOpen.current = true
    chipRef.current?.focus()
    suppressFocusOpen.current = false
  }
  const startEdit = (annotation: ResponseAnnotationPayload): void => {
    setDraft(annotation.comment ?? '')
    setEditing(annotation)
    setOpen(true)
  }
  const saveEdit = (index: number): void => {
    if (locked) return
    onComment(index, draft)
    setEditing(null)
    chipRef.current?.focus()
  }
  const remove = (index: number): void => {
    if (annotations.length === 1) {
      rootRef.current?.closest('[data-composer-card]')?.querySelector<HTMLTextAreaElement>('textarea[data-phase]')?.focus()
    } else {
      chipRef.current?.focus()
    }
    onRemove(index)
  }

  const label = annotations.length === 1
    ? t('annotation.countOne')
    : t('annotation.countMany', { count: annotations.length })

  return (
    <div
      ref={rootRef}
      className={css.root}
      data-annotation-attachment
      onPointerEnter={scheduleOpen}
      onPointerLeave={scheduleClose}
      onFocus={() => {
        if (suppressFocusOpen.current) return
        clearTimers()
        setOpen(true)
      }}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      <div className={css.chip}>
        <button
          ref={chipRef}
          type="button"
          className={css.chipLabel}
          aria-expanded={open}
          aria-controls={open ? cardId : undefined}
          aria-label={label}
          data-annotation-count={annotations.length}
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={() => { clearTimers(); setOpen(value => !value) }}
        >
          <IconListPenOutline16 size={14} className={css.chipIcon} />
          <span>{label}</span>
        </button>
        <button
          type="button"
          className={css.chipClear}
          aria-label={t('annotation.clear')}
          title={t('annotation.clear')}
          disabled={locked}
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={() => {
            rootRef.current?.closest('[data-composer-card]')?.querySelector<HTMLTextAreaElement>('textarea[data-phase]')?.focus()
            clearTimers()
            setOpen(false)
            onClear()
          }}
        >
          <IconCloseOutline16 size={12} />
        </button>
      </div>
      {open && (
        <div id={cardId} className={css.card} role="dialog" aria-label={label} data-annotation-preview>
          <ol className={css.list}>
            {annotations.map(annotation => (
              <li key={annotation.index} className={css.item} data-annotation-preview-item={annotation.index}>
                <span className={css.ordinal}>{annotation.index}.</span>
                <div className={css.body}>
                  <div className={css.header}>
                    <span className={css.caption}>{t('annotation.selectedText')}</span>
                    <span className={css.actions}>
                      <button
                        type="button"
                        className={css.action}
                        aria-label={t('annotation.edit', { index: annotation.index })}
                        title={t('annotation.edit', { index: annotation.index })}
                        disabled={locked}
                        onClick={() => { startEdit(annotation) }}
                      >
                        <IconEditOutline16 size={14} />
                      </button>
                      <button
                        type="button"
                        className={css.action}
                        aria-label={t('annotation.delete', { index: annotation.index })}
                        title={t('annotation.delete', { index: annotation.index })}
                        disabled={locked}
                        onClick={() => { remove(annotation.index) }}
                      >
                        <IconTrashOutline16 size={14} />
                      </button>
                    </span>
                  </div>
                  <button
                    type="button"
                    className={css.quote}
                    title={t('annotation.showSource')}
                    onClick={() => { onNavigate(annotation) }}
                  >
                    {annotation.text}
                  </button>
                  {editing === annotation
                    ? (
                      <div className={css.editor}>
                        <textarea
                          className={css.comment}
                          aria-label={t('annotation.commentLabel', { index: annotation.index })}
                          placeholder={t('annotation.commentPlaceholder')}
                          maxLength={RESPONSE_ANNOTATION_COMMENT_MAX_LENGTH}
                          value={draft}
                          disabled={locked}
                          autoFocus
                          onChange={(event) => { setDraft(event.target.value) }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                              event.preventDefault()
                              saveEdit(annotation.index)
                            }
                          }}
                        />
                        <div className={css.editorActions}>
                          <button type="button" className={css.secondary} onClick={() => { setEditing(null); chipRef.current?.focus() }}>
                            {t('annotation.cancel')}
                          </button>
                          <button type="button" className={css.primary} disabled={locked} onClick={() => { saveEdit(annotation.index) }}>
                            {t('annotation.save')}
                          </button>
                        </div>
                      </div>
                    )
                    : annotation.comment !== undefined && (
                      <p className={css.commentText} data-annotation-comment>{annotation.comment}</p>
                    )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
