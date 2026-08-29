// @vitest-environment jsdom
/**
 * createLayoutStore unit account: init shape, the action write set (clamp
 * inside actions), and the absence of browser persistence. Uses the
 * test-sanctioned path: factory self-call + .create() gives the
 * real engine instance (same create path as production).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createLayoutStore, UNIVERSAL_LAYOUT_POLICY,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import {
  DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

const PERSIST_KEY = 'dsh.layout.panels'

beforeEach(() => { localStorage.clear() })

describe('createLayoutStore', () => {
  it('initializes the sidebar open and the contextual details panel closed', () => {
    const { store } = createLayoutStore().create()
    expect(store.getSnapshot()).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      details: 0,
      bottom: 0,
      middleCollapsed: false,
      narrow: false,
      narrowExpanded: false,
      policy: UNIVERSAL_LAYOUT_POLICY,
    })
  })

  it('each create() is an independent instance (factory is not a singleton)', () => {
    const a = createLayoutStore().create()
    const b = createLayoutStore().create()
    a.actions.setSidebar(400)
    expect(b.store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('setSidebar/setDetails clamp into the contract ranges', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(1)
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_MIN)
    actions.setSidebar(9999)
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_MAX)
    actions.setDetails(1)
    expect(store.getSnapshot().details).toBe(DETAILS_MIN)
    actions.setDetails(9999)
    expect(store.getSnapshot().details).toBe(DETAILS_MAX)
  })

  it('toggleSidebar flips closed <-> contract default (drag width forgotten)', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(0)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('narrow toggleSidebar flips only the re-expand override; the width preference survives', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toEqual({
      sidebar: 400,
      details: 0,
      bottom: 0,
      middleCollapsed: false,
      narrow: true,
      narrowExpanded: true,
      policy: UNIVERSAL_LAYOUT_POLICY,
    })
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(false)
    expect(store.getSnapshot().sidebar).toBe(400)
  })

  it('crossing the breakpoint drops the override; a same-value setNarrow keeps it', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setNarrow(true)
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setNarrow(false)
    expect(store.getSnapshot()).toMatchObject({ narrow: false, narrowExpanded: false })
    actions.setNarrow(true)
    expect(store.getSnapshot().narrowExpanded).toBe(false)
  })

  it('openDetails uses the contract default, preserves an open width, and closeDetails zeroes', () => {
    const { store, actions } = createLayoutStore().create()
    actions.closeDetails()
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(DETAILS_DEFAULT)
    actions.setDetails(500)
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(500)
    actions.closeDetails()
    expect(store.getSnapshot().details).toBe(0)
  })

  it('toggleDetails opens the unified inspector once and closes it on the next gesture', () => {
    const { store, actions } = createLayoutStore().create()
    actions.toggleDetails()
    expect(store.getSnapshot().details).toBe(DETAILS_DEFAULT)
    actions.toggleDetails()
    expect(store.getSnapshot().details).toBe(0)
  })

  it('focuses the inspector full-width and restores the conversation pane', () => {
    const { store, actions } = createLayoutStore().create()
    actions.focusDetails()
    expect(store.getSnapshot()).toMatchObject({ details: DETAILS_DEFAULT, middleCollapsed: true })
    actions.showMiddle()
    expect(store.getSnapshot().middleCollapsed).toBe(false)
    actions.toggleMiddle()
    expect(store.getSnapshot().middleCollapsed).toBe(true)
    actions.closeDetails()
    expect(store.getSnapshot()).toMatchObject({ details: 0, middleCollapsed: false })
  })

  it('opens, resizes, toggles, and closes the optional bottom surface', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openBottom()
    expect(store.getSnapshot().bottom).toBe(280)
    actions.setBottom(9999)
    expect(store.getSnapshot().bottom).toBe(520)
    actions.toggleBottom()
    expect(store.getSnapshot().bottom).toBe(0)
    actions.openBottom()
    actions.closeBottom()
    expect(store.getSnapshot().bottom).toBe(0)
  })

  it('applies application pane policy and fails closed for hidden or locked surfaces', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setPolicy({
      id: 'test.policy',
      sidebar: { ...UNIVERSAL_LAYOUT_POLICY.sidebar, mode: 'locked-open' },
      middle: { ...UNIVERSAL_LAYOUT_POLICY.middle, mode: 'hidden' },
      details: { ...UNIVERSAL_LAYOUT_POLICY.details, mode: 'locked-open' },
      bottom: { ...UNIVERSAL_LAYOUT_POLICY.bottom, mode: 'hidden' },
    })
    expect(store.getSnapshot()).toMatchObject({
      middleCollapsed: true,
      details: DETAILS_DEFAULT,
      bottom: 0,
      policy: { id: 'test.policy' },
    })
    actions.toggleSidebar()
    actions.closeDetails()
    actions.openBottom()
    expect(store.getSnapshot()).toMatchObject({ sidebar: SIDEBAR_DEFAULT, details: DETAILS_DEFAULT, bottom: 0 })
  })

  it('does not persist panel geometry', () => {
    const first = createLayoutStore().create()
    first.actions.setSidebar(400)
    first.actions.openDetails()
    first.actions.setDetails(500)
    expect(localStorage.getItem(PERSIST_KEY)).toBeNull()

    const second = createLayoutStore().create()
    expect(second.store.getSnapshot()).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      details: 0,
      bottom: 0,
      middleCollapsed: false,
      narrow: false,
      narrowExpanded: false,
      policy: UNIVERSAL_LAYOUT_POLICY,
    })
  })
})
