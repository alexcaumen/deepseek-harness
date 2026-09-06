import { describe, expect, it, vi } from 'vitest'
import {
  IDLE_DICTATION_STATE,
  INDONESIAN_TRANSCRIPTION_ROUTE,
  LOCAL_INDONESIAN_TRANSCRIPTION_URL,
  reduceDictation,
  resolveIndonesianTranscriptionUrl,
} from '../src/client/skeleton/dictation.ts'

describe('Indonesian dictation runtime route', () => {
  it('accepts the desktop-owned speech port without changing the shared default', () => {
    expect(resolveIndonesianTranscriptionUrl({ __GIANA_DESKTOP__: { speechTranscriptionUrl: 'http://127.0.0.1:17402/v1/stt/transcribe' } })).toBe('http://127.0.0.1:17402/v1/stt/transcribe')
  })
  it('uses the desktop route only when runtime discovery and configuration are absent', () => {
    const desktop = { speechTranscriptionUrl: 'http://127.0.0.1:17402/v1/stt/transcribe' }
    const configured = 'http://127.0.0.1:19000/configured'
    const discovered = 'http://127.0.0.1:18444/discovered'
    expect(resolveIndonesianTranscriptionUrl({
      __GIANA_DESKTOP__: desktop,
      __GIANA_WINDOWS_RUNTIME__: { resolveRoute: () => discovered, routes: { [INDONESIAN_TRANSCRIPTION_ROUTE]: configured } },
    })).toBe(discovered)
    expect(resolveIndonesianTranscriptionUrl({
      __GIANA_DESKTOP__: desktop,
      __GIANA_WINDOWS_RUNTIME__: { resolveRoute: () => undefined, routes: { [INDONESIAN_TRANSCRIPTION_ROUTE]: configured } },
    })).toBe(configured)
    expect(resolveIndonesianTranscriptionUrl({
      __GIANA_DESKTOP__: desktop,
      __GIANA_WINDOWS_RUNTIME__: { resolveRoute: () => undefined, routes: {} },
    })).toBe(desktop.speechTranscriptionUrl)
    expect(resolveIndonesianTranscriptionUrl({ __GIANA_DESKTOP__: {} })).toBe(LOCAL_INDONESIAN_TRANSCRIPTION_URL)
    expect(LOCAL_INDONESIAN_TRANSCRIPTION_URL).toBe('http://127.0.0.1:17302/v1/stt/transcribe')
  })

  it.each([
    'https://token:secret@example.test/transcribe',
    'file:///private/transcribe',
    'http://127.0.0.1:65536/v1/stt/transcribe',
  ])('validates desktop-injected routes before use: %s', (speechTranscriptionUrl) => {
    expect(resolveIndonesianTranscriptionUrl({ __GIANA_DESKTOP__: { speechTranscriptionUrl } }))
      .toBe(LOCAL_INDONESIAN_TRANSCRIPTION_URL)
  })

  it('prefers typed runtime discovery, then static configuration', () => {
    const resolveRoute = vi.fn(() => 'http://127.0.0.1:18444/speech/id')
    expect(resolveIndonesianTranscriptionUrl({
      __GIANA_WINDOWS_RUNTIME__: {
        resolveRoute,
        routes: { [INDONESIAN_TRANSCRIPTION_ROUTE]: 'http://127.0.0.1:19000/configured' },
      },
    })).toBe('http://127.0.0.1:18444/speech/id')
    expect(resolveRoute).toHaveBeenCalledExactlyOnceWith(INDONESIAN_TRANSCRIPTION_ROUTE)

    expect(resolveIndonesianTranscriptionUrl({
      __GIANA_WINDOWS_RUNTIME__: {
        routes: { [INDONESIAN_TRANSCRIPTION_ROUTE]: '/speech/transcribe' },
      },
      location: { origin: 'https://giana.local' },
    })).toBe('https://giana.local/speech/transcribe')
  })

  it('uses the loopback fallback for missing, throwing, credentialed, or non-http routes', () => {
    expect(resolveIndonesianTranscriptionUrl({})).toBe(LOCAL_INDONESIAN_TRANSCRIPTION_URL)
    expect(resolveIndonesianTranscriptionUrl({
      __GIANA_WINDOWS_RUNTIME__: { resolveRoute: () => { throw new Error('not ready') } },
    })).toBe(LOCAL_INDONESIAN_TRANSCRIPTION_URL)
    expect(resolveIndonesianTranscriptionUrl({
      __GIANA_WINDOWS_RUNTIME__: {
        routes: { [INDONESIAN_TRANSCRIPTION_ROUTE]: 'https://token:secret@example.test/transcribe' },
      },
    })).toBe(LOCAL_INDONESIAN_TRANSCRIPTION_URL)
    expect(resolveIndonesianTranscriptionUrl({
      __GIANA_WINDOWS_RUNTIME__: {
        routes: { [INDONESIAN_TRANSCRIPTION_ROUTE]: 'file:///tmp/transcribe' },
      },
    })).toBe(LOCAL_INDONESIAN_TRANSCRIPTION_URL)
  })
})

describe('Indonesian dictation state machine', () => {
  it('covers permission, recording, transcription, review, sending, and reset', () => {
    const permission = reduceDictation(IDLE_DICTATION_STATE, { type: 'request-permission' })
    expect(permission).toEqual({ phase: 'requesting-permission' })
    const recording = reduceDictation(permission, { type: 'permission-granted', at: 1_000 })
    expect(reduceDictation(recording, { type: 'tick', at: 3_400 })).toMatchObject({
      phase: 'recording', elapsedSeconds: 2,
    })
    const transcribing = reduceDictation(recording, { type: 'stop-recording' })
    expect(transcribing).toEqual({ phase: 'transcribing' })
    const review = reduceDictation(transcribing, { type: 'transcribed', transcript: 'selamat pagi' })
    expect(review).toEqual({ phase: 'review', transcript: 'selamat pagi' })
    const sending = reduceDictation(review, { type: 'send' })
    expect(sending).toEqual({ phase: 'sending', transcript: 'selamat pagi' })
    expect(reduceDictation(sending, { type: 'reset' })).toEqual(IDLE_DICTATION_STATE)
  })

  it('retains retry context for permission, transcription, and sending errors', () => {
    const permission = reduceDictation(
      { phase: 'requesting-permission' },
      { type: 'permission-failed', message: 'denied' },
    )
    expect(permission).toEqual({ phase: 'error', message: 'denied', retry: 'permission' })
    expect(reduceDictation(permission, { type: 'request-permission' })).toEqual({ phase: 'requesting-permission' })

    const transcription = reduceDictation(
      { phase: 'transcribing' },
      { type: 'transcription-failed', message: 'offline' },
    )
    expect(reduceDictation(transcription, { type: 'retry-transcription' })).toEqual({ phase: 'transcribing' })

    const sending = reduceDictation(
      { phase: 'sending', transcript: 'halo' },
      { type: 'send-failed', message: 'busy' },
    )
    expect(reduceDictation(sending, { type: 'retry-send' })).toEqual({ phase: 'sending', transcript: 'halo' })
  })
})
