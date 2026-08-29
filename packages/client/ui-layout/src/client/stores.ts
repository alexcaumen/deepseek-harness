/**
 * The root entry's transient layout store: panel geometry as plain widths in
 * px (0 = closed). Module level exports the factory only — a module-level
 * handle would pin the store's identity in the module
 * cache (a de-facto singleton surviving plugin reloads). register() receives
 * the factory (exclusive use: the framework instantiates per entry), AppFrame
 * derives its PropsStore share from the return type, and the service face
 * receives the bound actions through the registration's inject hook.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import {
  clampWidth, DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from './columns.ts'

/**
 * Layout store state: panel width preferences in px (0 = closed), plus the
 * narrow-viewport pair — `narrow` mirrors AppFrame's breakpoint reading
 * (viewport < SIDEBAR_AUTO_COLLAPSE) so toggleSidebar can pick semantics, and
 * `narrowExpanded` is the manual override that re-expands the auto-collapsed
 * sidebar over the squeezed center without rewriting the width preference.
 */
export type PaneMode = 'visible' | 'hidden' | 'collapsible' | 'locked-open'

export interface PanePolicy {
  mode: PaneMode
  defaultSize: number
  minSize: number
  maxSize: number
}

export interface LayoutPolicy {
  id: string
  sidebar: PanePolicy
  middle: PanePolicy
  details: PanePolicy
  bottom: PanePolicy
}

/**
 * Universal chat/workbench profile. Product surfaces may replace it through
 * ctx.layout.setPolicy without forking the shell or hard-coding a second
 * layout. The bottom surface is available but closed until an application
 * explicitly contributes controls and opens it.
 */
export const UNIVERSAL_LAYOUT_POLICY: LayoutPolicy = {
  id: 'giana.universal',
  sidebar: { mode: 'collapsible', defaultSize: SIDEBAR_DEFAULT, minSize: SIDEBAR_MIN, maxSize: SIDEBAR_MAX },
  middle: { mode: 'collapsible', defaultSize: 0, minSize: 0, maxSize: 0 },
  details: { mode: 'collapsible', defaultSize: DETAILS_DEFAULT, minSize: DETAILS_MIN, maxSize: DETAILS_MAX },
  bottom: { mode: 'collapsible', defaultSize: 280, minSize: 160, maxSize: 520 },
}

type LayoutState = {
  sidebar: number
  details: number
  bottom: number
  middleCollapsed: boolean
  narrow: boolean
  narrowExpanded: boolean
  policy: LayoutPolicy
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type LayoutActions = {
  setSidebar: (draft: LayoutState, px: number) => void
  setDetails: (draft: LayoutState, px: number) => void
  setBottom: (draft: LayoutState, px: number) => void
  setPolicy: (draft: LayoutState, policy: LayoutPolicy) => void
  toggleSidebar: (draft: LayoutState) => void
  setNarrow: (draft: LayoutState, narrow: boolean) => void
  toggleMiddle: (draft: LayoutState) => void
  focusDetails: (draft: LayoutState) => void
  showMiddle: (draft: LayoutState) => void
  toggleDetails: (draft: LayoutState) => void
  openDetails: (draft: LayoutState) => void
  closeDetails: (draft: LayoutState) => void
  toggleBottom: (draft: LayoutState) => void
  openBottom: (draft: LayoutState) => void
  closeBottom: (draft: LayoutState) => void
}

function copyPolicy(policy: LayoutPolicy): LayoutPolicy {
  return {
    id: policy.id,
    sidebar: { ...policy.sidebar },
    middle: { ...policy.middle },
    details: { ...policy.details },
    bottom: { ...policy.bottom },
  }
}

function canCollapse(policy: PanePolicy): boolean {
  return policy.mode === 'collapsible'
}

/**
 * Create the layout panel store handle. The preference IS the width, so
 * closing a panel forgets its drag width — reopening restores the contract
 * default. Actions are the complete write set: drag writes clamp
 * into the panel's contract range and never cross the open/closed line;
 * open/close transitions write 0 / the default explicitly. Below the
 * auto-collapse breakpoint (AppFrame feeds setNarrow) the sidebar toggle
 * flips the narrowExpanded override instead of the preference.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions>  {
  const handle = defineStore({
    init: (): LayoutState => ({
      sidebar: SIDEBAR_DEFAULT,
      details: 0,
      bottom: 0,
      middleCollapsed: false,
      narrow: false,
      narrowExpanded: false,
      policy: copyPolicy(UNIVERSAL_LAYOUT_POLICY),
    }),
    actions: {
      setSidebar: (d, px: number) => {
        if (d.policy.sidebar.mode === 'hidden') return
        d.sidebar = clampWidth(px, d.policy.sidebar.minSize, d.policy.sidebar.maxSize)
      },
      setDetails: (d, px: number) => {
        if (d.policy.details.mode === 'hidden') return
        d.details = clampWidth(px, d.policy.details.minSize, d.policy.details.maxSize)
      },
      setBottom: (d, px: number) => {
        if (d.policy.bottom.mode === 'hidden') return
        d.bottom = clampWidth(px, d.policy.bottom.minSize, d.policy.bottom.maxSize)
      },
      setPolicy: (d, policy: LayoutPolicy) => {
        d.policy = copyPolicy(policy)
        if (policy.sidebar.mode === 'hidden') d.sidebar = 0
        else if ((policy.sidebar.mode === 'visible' || policy.sidebar.mode === 'locked-open') && d.sidebar === 0) d.sidebar = policy.sidebar.defaultSize
        if (policy.middle.mode === 'hidden') d.middleCollapsed = true
        else if (policy.middle.mode === 'visible' || policy.middle.mode === 'locked-open') d.middleCollapsed = false
        if (policy.details.mode === 'hidden') d.details = 0
        else if ((policy.details.mode === 'visible' || policy.details.mode === 'locked-open') && d.details === 0) d.details = policy.details.defaultSize
        if (policy.bottom.mode === 'hidden') d.bottom = 0
        else if ((policy.bottom.mode === 'visible' || policy.bottom.mode === 'locked-open') && d.bottom === 0) d.bottom = policy.bottom.defaultSize
      },
      // Narrow toggles flip only the override: the width preference survives
      // untouched, so re-widening restores the pre-squeeze layout.
      toggleSidebar: (d) => {
        if (!canCollapse(d.policy.sidebar)) return
        if (d.narrow) d.narrowExpanded = !d.narrowExpanded
        else d.sidebar = d.sidebar === 0 ? d.policy.sidebar.defaultSize : 0
      },
      // Crossing the breakpoint in either direction drops the override: the
      // narrow default is auto-collapsed, the wide state is the preference.
      setNarrow: (d, narrow: boolean) => {
        if (d.narrow === narrow) return
        d.narrow = narrow
        d.narrowExpanded = false
      },
      toggleMiddle: (d) => {
        if (!canCollapse(d.policy.middle) || d.details === 0) return
        d.middleCollapsed = !d.middleCollapsed
      },
      focusDetails: (d) => {
        if (d.policy.details.mode === 'hidden') return
        if (d.details === 0) d.details = d.policy.details.defaultSize
        if (canCollapse(d.policy.middle)) d.middleCollapsed = true
      },
      showMiddle: (d) => { if (d.policy.middle.mode !== 'hidden') d.middleCollapsed = false },
      toggleDetails: (d) => {
        if (!canCollapse(d.policy.details)) return
        d.details = d.details === 0 ? d.policy.details.defaultSize : 0
        if (d.details === 0) d.middleCollapsed = false
      },
      openDetails: (d) => {
        if (d.policy.details.mode !== 'hidden' && d.details === 0) d.details = d.policy.details.defaultSize
      },
      closeDetails: (d) => {
        if (d.policy.details.mode === 'locked-open') return
        d.details = 0
        d.middleCollapsed = false
      },
      toggleBottom: (d) => {
        if (!canCollapse(d.policy.bottom)) return
        d.bottom = d.bottom === 0 ? d.policy.bottom.defaultSize : 0
      },
      openBottom: (d) => {
        if (d.policy.bottom.mode !== 'hidden' && d.bottom === 0) d.bottom = d.policy.bottom.defaultSize
      },
      closeBottom: (d) => {
        if (d.policy.bottom.mode !== 'locked-open') d.bottom = 0
      },
    },
  })
  return handle
}
