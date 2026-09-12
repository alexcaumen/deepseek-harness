import { useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { createSnapshotStore } from '../../../../packages/client/runtime/src/client/contract/store.ts'
import { SessionInputShell } from '../../../../packages/client/ui-conversation/src/client/input/facade.ts'
import { InputBar } from '../../../../packages/client/ui-conversation/src/client/skeleton/InputBar.tsx'
import { ResponseSelectionActions } from '../../../../packages/client/ui-conversation/src/client/chat/ResponseSelectionActions.tsx'
import '../../../../packages/client/ui-theme/src/styles/design-platform.css'
import './sidecar.css'

const messageId = 'annotation-qa-source'
const source = 'Before the annotated source passage wraps over several lines in this deliberately narrow response column, the answer continues with a closing sentence.'
const quote = 'annotated source passage wraps over several lines in this deliberately narrow response column'
const startOffset = source.indexOf(quote)
const shell = new SessionInputShell({
  actx: {} as never,
  defaultSink: async () => ({ kind: 'success' }),
  commandImages: { serialize: async () => [], release() {}, unsupportedNotice: () => '' },
})
shell.actions.addResponseAnnotation({ messageId: messageId as never, text: quote, startOffset, endOffset: startOffset + quote.length })

function useStore<T, R>(store: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }, selector: (state: T) => R): R {
  return selector(useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot))
}

const session = createSnapshotStore({ promptError: null, running: false, subagent: null, removed: false })
const launcher = createSnapshotStore<string | null>(null)
const t = (key: string, values?: Record<string, unknown>): string => {
  if (key === 'annotation.sourceMarker') return `Annotation ${values?.index} source: ${values?.text}`
  if (key === 'annotation.item') return `Annotation ${values?.index}: ${values?.text}`
  if (key === 'annotation.rail') return `${values?.count} annotations`
  return key
}
const props = {
  sessionId: 'qa-session',
  useSession: (selector: (state: unknown) => unknown) => useStore(session, selector),
  useInput: (selector: (state: unknown) => unknown) => useStore(shell.state, selector),
  useNotices: (selector: (state: unknown) => unknown) => useStore(shell.notices, selector),
  useLexicon: (selector: (state: unknown) => unknown) => useStore(shell.lexicon, selector),
  useMenuLauncher: (selector: (state: unknown) => unknown) => useStore(launcher, selector),
  useProjection: (_key: string, selector?: (value: unknown) => unknown) => selector?.(undefined),
  inputActions: shell.actions,
  keyboard: shell,
  addImages: () => null,
  removeImage: () => {},
  draftImages: () => [],
  resolveSubmitMode: () => 'queue',
  toggleCommandMenu: () => {},
  stop: () => {},
  command: async () => true,
  t,
  renderSlot: () => null,
  variant: 'composer',
}
const annotation = shell.snapshot.occurrences[0]
if (annotation === undefined) throw new Error('Annotation fixture did not create an occurrence')

createRoot(document.getElementById('root')!).render(
  <main>
    <section className="response" data-response-annotation-source-message-id={messageId}>
      <div className="eyebrow">Assistant response</div>
      <ResponseSelectionActions
        messageId={messageId as never}
        occurrences={[{
          occurrenceId: annotation.occurrenceId,
          index: 1,
          messageId: messageId as never,
          text: quote,
          startOffset,
          endOffset: startOffset + quote.length,
        }]}
        inputActions={shell.actions}
        t={t as never}
      >
        <p>{source}</p>
      </ResponseSelectionActions>
    </section>
    <section className="composer" aria-label="Composer">
      <InputBar {...props as never} />
    </section>
  </main>,
)
