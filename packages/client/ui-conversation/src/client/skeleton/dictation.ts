/** Browser route id owned by the Giana CoWork Indonesian speech surface. */
export const INDONESIAN_TRANSCRIPTION_ROUTE = 'speech.transcribe.id-ID' as const

/** Local speech service used when the Windows runtime publishes no usable route. */
export const LOCAL_INDONESIAN_TRANSCRIPTION_URL = 'http://127.0.0.1:17302/v1/stt/transcribe'

export interface GianaWindowsRuntimeRoutes {
  /** Resolve a runtime-owned route whose port may change between launches. */
  readonly resolveRoute?: (route: typeof INDONESIAN_TRANSCRIPTION_ROUTE) => string | URL | undefined
  /** Static route configuration for launchers that do not need a resolver. */
  readonly routes?: Readonly<Partial<Record<typeof INDONESIAN_TRANSCRIPTION_ROUTE, string | URL>>>
}

export interface GianaWindowsRuntimeGlobal {
  readonly __GIANA_WINDOWS_RUNTIME__?: GianaWindowsRuntimeRoutes
  readonly location?: { readonly origin?: string }
}

/**
 * Discover the speech route published by Giana CoWork. Invalid configuration
 * fails closed to the loopback service; credentials are never accepted in a
 * route URL and the request itself carries no authorization material.
 */
export function resolveIndonesianTranscriptionUrl(
  runtimeGlobal: GianaWindowsRuntimeGlobal = globalThis,
): string {
  const runtime = runtimeGlobal.__GIANA_WINDOWS_RUNTIME__
  let discovered: string | URL | undefined
  try {
    discovered = runtime?.resolveRoute?.(INDONESIAN_TRANSCRIPTION_ROUTE)
      ?? runtime?.routes?.[INDONESIAN_TRANSCRIPTION_ROUTE]
  } catch {
    return LOCAL_INDONESIAN_TRANSCRIPTION_URL
  }
  if (discovered === undefined) return LOCAL_INDONESIAN_TRANSCRIPTION_URL
  try {
    const base = runtimeGlobal.location?.origin
    const url = new URL(discovered, base !== undefined && base !== 'null'
      ? base
      : LOCAL_INDONESIAN_TRANSCRIPTION_URL)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
      return LOCAL_INDONESIAN_TRANSCRIPTION_URL
    }
    return url.toString()
  } catch {
    return LOCAL_INDONESIAN_TRANSCRIPTION_URL
  }
}

export type DictationRetry = 'permission' | 'transcription' | 'sending'

export type DictationState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'requesting-permission' }
  | { readonly phase: 'recording'; readonly startedAt: number; readonly elapsedSeconds: number }
  | { readonly phase: 'transcribing' }
  | { readonly phase: 'review'; readonly transcript: string }
  | { readonly phase: 'sending'; readonly transcript: string }
  | { readonly phase: 'error'; readonly message: string; readonly retry: DictationRetry; readonly transcript?: string }

export type DictationEvent =
  | { readonly type: 'request-permission' }
  | { readonly type: 'permission-granted'; readonly at: number }
  | { readonly type: 'permission-failed'; readonly message: string }
  | { readonly type: 'tick'; readonly at: number }
  | { readonly type: 'stop-recording' }
  | { readonly type: 'transcribed'; readonly transcript: string }
  | { readonly type: 'transcription-failed'; readonly message: string }
  | { readonly type: 'send' }
  | { readonly type: 'send-failed'; readonly message: string }
  | { readonly type: 'retry-transcription' }
  | { readonly type: 'retry-send' }
  | { readonly type: 'reset' }

export const IDLE_DICTATION_STATE: DictationState = { phase: 'idle' }

/** Pure transition function for the composer-owned dictation lifecycle. */
export function reduceDictation(state: DictationState, event: DictationEvent): DictationState {
  if (event.type === 'reset') return IDLE_DICTATION_STATE
  switch (state.phase) {
    case 'idle':
      return event.type === 'request-permission' ? { phase: 'requesting-permission' } : state
    case 'review':
      if (event.type === 'request-permission') return { phase: 'requesting-permission' }
      return event.type === 'send' ? { phase: 'sending', transcript: state.transcript } : state
    case 'error':
      if (event.type === 'request-permission') return { phase: 'requesting-permission' }
      if (event.type === 'retry-transcription' && state.retry === 'transcription') return { phase: 'transcribing' }
      if (event.type === 'retry-send' && state.retry === 'sending' && state.transcript !== undefined) {
        return { phase: 'sending', transcript: state.transcript }
      }
      return state
    case 'requesting-permission':
      if (event.type === 'permission-granted') {
        return { phase: 'recording', startedAt: event.at, elapsedSeconds: 0 }
      }
      if (event.type === 'permission-failed') {
        return { phase: 'error', message: event.message, retry: 'permission' }
      }
      return state
    case 'recording':
      if (event.type === 'tick') {
        return { ...state, elapsedSeconds: Math.max(0, Math.floor((event.at - state.startedAt) / 1000)) }
      }
      if (event.type === 'transcription-failed') {
        return { phase: 'error', message: event.message, retry: 'permission' }
      }
      return event.type === 'stop-recording' ? { phase: 'transcribing' } : state
    case 'transcribing':
      if (event.type === 'transcribed') return { phase: 'review', transcript: event.transcript }
      if (event.type === 'transcription-failed') {
        return { phase: 'error', message: event.message, retry: 'transcription' }
      }
      return state
    case 'sending':
      return event.type === 'send-failed'
        ? { phase: 'error', message: event.message, retry: 'sending', transcript: state.transcript }
        : state
  }
  return state
}
