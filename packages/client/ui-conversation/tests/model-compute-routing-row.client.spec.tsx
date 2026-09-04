// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import {
  createSnapshotStore, type SessionListState, type SettingsScope,
  type SettingsScopeSnapshot, type WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { ModelComputeRoutingRow, type ModelComputeRoutingRowProps } from '../src/client/settings/ModelComputeRoutingRow.tsx'
import type { ModelLifecycleSettings } from '../src/client/model-compute-settings.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function emptySessions() {
  return bindSnapshotSelector(createSnapshotStore<SessionListState>({
    ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }))
}

function emptyWorkspaces() {
  return bindSnapshotSelector(createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  }))
}

function settingsScope(preference: ModelLifecycleSettings['preference'], writable = true) {
  let snapshot: SettingsScopeSnapshot<ModelLifecycleSettings> = {
    status: 'ready', value: { preference }, base: { preference: 'automatic' }, user: {},
    revision: 1, writable, mode: 'host',
  }
  const listeners = new Set<() => void>()
  const set = vi.fn(async (field: string, value: unknown) => {
    snapshot = {
      ...snapshot,
      value: { preference: value as ModelLifecycleSettings['preference'] },
      user: { [field]: value },
      revision: (snapshot.revision ?? 0) + 1,
    }
    for (const listener of listeners) listener()
  })
  const scope: SettingsScope<ModelLifecycleSettings> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set,
    unset: vi.fn(async () => {}),
  }
  return { scope, set }
}

function mount(settings: SettingsScope<ModelLifecycleSettings>) {
  const props: ModelComputeRoutingRowProps = {
    useSessions: emptySessions(), useWorkspaces: emptyWorkspaces(), t: makeTranslate(en), settings,
  }
  render(<ModelComputeRoutingRow {...props} />)
}

describe('ModelComputeRoutingRow', () => {
  it('supports Host scopes whose methods require their instance receiver', () => {
    const host = settingsScope('automatic')
    class ReceiverBoundScope implements SettingsScope<ModelLifecycleSettings> {
      constructor(private readonly target: SettingsScope<ModelLifecycleSettings>) {}
      getSnapshot() { return this.target.getSnapshot() }
      subscribe(listener: () => void) { return this.target.subscribe(listener) }
      set(field: string, value: unknown) { return this.target.set(field, value) }
      unset(field: string) { return this.target.unset(field) }
    }

    mount(new ReceiverBoundScope(host.scope))
    expect(screen.getByRole('button', { name: 'Automatic' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('persists a manual target without claiming that target is already active', async () => {
    const host = settingsScope('automatic')
    mount(host.scope)
    fireEvent.click(screen.getByRole('button', { name: 'R5300' }))
    await vi.waitFor(() => { expect(host.set).toHaveBeenCalledWith('preference', 'r5300') })
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: 'R5300' }).getAttribute('aria-pressed')).toBe('true')
      expect(screen.getByText(/resource preflight will decide the actual target/i)).toBeDefined()
    })
  })

  it('explains automatic order and disables writes in a read-only deployment', () => {
    const host = settingsScope('automatic', false)
    mount(host.scope)
    expect(screen.getByText(/R5300, then PRDG, then RAM\/CPU/i)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Automatic' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/Preference is read-only/i)).toBeDefined()
  })

  it('reports a recovered or rejected write without exposing private Host errors', async () => {
    const recovered = settingsScope('automatic')
    recovered.scope.set = vi.fn(async () => {})
    mount(recovered.scope)
    fireEvent.click(screen.getByRole('button', { name: 'R5300' }))
    await vi.waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/could not save model routing preference/i)
      expect(screen.getByRole('button', { name: 'Automatic' }).getAttribute('aria-pressed')).toBe('true')
    })
    cleanup()

    const rejected = settingsScope('automatic')
    rejected.scope.set = vi.fn(async () => { throw new Error('private-host-path N:\\secret') })
    mount(rejected.scope)
    fireEvent.click(screen.getByRole('button', { name: 'PRDG' }))
    await vi.waitFor(() => {
      expect(screen.getByRole('alert').textContent).not.toContain('private-host-path')
      expect(screen.getByRole('alert').textContent).not.toContain('N:\\secret')
    })
  })
})
