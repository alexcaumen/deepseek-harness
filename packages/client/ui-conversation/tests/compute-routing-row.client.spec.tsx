// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore, type SessionListState, type WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import {
  ComputeRoutingRow, LOCAL_COMPUTE_CONFIG_URL, resolveComputeConfigUrl,
  type ComputeRoutingResponse, type ComputeRoutingRowProps,
} from '../src/client/settings/ComputeRoutingRow.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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

const automatic: ComputeRoutingResponse = {
  mode: 'automatic',
  priority: ['r5300', 'prdg'],
  probeOrder: ['r5300', 'prdg'],
  selectedRoute: { id: 'prdg', state: 'ready', device: 'cuda' },
}

function response(payload: ComputeRoutingResponse) {
  return Promise.resolve(new Response(JSON.stringify(payload), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }))
}

function mount() {
  const props: ComputeRoutingRowProps = {
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    t: makeTranslate(en),
  }
  render(<ComputeRoutingRow {...props} />)
}

describe('compute routing URL', () => {
  it('uses the desktop speech port while preserving canonical route priority', () => {
    const desktop = { speechComputeConfigUrl: 'http://127.0.0.1:17402/v1/compute/config' }
    expect(resolveComputeConfigUrl({ __GIANA_DESKTOP__: desktop })).toBe(desktop.speechComputeConfigUrl)
    expect(resolveComputeConfigUrl({ __GIANA_DESKTOP__: desktop,
      __GIANA_WINDOWS_RUNTIME__: { routes: { 'speech.compute.config': '/owned/compute' } },
      location: { origin: 'https://gcp.test' },
    })).toBe('https://gcp.test/owned/compute')
    expect(resolveComputeConfigUrl({ __GIANA_DESKTOP__: { speechComputeConfigUrl: 'https://user:secret@example.test/config' } }))
      .toBe(LOCAL_COMPUTE_CONFIG_URL)
  })

  it('uses the loopback service and rejects credential-bearing overrides', () => {
    expect(resolveComputeConfigUrl({})).toBe(LOCAL_COMPUTE_CONFIG_URL)
    expect(resolveComputeConfigUrl({
      __GIANA_WINDOWS_RUNTIME__: { routes: { 'speech.compute.config': 'https://user:secret@example.test/config' } },
    })).toBe(LOCAL_COMPUTE_CONFIG_URL)
  })
})

describe('ComputeRoutingRow', () => {
  it('fetches the injected desktop compute endpoint', async () => {
    const endpoint = 'http://127.0.0.1:17402/v1/compute/config'
    vi.stubGlobal('__GIANA_DESKTOP__', { speechComputeConfigUrl: endpoint })
    const fetchMock = vi.fn(() => response(automatic))
    vi.stubGlobal('fetch', fetchMock)
    mount()
    await screen.findByText('Using PRDG · cuda · ready')
    expect(fetchMock).toHaveBeenCalledWith(endpoint)
  })

  it('loads honest selected route status', async () => {
    vi.stubGlobal('fetch', vi.fn(() => response(automatic)))
    mount()
    expect(await screen.findByText('Using PRDG · cuda · ready')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Automatic' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('restores Automatic instead of persisting an unavailable forced R5300 route', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => response(automatic))
      .mockImplementationOnce(() => response({
        ...automatic,
        mode: 'r5300',
        probeOrder: ['r5300'],
        selectedRoute: { id: 'r5300', state: 'unavailable', device: 'unknown' },
      }))
      .mockImplementationOnce(() => response(automatic))
    vi.stubGlobal('fetch', fetchMock)
    mount()
    await screen.findByText('Using PRDG · cuda · ready')
    fireEvent.click(screen.getByRole('button', { name: 'R5300' }))
    expect((await screen.findByRole('alert')).textContent).toBe('R5300 is unavailable; Automatic routing was restored.')
    expect(screen.getByRole('button', { name: 'Automatic' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'R5300' }).hasAttribute('disabled')).toBe(true)
    expect(fetchMock).toHaveBeenNthCalledWith(2, LOCAL_COMPUTE_CONFIG_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'r5300' }),
    })
    expect(fetchMock).toHaveBeenNthCalledWith(3, LOCAL_COMPUTE_CONFIG_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'automatic' }),
    })
  })

  it('keeps an explicit R5300 route when the service confirms readiness', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => response(automatic))
      .mockImplementationOnce(() => response({
        ...automatic,
        mode: 'r5300',
        probeOrder: ['r5300'],
        selectedRoute: { id: 'r5300', state: 'ready', device: 'cuda' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    mount()
    await screen.findByText('Using PRDG · cuda · ready')
    fireEvent.click(screen.getByRole('button', { name: 'R5300' }))
    expect(await screen.findByText('Using R5300 · cuda · ready')).toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('surfaces service failures without claiming readiness', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    mount()
    expect((await screen.findByRole('alert')).textContent).toBe('Compute routing unavailable: offline')
  })
})
