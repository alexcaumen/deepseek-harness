import { useCallback, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  CodeBlock, IconDataOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ConversationSnapshot, ISessions, RunningToolCall, SessionId, ToolCallBlock, ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  BetterSidebarService, TabComponentProps,
} from 'dsh-better-sidebar/client/service'
import type { SelectionTarget } from '../contract/views.ts'
import { findToolCall } from '../chat/tool-node-reader.ts'
import type { ConversationKey } from '../locales.ts'
import css from './DetailsPanel.module.css'

type Translate = (key: ConversationKey) => string

interface CallMaterial {
  name: string
  argsRaw: string | null
  block: ToolCallBlock
}

const EMPTY_SUBSCRIBE = () => () => {}
const EMPTY_SELECTION = () => null
const EMPTY_SESSION = () => null

function settledMaterial(node: ToolResultNode, callId: string): CallMaterial {
  return { name: node.call?.name ?? callId, argsRaw: node.call?.argsRaw ?? null, block: node }
}

function runningMaterial(call: RunningToolCall): CallMaterial {
  return { name: call.name, argsRaw: call.argsRaw, block: call }
}

function materialFor(snapshot: ConversationSnapshot, callId: string): CallMaterial | null {
  const found = findToolCall(snapshot, callId)
  if (found === undefined) return null
  return 'kind' in found ? settledMaterial(found, callId) : runningMaterial(found)
}

function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function rawResultText(block: ToolCallBlock): string {
  if (!('kind' in block)) return ''
  const parts = block.content.map(item => item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
  if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
  return parts.join('\n')
}

/** Ephemeral UI linkage only. Canonical session, memory, and tool state remain in the session runtime. */
export class WorkbenchDetailsSelection {
  private readonly values = new Map<SessionId, SelectionTarget | null>()
  private readonly listeners = new Map<SessionId, Set<() => void>>()

  get(sessionId: SessionId): SelectionTarget | null {
    return this.values.get(sessionId) ?? null
  }

  set(sessionId: SessionId, target: SelectionTarget | null): void {
    if (this.get(sessionId) === target) return
    this.values.set(sessionId, target)
    for (const listener of this.listeners.get(sessionId) ?? []) listener()
  }

  subscribe(sessionId: SessionId, listener: () => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(sessionId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(sessionId)
    }
  }
}

interface WorkbenchToolDetailsProps extends TabComponentProps {
  selections: WorkbenchDetailsSelection
  sessions: ISessions
  sidebar: BetterSidebarService
  t: Translate
}

function WorkbenchToolDetails({
  scope, tab, selections, sessions, sidebar, t,
}: WorkbenchToolDetailsProps): ReactNode {
  const sessionId = scope.sessionId as SessionId
  const subscribeSelection = useCallback(
    (listener: () => void) => selections.subscribe(sessionId, listener),
    [sessionId, selections],
  )
  const getSelection = useCallback(
    () => selections.get(sessionId),
    [sessionId, selections],
  )
  const selection = useSyncExternalStore(subscribeSelection, getSelection, EMPTY_SELECTION)
  const session = sessions.binding(sessionId)?.session
  const subscribeSession = useCallback(
    (listener: () => void) => session?.subscribe(listener) ?? EMPTY_SUBSCRIBE(),
    [session],
  )
  const getSession = useCallback(
    () => session?.getSnapshot() ?? null,
    [session],
  )
  const snapshot = useSyncExternalStore(subscribeSession, getSession, EMPTY_SESSION)
  const callId = selection?.callId
  const material = snapshot === null || callId === undefined ? null : materialFor(snapshot, callId)

  return (
    <div className={css.root} data-workbench-tool-details>
      <div className={css.header}>
        <div className={css.title}>
          {selection === null ? t('details.title') : material?.name ?? selection.toolName ?? t('details.title')}
        </div>
        <button
          type="button" className={css.close} aria-label={t('details.close')}
          onClick={() => { sidebar.closeTab(tab.id, scope) }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className={css.body}>
        {selection === null || callId === undefined
          ? <div className={css.empty}>{t('details.empty')}</div>
          : material === null
            ? <div className={css.empty}>{t('details.notInWindow')}</div>
            : (
              <>
                {material.argsRaw !== null && (
                  <section className={css.section}>
                    <div className={css.sectionLabel}>{t('details.input')}</div>
                    <CodeBlock
                      code={pretty(material.argsRaw)}
                      lang="json"
                      copyLabel={t('details.copy')}
                      copiedLabel={t('details.copied')}
                    />
                  </section>
                )}
                <section className={css.section}>
                  <div className={css.sectionLabel}>{t('details.output')}</div>
                  {'kind' in material.block
                    ? (
                      <pre className={css.code} data-error={material.block.isError || undefined}>
                        {rawResultText(material.block)}
                      </pre>
                    )
                    : <div className={css.empty}>{t('details.running')}</div>}
                </section>
              </>
            )}
      </div>
    </div>
  )
}

export function registerWorkbenchToolDetails(
  sidebar: BetterSidebarService,
  sessions: ISessions,
  selections: WorkbenchDetailsSelection,
  t: Translate,
): () => void {
  return sidebar.registerTab({
    id: 'conversation-details',
    title: () => t('details.title'),
    icon: size => <IconDataOutline16 size={size} />,
    order: 5,
    single: true,
    component: props => (
      <WorkbenchToolDetails
        {...props}
        selections={selections}
        sessions={sessions}
        sidebar={sidebar}
        t={t}
      />
    ),
  })
}
