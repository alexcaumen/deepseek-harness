import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { IconChevronDownOutline14, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { capabilityStatus, capabilityTitle, inferCapabilityCategory } from './inventoryPresentation.ts'
import type { PluginInventoryLocaleKey } from './locales.ts'
import {
  PUBLIC_FEATURES,
  PUBLIC_FEATURE_CATEGORIES,
  type PublicFeature,
  type PublicFeatureCategory,
  type PublicFeatureState,
} from './publicFeatureCatalog.ts'
import css from './PluginInventorySettingsTab.module.css'

export interface PluginInventorySettingsTabInjected {
  /** Read the current Host inventory for the admin-only internals view. */
  list: () => Promise<PluginInventorySnapshot>
}

type PluginInventoryEntry = PluginInventorySnapshot['entries'][number]
type PluginFiberPhase = PluginInventoryEntry['fiberPhase']
type InventoryView = 'features' | 'skills' | 'connectors' | 'marketplace' | 'system-internals'
type CatalogView = Extract<InventoryView, 'skills' | 'connectors' | 'marketplace'>

export type PluginInventorySettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<PluginInventorySettingsTabInjected>

type InventoryState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: PluginInventorySnapshot }

interface BrowserCatalogEntry {
  readonly id: string
  readonly title: string
  readonly description?: string | null
  readonly status: string
  readonly category?: string
  readonly categories?: readonly string[]
  readonly authTypes?: readonly string[]
  readonly actionCount?: number
  readonly type?: string
  readonly owner?: string
  readonly language?: string | null
  readonly tags?: readonly string[]
  readonly stars?: number
  readonly installMethod?: string
  readonly needsConfig?: boolean
  readonly homepageUrl?: string | null
  readonly updatedAt?: string
  readonly provenance: {
    readonly sourceFamily?: string
    readonly service?: string
    readonly sources?: readonly string[]
    readonly lastCheckedAt?: string
  }
}

interface BrowserCatalog {
  readonly schema: string
  readonly catalog: CatalogView
  readonly generatedAt: string
  readonly status: { readonly code: string; readonly label: string; readonly detail: string }
  readonly currentness: { readonly asOf: string; readonly basis: string }
  readonly provenance: {
    readonly name: string
    readonly schema: string
    readonly generatedAt: string | null
    readonly mode: string
    readonly sha256: string
  }
  readonly counts: Readonly<Record<string, number>> & { readonly total: number }
  readonly entries: readonly BrowserCatalogEntry[]
}

type CatalogState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly catalog: BrowserCatalog }

const PHASE_KEYS = {
  pending: 'pending', loading: 'loadingPhase', active: 'active', failed: 'failed', unloading: 'unloading',
} satisfies Record<Exclude<PluginFiberPhase, null>, PluginInventoryLocaleKey>

const STATE_KEYS = {
  DISCOVERABLE: 'stateDiscoverable', INSTALLED: 'stateInstalled', REGISTERED: 'stateRegistered',
  ENABLED: 'stateEnabled', NEEDS_SIGN_IN: 'stateNeedsSignIn', NEEDS_RUNTIME: 'stateNeedsRuntime',
  READY: 'stateReady', DEGRADED: 'stateDegraded', FAILED: 'stateFailed', HELD: 'stateHeld',
} satisfies Record<PublicFeatureState, PluginInventoryLocaleKey>

const CATEGORY_KEYS = {
  'communication-collaboration': 'categoryCommunicationCollaboration',
  'productivity-office': 'categoryProductivityOffice',
  'engineering-industrial': 'categoryEngineeringIndustrial',
  'data-science-analytics': 'categoryDataScienceAnalytics',
  finance: 'categoryFinance',
  'business-operations': 'categoryBusinessOperations',
  'developer-automation': 'categoryDeveloperAutomation',
  'creative-media': 'categoryCreativeMedia',
  'research-knowledge': 'categoryResearchKnowledge',
  'infrastructure-ai-compute': 'categoryInfrastructureAiCompute',
  'models-providers': 'categoryModelsProviders',
  'security-governance': 'categorySecurityGovernance',
} satisfies Record<PublicFeatureCategory, PluginInventoryLocaleKey>

const VIEW_KEYS = {
  features: 'featuresView', skills: 'skillsView', connectors: 'connectorsView',
  marketplace: 'marketplaceView', 'system-internals': 'systemView',
} satisfies Record<InventoryView, PluginInventoryLocaleKey>

const CATALOG_URLS = {
  skills: '/giana-catalogs/skills.json',
  connectors: '/giana-catalogs/connectors.json',
  marketplace: '/giana-catalogs/marketplace.json',
} satisfies Record<CatalogView, string>

const PAGE_SIZE = 50

function formatInventoryCount(value: number | null): string {
  return value === null ? '\u2014' : value.toLocaleString()
}

function initialCatalogStates(): Record<CatalogView, CatalogState> {
  return {
    skills: { status: 'idle' },
    connectors: { status: 'idle' },
    marketplace: { status: 'idle' },
  }
}

function initialVisibleLimits(): Record<CatalogView, number> {
  return { skills: PAGE_SIZE, connectors: PAGE_SIZE, marketplace: PAGE_SIZE }
}

function isCatalogView(view: InventoryView): view is CatalogView {
  return view === 'skills' || view === 'connectors' || view === 'marketplace'
}

function isBrowserCatalog(value: unknown, expected: CatalogView): value is BrowserCatalog {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<BrowserCatalog>
  return candidate.catalog === expected
    && typeof candidate.schema === 'string'
    && candidate.status !== undefined
    && typeof candidate.status.code === 'string'
    && typeof candidate.status.label === 'string'
    && candidate.currentness !== undefined
    && typeof candidate.currentness.asOf === 'string'
    && candidate.provenance !== undefined
    && typeof candidate.provenance.name === 'string'
    && candidate.counts !== undefined
    && typeof candidate.counts.total === 'number'
    && Array.isArray(candidate.entries)
    && candidate.entries.every(entry => (
      entry !== null && typeof entry === 'object'
      && typeof entry.id === 'string' && typeof entry.title === 'string'
      && typeof entry.status === 'string' && entry.provenance !== null
      && typeof entry.provenance === 'object'
    ))
}

function phaseLabel(phase: PluginFiberPhase, t: PluginInventorySettingsTabProps['t']): string {
  return phase === null ? t('unobserved') : t(PHASE_KEYS[phase])
}

function featureMatches(feature: PublicFeature, query: string, t: PluginInventorySettingsTabProps['t']): boolean {
  if (query.length === 0) return true
  return [feature.title, t(CATEGORY_KEYS[feature.category]), t(STATE_KEYS[feature.state]), feature.detail]
    .some(value => value.toLocaleLowerCase().includes(query))
}

function catalogEntryMatches(entry: BrowserCatalogEntry, query: string): boolean {
  if (query.length === 0) return true
  const values = [
    entry.id, entry.title, entry.description, entry.status, entry.category, entry.type, entry.owner,
    entry.language, entry.installMethod, entry.provenance.sourceFamily, entry.provenance.service,
    ...(entry.categories ?? []), ...(entry.authTypes ?? []), ...(entry.tags ?? []),
    ...(entry.provenance.sources ?? []),
  ]
  return values.some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(query))
}

function catalogStatusLabel(status: string): string {
  if (status === 'READY_HISTORICAL_INVENTORY') return 'Historical runtime evidence'
  if (status === 'PENDING_RUNTIME_OR_CONNECTOR') return 'Needs runtime or connector'
  if (status === 'DISCOVERABLE_NOT_CONNECTED_BY_DEFAULT') return 'Discoverable, not connected'
  if (status === 'DISCOVERABLE_UNVERIFIED') return 'Discoverable, unverified'
  return status
}

function formatCatalogDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function CatalogFacts({ entry, view }: {
  readonly entry: BrowserCatalogEntry
  readonly view: CatalogView
}): ReactNode {
  if (view === 'skills') {
    return (
      <div className={css.catalogFacts}>
        {entry.category ? <span>{entry.category}</span> : null}
        {entry.provenance.sourceFamily ? <span>Source family: {entry.provenance.sourceFamily}</span> : null}
      </div>
    )
  }
  if (view === 'connectors') {
    return (
      <div className={css.catalogFacts}>
        <span>{entry.actionCount?.toLocaleString() ?? 0} actions</span>
        {(entry.categories ?? []).map(category => <span key={category}>{category}</span>)}
        {(entry.authTypes ?? []).map(authType => <span key={authType}>{authType}</span>)}
        <span>Service: {entry.provenance.service ?? entry.id}</span>
      </div>
    )
  }
  return (
    <div className={css.catalogFacts}>
      {entry.owner ? <span>Owner: {entry.owner}</span> : null}
      {entry.type ? <span>{entry.type}</span> : null}
      {entry.language ? <span>{entry.language}</span> : null}
      {typeof entry.stars === 'number' ? <span>{entry.stars.toLocaleString()} stars</span> : null}
      {entry.needsConfig ? <span>Configuration required</span> : null}
    </div>
  )
}

function CatalogBrowser({ state, view, query, visibleLimit, onLoadMore, onRetry, t }: {
  readonly state: CatalogState
  readonly view: CatalogView
  readonly query: string
  readonly visibleLimit: number
  readonly onLoadMore: () => void
  readonly onRetry: () => void
  readonly t: PluginInventorySettingsTabProps['t']
}): ReactNode {
  if (state.status === 'idle' || state.status === 'loading') {
    return <p className={css.status} data-catalog-loading={view}>{t('loading')}</p>
  }
  if (state.status === 'error') {
    return (
      <div className={css.failure} data-catalog-error={view}>
        <p role="alert">{t('error')}</p><button type="button" onClick={onRetry}>{t('retry')}</button>
      </div>
    )
  }

  const catalog = state.catalog
  const filteredEntries = catalog.entries.filter(entry => catalogEntryMatches(entry, query))
  const visibleEntries = filteredEntries.slice(0, visibleLimit)
  const remaining = filteredEntries.length - visibleEntries.length

  return (
    <section className={css.category} data-catalog-view={view}>
      <div className={css.categoryHeading}>
        <h4>{t(VIEW_KEYS[view])}</h4><span>{catalog.counts.total.toLocaleString()}</span>
      </div>
      <div className={css.catalogEvidence}>
        <span className={css.statusTag} data-catalog-status={catalog.status.code}>{catalog.status.label}</span>
        <span>As of <time dateTime={catalog.currentness.asOf}>{formatCatalogDate(catalog.currentness.asOf)}</time></span>
        <span>Source: <code>{catalog.provenance.name}</code></span>
      </div>
      <p className={css.catalogQualification}>{catalog.status.detail}</p>
      {filteredEntries.length === 0 ? <p className={css.status}>{t('emptySearch')}</p> : null}
      {visibleEntries.length > 0 ? (
        <>
          <div className={css.resultMeta} data-catalog-result-count={filteredEntries.length}>
            Showing {visibleEntries.length.toLocaleString()} of {filteredEntries.length.toLocaleString()}
          </div>
          <ul className={css.catalogCards} aria-label={t(VIEW_KEYS[view])}>
            {visibleEntries.map(entry => (
              <li className={css.catalogCard} key={entry.id} data-catalog-entry={entry.id} data-catalog-entry-status={entry.status}>
                <div className={css.catalogItemHeading}>
                  <strong>{entry.title}</strong>
                  <span className={css.statusTag} data-catalog-status={entry.status}>{catalogStatusLabel(entry.status)}</span>
                </div>
                {entry.description ? <p>{entry.description}</p> : null}
                <CatalogFacts entry={entry} view={view} />
                {view === 'marketplace' && entry.provenance.lastCheckedAt ? (
                  <div className={css.catalogProvenance} data-entry-provenance>
                    <span>
                      Checked <time dateTime={entry.provenance.lastCheckedAt}>
                        {formatCatalogDate(entry.provenance.lastCheckedAt)}
                      </time>
                    </span>
                    <span>Sources: {(entry.provenance.sources ?? []).join(', ')}</span>
                  </div>
                ) : null}
                {entry.homepageUrl ? <a className={css.catalogLink} href={entry.homepageUrl} target="_blank" rel="noreferrer">Homepage</a> : null}
              </li>
            ))}
          </ul>
          {remaining > 0 ? (
            <button className={css.loadMore} type="button" data-load-more={view} onClick={onLoadMore}>
              Load more <span>{remaining.toLocaleString()} remaining</span>
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

export function PluginInventorySettingsTab({ list, t }: PluginInventorySettingsTabProps): ReactNode {
  const catalogId = useId()
  const mounted = useRef(true)
  const catalogControllers = useRef<Record<CatalogView, AbortController | undefined>>({
    skills: undefined,
    connectors: undefined,
    marketplace: undefined,
  })
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<InventoryView>('features')
  const [expandedFeature, setExpandedFeature] = useState<number | null>(null)
  const [expandedInternal, setExpandedInternal] = useState<string | null>(null)
  const [inventoryState, setInventoryState] = useState<InventoryState>({ status: 'loading' })
  const [catalogStates, setCatalogStates] = useState(initialCatalogStates)
  const [visibleLimits, setVisibleLimits] = useState(initialVisibleLimits)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      Object.values(catalogControllers.current).forEach((controller) => { controller?.abort() })
    }
  }, [])

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => list()).then(
      (snapshot) => { if (current) setInventoryState({ status: 'ready', snapshot }) },
      () => { if (current) setInventoryState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [list, request])

  useEffect(() => {
    if (!isCatalogView(view) || catalogStates[view].status !== 'idle') return
    const requestedView = view
    const controller = new AbortController()
    catalogControllers.current[requestedView] = controller
    setCatalogStates(current => ({ ...current, [requestedView]: { status: 'loading' } }))
    void fetch(CATALOG_URLS[requestedView], { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Catalog request failed with ${response.status}`)
      const value: unknown = await response.json()
      if (!isBrowserCatalog(value, requestedView)) throw new Error('Catalog response did not match its public schema')
      if (mounted.current) {
        setCatalogStates(current => ({ ...current, [requestedView]: { status: 'ready', catalog: value } }))
      }
    }).catch(() => {
      if (!controller.signal.aborted && mounted.current) {
        setCatalogStates(current => ({ ...current, [requestedView]: { status: 'error' } }))
      }
    }).finally(() => {
      if (catalogControllers.current[requestedView] === controller) {
        catalogControllers.current[requestedView] = undefined
      }
    })
  }, [catalogStates, view])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredFeatures = useMemo(
    () => PUBLIC_FEATURES.filter(feature => featureMatches(feature, normalizedQuery, t)),
    [normalizedQuery, t],
  )
  const featureGroups = useMemo(
    () => PUBLIC_FEATURE_CATEGORIES.map(category => ({
      category,
      features: filteredFeatures.filter(feature => feature.category === category),
    })).filter(group => group.features.length > 0),
    [filteredFeatures],
  )
  const internalEntries = useMemo(() => inventoryState.status === 'ready'
    ? inventoryState.snapshot.entries.map(entry => ({
      entry,
      category: inferCapabilityCategory(entry.moduleName, entry.entryId),
      status: capabilityStatus(entry),
      title: capabilityTitle(entry.moduleName),
    })).filter(({ entry, category, title, status }) => (
      category === 'system-internals'
      && (normalizedQuery.length === 0 || [entry.moduleName, entry.entryId, title, status]
        .some(value => value.toLocaleLowerCase().includes(normalizedQuery)))
    ))
    : [], [inventoryState, normalizedQuery])

  const readyCount = PUBLIC_FEATURES.filter(feature => feature.runtimeState === 'READY').length
  const attentionCount = PUBLIC_FEATURES.filter(feature => (
    feature.runtimeState === 'NEEDS_SIGN_IN' || feature.runtimeState === 'NEEDS_RUNTIME'
    || feature.runtimeState === 'DEGRADED' || feature.runtimeState === 'FAILED' || feature.runtimeState === 'HELD'
  )).length
  const internalCount = inventoryState.status === 'ready'
    ? inventoryState.snapshot.entries.filter(entry => (
      inferCapabilityCategory(entry.moduleName, entry.entryId) === 'system-internals'
    )).length
    : 0
  const busy = isCatalogView(view)
    ? catalogStates[view].status === 'idle' || catalogStates[view].status === 'loading'
    : view === 'system-internals' && inventoryState.status === 'loading'
  const retryInventory = (): void => {
    setInventoryState({ status: 'loading' })
    setRequest(value => value + 1)
  }
  const loadedCatalogCount = (catalogView: CatalogView, key = 'total'): number | null => {
    const state = catalogStates[catalogView]
    if (state.status !== 'ready') return null
    const count = state.catalog.counts[key]
    return typeof count === 'number' ? count : null
  }
  const viewCount = (item: InventoryView): string => {
    if (item === 'features') return formatInventoryCount(PUBLIC_FEATURES.length)
    if (item === 'system-internals') return formatInventoryCount(internalCount)
    return formatInventoryCount(loadedCatalogCount(item))
  }

  return (
    <div className={css.section} aria-busy={busy}>
      <div className={css.catalog}>
        <dl className={css.summary} aria-label={t('overview')}>
          <div><dt>{t('summaryFeatures')}</dt><dd data-summary-count="features">{viewCount('features')}</dd></div>
          <div><dt>{t('summarySkills')}</dt><dd data-summary-count="skills">{viewCount('skills')}</dd></div>
          <div><dt>{t('summaryProviders')}</dt><dd data-summary-count="providers">{viewCount('connectors')}</dd></div>
          <div><dt>{t('summaryActions')}</dt><dd data-summary-count="actions">{formatInventoryCount(loadedCatalogCount('connectors', 'actions'))}</dd></div>
        </dl>

        <div className={css.controls}>
          <label className={css.search}>
            <IconSearchOutline16 aria-hidden="true" />
            <span className={css.visuallyHidden}>{t('search')}</span>
            <input type="search" value={query} placeholder={t('search')} aria-label={t('search')}
              onChange={(event) => {
                setQuery(event.currentTarget.value)
                if (isCatalogView(view)) {
                  setVisibleLimits(current => ({ ...current, [view]: PAGE_SIZE }))
                }
              }} />
          </label>
          <div className={css.segments} role="group" aria-label={t('view')}>
            {(Object.keys(VIEW_KEYS) as InventoryView[]).map(item => (
              <button type="button" key={item} aria-label={t(VIEW_KEYS[item])}
                aria-pressed={view === item} onClick={() => { setView(item) }}>
                {t(VIEW_KEYS[item])}<span>{viewCount(item)}</span>
              </button>
            ))}
          </div>
        </div>

        {view === 'features' ? (
          <>
            <div className={css.catalogHeading}>
              <h3>{t('featuresView')}</h3>
              <span data-plugin-count={filteredFeatures.length}>{filteredFeatures.length}</span>
              <span className={css.catalogMeta}>{readyCount} {t('stateReady')} · {attentionCount} {t('summaryNeedsAttention')}</span>
            </div>
            {filteredFeatures.length === 0 ? <p className={css.status}>{t('emptySearch')}</p> : null}
            {featureGroups.map(({ category, features }) => {
              const categoryId = `${catalogId}-category-${category}`
              return (
                <section className={css.category} data-feature-category={category} key={category}>
                  <div className={css.categoryHeading}>
                    <h4 id={categoryId}>{t(CATEGORY_KEYS[category])}</h4>
                    <span data-category-count={category}>{features.length}</span>
                  </div>
                  <ul className={css.cards} aria-labelledby={categoryId}>
                    {features.map((feature) => {
                      const open = expandedFeature === feature.id
                      const statusText = t(STATE_KEYS[feature.runtimeState])
                      const detailId = `${catalogId}-feature-${feature.id}`
                      return (
                        <li className={css.card} key={feature.id} data-feature-id={feature.id} data-open={open ? 'true' : undefined}>
                          <button className={css.cardContent} type="button" aria-expanded={open}
                            aria-controls={detailId} aria-label={`${feature.title}, ${statusText}`}
                            onClick={() => { setExpandedFeature(current => current === feature.id ? null : feature.id) }}>
                            <strong className={css.cardTitle}>{feature.title}</strong>
                            <span className={css.cardTrailing}>
                              <span className={css.statusTag} data-state={feature.runtimeState}>{statusText}</span>
                              <IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" />
                            </span>
                          </button>
                          {open ? (
                            <div className={css.cardDetails} id={detailId}>
                              <p className={css.featureDetail}>{feature.detail}</p>
                            </div>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}
          </>
        ) : null}

        {isCatalogView(view) ? (
          <CatalogBrowser state={catalogStates[view]} view={view} query={normalizedQuery}
            visibleLimit={visibleLimits[view]}
            onLoadMore={() => {
              setVisibleLimits(current => ({ ...current, [view]: current[view] + PAGE_SIZE }))
            }}
            onRetry={() => {
              setCatalogStates(current => ({ ...current, [view]: { status: 'idle' } }))
            }} t={t} />
        ) : null}

        {view === 'system-internals' ? (
          <>
            <div className={css.catalogHeading}><h3>{t('systemView')}</h3><span>{internalEntries.length}</span></div>
            {inventoryState.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
            {inventoryState.status === 'error' ? <div className={css.failure}><p role="alert">{t('error')}</p><button type="button" onClick={retryInventory}>{t('retry')}</button></div> : null}
            {inventoryState.status === 'ready' && internalEntries.length === 0
              ? <p className={css.status}>{normalizedQuery ? t('emptySearch') : t('empty')}</p> : null}
            {inventoryState.status === 'ready' ? (
              <ul className={css.cards} aria-label={t('systemView')}>
                {internalEntries.map(({ entry, status, title }) => {
                  const open = expandedInternal === entry.entryId
                  const detailId = `${catalogId}-internal-${encodeURIComponent(entry.entryId)}`
                  return (
                    <li className={css.card} key={entry.entryId} data-plugin-entry={entry.entryId} data-open={open ? 'true' : undefined}>
                      <button className={css.cardContent} type="button" aria-expanded={open} aria-controls={detailId}
                        onClick={() => { setExpandedInternal(current => current === entry.entryId ? null : entry.entryId) }}>
                        <strong className={css.cardTitle}>{title}</strong>
                        <span className={css.cardTrailing}><span className={css.statusTag}>{status}</span>
                          <IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" /></span>
                      </button>
                      {open ? (
                        <div className={css.cardDetails} id={detailId}>
                          <dl className={css.details}>
                            <div><dt>{t('module')}</dt><dd><code data-module-name>{entry.moduleName}</code></dd></div>
                            <div><dt>{t('entry')}</dt><dd><code data-loader-entry>{entry.entryId}</code></dd></div>
                            <div><dt>{t('configuration')}</dt><dd>{t(entry.enabled ? 'enabledTag' : 'disabledTag')}</dd></div>
                            {entry.enabled ? <div><dt>{t('cordis')}</dt><dd>{phaseLabel(entry.fiberPhase, t)}</dd></div> : null}
                          </dl>
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
}
