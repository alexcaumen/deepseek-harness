// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginInventorySettingsTab } from '../src/client/PluginInventorySettingsTab.tsx'
import type {
  PluginInventorySettingsTabInjected,
  PluginInventorySettingsTabProps,
} from '../src/client/PluginInventorySettingsTab.tsx'
import { en, type PluginInventoryLocaleKey } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type Snapshot = Awaited<ReturnType<PluginInventorySettingsTabInjected['list']>>
type CatalogView = 'skills' | 'connectors' | 'marketplace'

const t = ((key: PluginInventoryLocaleKey): string => en[key]) as PluginInventorySettingsTabProps['t']

function props(list: PluginInventorySettingsTabInjected['list']): PluginInventorySettingsTabProps {
  return { t, list } as PluginInventorySettingsTabProps
}

const SNAPSHOT = {
  entries: [
    { entryId: 'slack-entry', moduleName: '@fixture/slack-connector', enabled: true, fiberPhase: 'active' },
    { entryId: 'office-entry', moduleName: '@fixture/office-documents', enabled: false, fiberPhase: null },
    { entryId: 'hmr-entry', moduleName: '@deepseek-ai/cordis-plugin-hmr', enabled: true, fiberPhase: 'active' },
    { entryId: 'session-entry', moduleName: '@deepseek-ai/dsh-session-projection', enabled: true, fiberPhase: 'pending' },
  ],
} as unknown as Snapshot

const CATALOG_PATHS = {
  skills: '/giana-catalogs/skills.json',
  connectors: '/giana-catalogs/connectors.json',
  marketplace: '/giana-catalogs/marketplace.json',
} as const

function catalog(view: CatalogView, count: number): unknown {
  const entries = Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(3, '0')
    if (view === 'skills') {
      return {
        id: `skill-${number}`,
        title: `Skill ${number}`,
        description: `Source-backed skill ${number}`,
        category: index % 2 === 0 ? 'engineering' : 'data-analytics',
        status: index % 2 === 0 ? 'READY_HISTORICAL_INVENTORY' : 'PENDING_RUNTIME_OR_CONNECTOR',
        provenance: { sourceFamily: index % 2 === 0 ? 'giana-codex-local' : 'openai-curated-remote' },
      }
    }
    if (view === 'connectors') {
      return {
        id: `service-${number}`,
        title: `Provider ${number}`,
        categories: ['Productivity'],
        authTypes: ['api_key'],
        actionCount: index + 1,
        status: 'DISCOVERABLE_NOT_CONNECTED_BY_DEFAULT',
        homepageUrl: index === 0 ? 'https://example.com/' : null,
        provenance: { service: `service-${number}` },
      }
    }
    return {
      id: `owner/item-${number}`,
      title: `Marketplace item ${number}`,
      description: `Unverified candidate ${number}`,
      type: index % 2 === 0 ? 'cordis-plugin' : 'skill',
      owner: 'owner',
      language: 'TypeScript',
      tags: ['catalog-test'],
      stars: index,
      installMethod: 'pnpm-profile',
      needsConfig: index === 0,
      status: 'DISCOVERABLE_UNVERIFIED',
      homepageUrl: null,
      updatedAt: '2026-08-22T10:00:00Z',
      provenance: { sources: ['topic'], lastCheckedAt: '2026-08-22T23:22:26.947Z' },
    }
  })
  const status = view === 'skills'
    ? {
      code: 'MIXED_HISTORICAL_EVIDENCE',
      label: 'Historical evidence and runtime pending',
      detail: 'Historical inventory evidence does not assert current runtime readiness.',
    }
    : view === 'connectors'
      ? {
        code: 'DISCOVERABLE_NOT_CONNECTED_BY_DEFAULT',
        label: 'Discoverable, not connected',
        detail: 'Catalog presence does not imply authentication, connection, installation, or runtime readiness.',
      }
      : {
        code: 'DISCOVERABLE_UNVERIFIED',
        label: 'Discoverable, unverified',
        detail: 'Marketplace discovery does not imply curation, trust, installation, or runtime readiness.',
      }
  return {
    schema: `giana.browser.${view}-catalog.v1`,
    catalog: view,
    generatedAt: '2026-08-23T08:00:00Z',
    status,
    currentness: { asOf: '2026-08-23T05:07:19Z', basis: 'Source inventory generation time' },
    provenance: {
      name: `GIANA_WINDOWS_${view.toUpperCase()}_INVENTORY_20260823.json`,
      schema: `source.${view}.v1`,
      generatedAt: '2026-08-23T05:07:19Z',
      mode: 'PLANNING_ONLY_NO_EXECUTION',
      sha256: 'abc123',
    },
    counts: { total: count, ...(view === 'connectors' ? { actions: count * 2 } : {}) },
    entries,
  }
}

function response(value: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 503, json: async () => value } as Response
}

function catalogFetch(counts: Partial<Record<CatalogView, number>> = {}): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const selected = (Object.keys(CATALOG_PATHS) as CatalogView[])
      .find(view => CATALOG_PATHS[view] === path)
    if (selected === undefined) return response(null, false)
    return response(catalog(selected, counts[selected] ?? 3))
  })
}

function summaryCount(container: HTMLElement, name: string): string | null | undefined {
  return container.querySelector(`[data-summary-count="${name}"]`)?.textContent
}

describe('PluginInventorySettingsTab', () => {
  it('renders aggregate counts and the public feature catalog without fetching a source catalog', async () => {
    const deferred = Promise.withResolvers<Snapshot>()
    const list = vi.fn(() => deferred.promise)
    const fetchMock = catalogFetch()
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<PluginInventorySettingsTab {...props(list)} />)

    expect(summaryCount(view.container, 'features')).toBe('96')
    expect(summaryCount(view.container, 'skills')).toBe('\u2014')
    expect(summaryCount(view.container, 'providers')).toBe('\u2014')
    expect(summaryCount(view.container, 'actions')).toBe('\u2014')
    expect(view.container.querySelectorAll('[data-feature-category]')).toHaveLength(12)
    expect(view.container.querySelectorAll('[data-feature-id]')).toHaveLength(96)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByText(en.loading)).toBeNull()
    expect(screen.queryByText('Hmr')).toBeNull()

    await act(async () => { deferred.resolve(SNAPSHOT) })
    await waitFor(() => { expect(list).toHaveBeenCalledOnce() })
    expect(screen.getByRole('button', { name: en.systemView }).textContent).toContain('2')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('searches human-facing features without leaking Loader fields', () => {
    const view = render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT)} />)
    const search = screen.getByRole('searchbox', { name: en.search })

    fireEvent.change(search, { target: { value: 'Qwen' } })
    expect(view.container.querySelectorAll('[data-feature-id]')).toHaveLength(1)
    expect(screen.getByText('Qwen and Alibaba Open Models')).toBeTruthy()
    expect(screen.getByText(en.catalogClaim)).toBeTruthy()

    fireEvent.change(search, { target: { value: 'office-entry' } })
    expect(view.container.querySelectorAll('[data-feature-id]')).toHaveLength(0)
    expect(screen.getByText(en.emptySearch)).toBeTruthy()
  })

  it('lazy-fetches only selected catalogs and reuses each loaded catalog', async () => {
    const fetchMock = catalogFetch()
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT)} />)

    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.skillsView }))
    await waitFor(() => { expect(view.container.querySelector('[data-catalog-view="skills"]')).toBeTruthy() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CATALOG_PATHS.skills)
    expect(view.container.querySelector('[data-catalog-entry="skill-001"]')).toBeTruthy()
    expect(screen.getAllByText(en.catalogClaim).length).toBeGreaterThan(0)
    expect(screen.queryByText('Historical runtime evidence')).toBeNull()
    expect(screen.queryByText('Needs runtime or connector')).toBeNull()
    expect(view.container.querySelector('[data-catalog-entry-status]')).toBeNull()
    expect(view.container.querySelectorAll('[data-catalog-entry-claim="discoverable"]')).toHaveLength(3)
    expect(summaryCount(view.container, 'skills')).toBe('3')

    fireEvent.click(screen.getByRole('button', { name: en.connectorsView }))
    await waitFor(() => { expect(view.container.querySelector('[data-catalog-view="connectors"]')).toBeTruthy() })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toBe(CATALOG_PATHS.connectors)
    expect(screen.queryByText('Discoverable, not connected')).toBeNull()
    expect(screen.getAllByText(en.catalogClaim).length).toBeGreaterThan(0)
    expect(summaryCount(view.container, 'providers')).toBe('3')
    expect(summaryCount(view.container, 'actions')).toBe('6')

    fireEvent.click(screen.getByRole('button', { name: en.skillsView }))
    expect(view.container.querySelector('[data-catalog-entry="skill-001"]')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: en.marketplaceView }))
    await waitFor(() => { expect(view.container.querySelector('[data-catalog-view="marketplace"]')).toBeTruthy() })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[2]?.[0]).toBe(CATALOG_PATHS.marketplace)
    expect(screen.queryByText('Discoverable, unverified')).toBeNull()
    expect(screen.getAllByText(en.catalogClaim).length).toBeGreaterThan(0)
    expect(view.container.querySelector('[data-entry-provenance]')?.textContent).toContain('topic')
  })

  it('never elevates catalog-only claims from source labels or a matching mounted module', async () => {
    const source = catalog('skills', 1) as {
      status: { code: string; label: string; detail: string }
      entries: Array<{ status: string }>
    }
    source.status.code = 'READY'
    source.status.label = 'READY'
    source.entries[0]!.status = 'CALLABLE'
    const snapshot = {
      entries: [{
        entryId: 'browser-computer-use',
        moduleName: '@fixture/browser-computer-use',
        enabled: true,
        fiberPhase: 'active',
      }],
    } as unknown as Snapshot
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response(source)))
    const view = render(<PluginInventorySettingsTab {...props(async () => snapshot)} />)

    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: 'Browser Computer Use' } })
    const feature = view.container.querySelector('[data-feature-claim="discoverable"]')
    expect(feature).toBeTruthy()
    expect(feature?.textContent).toContain(en.catalogClaim)
    expect(feature?.textContent).not.toMatch(/ready|callable/i)

    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: en.skillsView }))
    await waitFor(() => { expect(view.container.querySelector('[data-catalog-entry="skill-001"]')).toBeTruthy() })
    const catalogEntry = view.container.querySelector('[data-catalog-entry="skill-001"]')
    expect(catalogEntry?.getAttribute('data-catalog-entry-claim')).toBe('discoverable')
    expect(catalogEntry?.textContent).toContain(en.catalogClaim)
    expect(catalogEntry?.textContent).not.toMatch(/ready|callable/i)
  })

  it('bounds rendering, loads more by page, and searches the full selected catalog', async () => {
    const fetchMock = catalogFetch({ skills: 121 })
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT)} />)
    fireEvent.click(screen.getByRole('button', { name: en.skillsView }))

    await waitFor(() => { expect(view.container.querySelectorAll('[data-catalog-entry]')).toHaveLength(50) })
    expect(view.container.querySelector('[data-catalog-result-count="121"]')?.textContent).toContain('50 of 121')
    fireEvent.click(view.container.querySelector('[data-load-more="skills"]') as HTMLButtonElement)
    expect(view.container.querySelectorAll('[data-catalog-entry]')).toHaveLength(100)

    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: 'Skill 121' } })
    expect(view.container.querySelectorAll('[data-catalog-entry]')).toHaveLength(1)
    expect(view.container.querySelector('[data-catalog-entry="skill-121"]')).toBeTruthy()
    expect(view.container.querySelector('[data-load-more="skills"]')).toBeNull()

    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: '' } })
    expect(view.container.querySelectorAll('[data-catalog-entry]')).toHaveLength(50)
  })

  it('shows catalog currentness and source provenance', async () => {
    vi.stubGlobal('fetch', catalogFetch())
    const view = render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT)} />)
    fireEvent.click(screen.getByRole('button', { name: en.skillsView }))

    await waitFor(() => { expect(view.container.querySelector('[data-catalog-view="skills"]')).toBeTruthy() })
    expect(screen.queryByText('Historical evidence and runtime pending')).toBeNull()
    expect(view.container.querySelector('time[datetime="2026-08-23T05:07:19Z"]')).toBeTruthy()
    expect(screen.getByText('GIANA_WINDOWS_SKILLS_INVENTORY_20260823.json')).toBeTruthy()
    expect(screen.getByText(
      'Source qualification: Historical inventory evidence does not assert current runtime readiness.',
    )).toBeTruthy()
  })

  it('contains a selected catalog failure and retries only that catalog', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(null, false))
      .mockResolvedValueOnce(response(catalog('skills', 2)))
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT)} />)

    fireEvent.click(screen.getByRole('button', { name: en.skillsView }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(view.container.querySelectorAll('[data-catalog-entry]')).toHaveLength(2) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every(call => call[0] === CATALOG_PATHS.skills)).toBe(true)
  })

  it('keeps HMR and session plumbing behind System internals', async () => {
    const view = render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT)} />)
    const system = screen.getByRole('button', { name: en.systemView })

    expect(screen.queryByText('Hmr')).toBeNull()
    fireEvent.click(system)
    await waitFor(() => { expect(view.container.querySelectorAll('[data-plugin-entry]')).toHaveLength(2) })
    const hmrEntry = view.container.querySelector('[data-plugin-entry="hmr-entry"]')
    expect(hmrEntry).toBeTruthy()
    expect(hmrEntry?.getAttribute('data-live-evidence')).toBe('pluginInventory.list')
    expect(hmrEntry?.getAttribute('data-loader-status')).toBe('mounted')
    expect(view.container.querySelector('[data-plugin-entry="session-entry"]')).toBeTruthy()
    expect(view.container.querySelector('[data-plugin-entry="slack-entry"]')).toBeNull()

    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: 'hmr-entry' } })
    expect(view.container.querySelectorAll('[data-plugin-entry]')).toHaveLength(1)
    const disclosure = view.container.querySelector('[data-plugin-entry="hmr-entry"] button') as HTMLButtonElement
    fireEvent.click(disclosure)
    expect(view.container.querySelector('[data-module-name]')?.textContent).toBe('@deepseek-ai/cordis-plugin-hmr')
    expect(view.container.querySelector('[data-loader-entry]')?.textContent).toBe('hmr-entry')
    expect(screen.getAllByText(en.active)).toHaveLength(2)
  })

  it('contains Remote failures inside System internals and retries', async () => {
    const list = vi.fn<PluginInventorySettingsTabInjected['list']>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce({ entries: [] })
    render(<PluginInventorySettingsTab {...props(list)} />)

    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.systemView }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    expect(screen.queryByText('private transport detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
    expect(await screen.findByText(en.empty)).toBeTruthy()
  })

  it('contains synchronous failures and ignores late results after unmount', async () => {
    const syncFailure = vi.fn(() => { throw new Error('namespace unavailable') }) as PluginInventorySettingsTabInjected['list']
    const failed = render(<PluginInventorySettingsTab {...props(syncFailure)} />)
    fireEvent.click(screen.getByRole('button', { name: en.systemView }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    failed.unmount()

    const deferred = Promise.withResolvers<Snapshot>()
    const pending = render(<PluginInventorySettingsTab {...props(() => deferred.promise)} />)
    pending.unmount()
    await act(async () => { deferred.resolve(SNAPSHOT) })

    const deferredFailure = Promise.withResolvers<Snapshot>()
    const pendingFailure = render(<PluginInventorySettingsTab {...props(() => deferredFailure.promise)} />)
    pendingFailure.unmount()
    await act(async () => { deferredFailure.reject(new Error('late failure')) })
  })
})
