/** General Settings control for the Giana Code speech compute route. */
import { useCallback, useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationKey } from '../locales.ts'
import css from './ComputeRoutingRow.module.css'

export const COMPUTE_CONFIG_ROUTE = 'speech.compute.config' as const
export const LOCAL_COMPUTE_CONFIG_URL = 'http://127.0.0.1:17302/v1/compute/config'

export type ComputeRoutingMode = 'automatic' | 'r5300' | 'prdg'

interface ComputeRouteSelection {
  id: 'r5300' | 'prdg'
  state: string
  device: string
}

export interface ComputeRoutingResponse {
  mode: ComputeRoutingMode
  priority: readonly ['r5300', 'prdg']
  probeOrder: readonly string[]
  selectedRoute: ComputeRouteSelection
}

interface ComputeRuntimeGlobal {
  readonly __GIANA_WINDOWS_RUNTIME__?: {
    readonly resolveRoute?: (route: typeof COMPUTE_CONFIG_ROUTE) => string | URL | undefined
    readonly routes?: Readonly<Partial<Record<typeof COMPUTE_CONFIG_ROUTE, string | URL>>>
  }
  readonly location?: { readonly origin?: string }
}

export function resolveComputeConfigUrl(runtimeGlobal: ComputeRuntimeGlobal = globalThis): string {
  const runtime = runtimeGlobal.__GIANA_WINDOWS_RUNTIME__
  let discovered: string | URL | undefined
  try {
    discovered = runtime?.resolveRoute?.(COMPUTE_CONFIG_ROUTE)
      ?? runtime?.routes?.[COMPUTE_CONFIG_ROUTE]
  } catch {
    return LOCAL_COMPUTE_CONFIG_URL
  }
  if (discovered === undefined) return LOCAL_COMPUTE_CONFIG_URL
  try {
    const origin = runtimeGlobal.location?.origin
    const url = new URL(discovered, origin !== undefined && origin !== 'null' ? origin : LOCAL_COMPUTE_CONFIG_URL)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
      return LOCAL_COMPUTE_CONFIG_URL
    }
    return url.toString()
  } catch {
    return LOCAL_COMPUTE_CONFIG_URL
  }
}

export type ComputeRoutingRowProps = PropsRuntime<'settings.general.item'> & PropsLocale<'conversation'>

const OPTIONS: readonly { id: ComputeRoutingMode; label: ConversationKey }[] = [
  { id: 'automatic', label: 'settings.compute.automatic' },
  { id: 'r5300', label: 'settings.compute.r5300' },
  { id: 'prdg', label: 'settings.compute.prdg' },
]

async function readResponse(response: Response): Promise<ComputeRoutingResponse> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json() as ComputeRoutingResponse
}

export function ComputeRoutingRow({ t }: ComputeRoutingRowProps) {
  const [status, setStatus] = useState<ComputeRoutingResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endpoint = resolveComputeConfigUrl()

  const refresh = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await readResponse(await fetch(endpoint)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [endpoint])

  useEffect(() => { void refresh() }, [refresh])

  const select = async (mode: ComputeRoutingMode) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await readResponse(await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const routeLabel = status?.selectedRoute.id === 'r5300'
    ? t('settings.compute.r5300')
    : t('settings.compute.prdg')
  const statusCopy = status === null
    ? t('settings.compute.loading')
    : t('settings.compute.status', {
      route: routeLabel,
      device: status.selectedRoute.device,
      state: status.selectedRoute.state,
    })

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('settings.compute.title')}</div>
        <div className={css.desc}>{t('settings.compute.description')}</div>
        <div
          className={error === null ? css.status : `${css.status} ${css.error}`}
          data-state={status?.selectedRoute.state ?? 'loading'}
          role={error === null ? 'status' : 'alert'}
        >
          {error === null ? statusCopy : t('settings.compute.failed', { message: error })}
        </div>
      </div>
      <div className={css.controls}>
        <div className={css.segments} role="group" aria-label={t('settings.compute.title')}>
          {OPTIONS.map(option => (
            <button
              key={option.id}
              type="button"
              className={css.segment}
              data-selected={status?.mode === option.id}
              aria-pressed={status?.mode === option.id}
              disabled={busy}
              onClick={() => { void select(option.id) }}
            >
              {t(option.label)}
            </button>
          ))}
        </div>
        <button type="button" className={css.refresh} disabled={busy} onClick={() => { void refresh() }}>
          {busy ? t('settings.compute.checking') : t('settings.compute.refresh')}
        </button>
      </div>
    </div>
  )
}
