/** General Settings control for governed local-model placement intent. */

import { useCallback, useSyncExternalStore, useState } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationKey } from '../locales.ts'
import {
  MODEL_COMPUTE_PREFERENCE_FIELD,
  type ModelComputePreference,
  type ModelLifecycleSettings,
} from '../model-compute-settings.ts'
import css from './ComputeRoutingRow.module.css'

export interface ModelComputeRoutingRowInjected {
  /** Host-backed setting; it is routing intent, never a claim that a host is ready. */
  settings: SettingsScope<ModelLifecycleSettings>
}

export type ModelComputeRoutingRowProps = PropsRuntime<'settings.general.item'>
  & PropsLocale<'conversation'>
  & InjectFace<ModelComputeRoutingRowInjected>

const OPTIONS: readonly { id: ModelComputePreference; label: ConversationKey }[] = [
  { id: 'automatic', label: 'settings.modelCompute.automatic' },
  { id: 'r5300', label: 'settings.modelCompute.r5300' },
  { id: 'prdg', label: 'settings.modelCompute.prdg' },
]

/** Persist model placement intent while leaving live admission to the controller. */
export function ModelComputeRoutingRow({ settings, t }: ModelComputeRoutingRowProps) {
  const subscribe = useCallback((listener: () => void) => settings.subscribe(listener), [settings])
  const getSnapshot = useCallback(() => settings.getSnapshot(), [settings])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)
  const [saving, setSaving] = useState<ModelComputePreference>()
  const [saveFailed, setSaveFailed] = useState(false)
  const preference = snapshot.value?.preference ?? 'automatic'
  const disabled = snapshot.status !== 'ready' || !snapshot.writable || saving !== undefined

  const select = async (next: ModelComputePreference) => {
    if (next === preference || disabled) return
    setSaving(next)
    setSaveFailed(false)
    try {
      await settings.set(MODEL_COMPUTE_PREFERENCE_FIELD, next)
      if (settings.getSnapshot().value?.preference !== next) setSaveFailed(true)
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(undefined)
    }
  }

  const status = saving !== undefined
    ? t('settings.modelCompute.saving')
    : saveFailed
      ? t('settings.modelCompute.failed')
      : snapshot.status === 'loading'
        ? t('settings.modelCompute.loading')
        : snapshot.status === 'unavailable'
          ? t('settings.modelCompute.unavailable')
          : snapshot.writable
            ? t('settings.modelCompute.savedIntent')
            : t('settings.modelCompute.readOnly')

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('settings.modelCompute.title')}</div>
        <div className={css.desc}>{t('settings.modelCompute.description')}</div>
        <div className={saveFailed ? `${css.status} ${css.error}` : css.status} role={saveFailed ? 'alert' : 'status'}>
          {status}
        </div>
      </div>
      <div className={css.controls}>
        <div className={css.segments} role="group" aria-label={t('settings.modelCompute.title')}>
          {OPTIONS.map(option => (
            <button
              key={option.id}
              type="button"
              className={css.segment}
              data-selected={preference === option.id}
              aria-pressed={preference === option.id}
              aria-busy={saving === option.id}
              disabled={disabled}
              onClick={() => { void select(option.id) }}
            >
              {t(option.label)}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
