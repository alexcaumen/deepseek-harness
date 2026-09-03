// The copy-to-clipboard-with-feedback hook shared by the block primitives
// (TerminalBlock, SearchBlock): write the given text, then expose the accepted
// or refused outcome long enough for the caller to render localized feedback.

import { useCallback, useState } from 'react'
import { writeClipboard } from './clipboard.ts'

/** How long an accepted or refused outcome stays visible, in ms. */
const COPY_FEEDBACK_MS = 1000

/** Transient result of the most recent clipboard write. */
export type CopyFeedbackStatus = 'idle' | 'copied' | 'failed'

/** The copy-feedback hook's return: the transient status and the copy handler. */
export interface CopyFeedback {
  /** Accepted or refused for {@link COPY_FEEDBACK_MS}, otherwise idle. */
  status: CopyFeedbackStatus
  /** Copy the hook's text; no-op while outcome feedback is visible. */
  onCopy: () => void
}

/**
 * Copy `text` to the clipboard with one-second outcome feedback.
 * @param text - the text to write on copy.
 * @returns the transient outcome status and the `onCopy` handler.
 */
export function useCopyFeedback(text: string): CopyFeedback {
  const [status, setStatus] = useState<CopyFeedbackStatus>('idle')
  const onCopy = useCallback(() => {
    if (status !== 'idle') return
    void writeClipboard(text).then((ok) => {
      setStatus(ok ? 'copied' : 'failed')
      window.setTimeout(() => { setStatus('idle') }, COPY_FEEDBACK_MS)
    })
  }, [status, text])
  return { status, onCopy }
}
