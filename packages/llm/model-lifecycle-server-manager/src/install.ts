import type {
  GovernedModelRoute,
  ModelLifecycleAuthority,
  ModelLifecycleRuntime,
} from '@deepseek-ai/dsh-model-lifecycle'
import { ServerManagerModelLifecycleAdapter, type ServerManagerAdapterOptions } from './index.ts'

/**
 * Compose the existing authority, lease consumer, and exact admitted routes.
 * The deployment owns this effect and must await its disposer before closing
 * the transport. Registration is lazy: it never probes, loads, or evicts a model.
 * It does not register LLM profiles or fabricate identity/admission evidence.
 */
export async function installServerManagerLifecycle(
  runtime: ModelLifecycleRuntime,
  authority: ModelLifecycleAuthority,
  routes: readonly GovernedModelRoute[],
  options: ServerManagerAdapterOptions,
): Promise<() => Promise<void>> {
  if (routes.length === 0 || routes.some(route => route.targets.some(target => options.targets[target] === undefined))) {
    throw new Error('Local model routes require explicit admitted target coverage')
  }
  const adapter = new ServerManagerModelLifecycleAdapter(options)
  const routesToRemove = new Set<() => Promise<void>>()
  let removeAuthority: (() => void) | undefined
  let removeResources: (() => void) | undefined
  let closing: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    closing ??= (async () => {
      const failures: unknown[] = []
      for (const remove of [...routesToRemove].reverse()) {
        try {
          await remove()
          routesToRemove.delete(remove)
        } catch (error: unknown) { failures.push(error) }
      }
      // Keep dependencies installed while any route still needs them to settle.
      // Completed removals are never replayed; failed cleanup can be retried.
      if (failures.length > 0) throw new AggregateError(failures, 'Local model route cleanup is incomplete')
      removeResources?.()
      removeResources = undefined
      removeAuthority?.()
      removeAuthority = undefined
    })().finally(() => { closing = undefined })
    return closing
  }
  try {
    removeAuthority = runtime.installAuthority(authority)
    removeResources = runtime.installResources(adapter)
    for (const route of routes) routesToRemove.add(runtime.register(route, adapter))
    return dispose
  } catch (error: unknown) {
    try { await dispose() } catch {
      throw new Error('Local model installation failed; cleanup requires reconciliation')
    }
    throw error
  }
}
