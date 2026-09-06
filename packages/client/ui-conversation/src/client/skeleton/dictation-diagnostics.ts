/** Payload-free events sent through the optional, existing desktop bridge. */
export type DictationOutcome = 'success' | 'canceled' | 'network-error' | 'http-error' | 'invalid-response' | 'empty-result' | 'permission-error' | 'capture-error'
interface DiagnosticGlobals {
  readonly __GIANA_DESKTOP__?: { readonly reportDictation?: (record: Record<string, unknown>) => unknown }
}

/** Never forwards error text, URLs, audio or transcripts, and never breaks dictation. */
export function reportDictationOutcome(
  outcome: DictationOutcome, startedAt: number, httpStatus?: number,
  globals: DiagnosticGlobals = globalThis as DiagnosticGlobals,
): void {
  try {
    const elapsedMs = Math.min(3_600_000, Math.max(0, Math.round(Date.now() - startedAt)))
    const record = {
      kind: 'dictation', route: 'speech.transcribe', outcome, at: new Date().toISOString(),
      elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : 0,
      ...(httpStatus !== undefined && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
    }
    void Promise.resolve(globals.__GIANA_DESKTOP__?.reportDictation?.(record)).catch(() => {})
  } catch { /* Diagnostic delivery must not change the user's recording state. */ }
}
