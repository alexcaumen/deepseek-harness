// MessageText is the literal-text primitive for user and steering content; assistant output uses MarkdownText.

import css from './MessageText.module.css'

/**
 * Render literal text without interpreting markup.
 * @param props - Text and optional inline placement among reference chips.
 * @returns Escaped text retaining authored whitespace.
 */
export function MessageText({ text, inline = false }: { text: string; inline?: boolean }) {
  return inline ? <span className={css.text}>{text}</span> : <div className={css.text}>{text}</div>
}
