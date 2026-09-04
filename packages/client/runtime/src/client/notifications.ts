import type { HostFrame, MuxFrame } from '@deepseek-ai/dsh-api-remotes/client'

export type DesktopNotificationKind = 'completed' | 'failed' | 'attention'

export interface DesktopNotificationCandidate {
  readonly key: string
  readonly kind: DesktopNotificationKind
  readonly title: string
  readonly body: string
  readonly tag: string
  /** Exact durable session target for a host notification click. */
  readonly sessionId?: string
}

// Connection push envelopes expose rpcId as a transport string; notification
// delivery does not need the internal branded request identity.
export interface DesktopNotificationEnvelope {
  readonly rpcId: string
  readonly payload: MuxFrame | HostFrame
}

export interface DesktopNotificationSink {
  /** Resolves true only when the host accepted the notification. */
  notify(candidate: DesktopNotificationCandidate): boolean | Promise<boolean>
}

interface DesktopNotificationBridge {
  notify(candidate: DesktopNotificationCandidate): boolean | Promise<boolean>
  onOpenSession?(listener: (sessionId: string) => void): (() => void) | void
}

interface DesktopNotificationStore {
  getItem(name: string): string | null
  setItem(name: string, value: string): void
}

interface BrowserNotificationConstructor {
  new (title: string, options?: { body?: string; tag?: string }): unknown
  readonly permission?: string
}

interface DesktopGlobals {
  readonly __GIANA_DESKTOP__?: DesktopNotificationBridge
  readonly Notification?: BrowserNotificationConstructor
  readonly document?: {
    readonly hidden?: boolean
    readonly visibilityState?: string
    hasFocus?: () => boolean
  }
}

const APP_TITLE = 'Giana CoWork'
const DELIVERED_STORAGE_KEY = 'giana.code.putri.notifications.delivered.v1'

function globals(): DesktopGlobals {
  return globalThis as typeof globalThis & DesktopGlobals
}

function defaultNotificationStore(): DesktopNotificationStore | undefined {
  try {
    const storage = (globalThis as typeof globalThis & { localStorage?: DesktopNotificationStore }).localStorage
    if (storage === undefined) return undefined
    storage.getItem(DELIVERED_STORAGE_KEY)
    return storage
  } catch {
    return undefined
  }
}

function restoreDelivered(store: DesktopNotificationStore | undefined): Set<string> {
  if (store === undefined) return new Set()
  try {
    const raw = store.getItem(DELIVERED_STORAGE_KEY)
    if (raw === null) return new Set()
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return new Set()
    return new Set(value.filter((item): item is string => typeof item === 'string'))
  } catch {
    return new Set()
  }
}

function persistDelivered(store: DesktopNotificationStore | undefined, delivered: Set<string>): void {
  if (store === undefined) return
  try {
    store.setItem(DELIVERED_STORAGE_KEY, JSON.stringify([...delivered]))
  } catch {
    // Private browsing and exhausted storage must not break notification delivery.
  }
}

function makeCandidate(
  kind: DesktopNotificationKind,
  key: string,
  sessionId: string | undefined,
  detail: string,
): DesktopNotificationCandidate {
  const label = kind === 'completed'
    ? 'Tugas selesai'
    : kind === 'attention' ? 'Perlu perhatian' : 'Tugas terhenti'
  return {
    key,
    kind,
    title: `${APP_TITLE} - ${label}`,
    body: detail,
    tag: `${APP_TITLE}:${key}`,
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

/** Maps only durable completion/request/error signals to a desktop notice. */
export function classifyNotification(
  frame: MuxFrame | HostFrame,
  rpcId = 'push',
): DesktopNotificationCandidate | undefined {
  switch (frame.type) {
    case 'session/event': {
      if (frame.event.type !== 'turn/end') return undefined
      const reason = frame.event.data.reason
      const key = `${frame.sessionId}:turn-end:${frame.event.seq}`
      switch (reason.kind) {
        case 'completed':
          return makeCandidate('completed', key, frame.sessionId, 'Tugas Anda sudah selesai.')
        case 'blocked':
          return makeCandidate('attention', key, frame.sessionId, 'Tugas berhenti dan menunggu tindakan Anda.')
        case 'max-tokens':
          return makeCandidate('attention', key, frame.sessionId, 'Tugas berhenti karena batas panjang respons tercapai.')
        case 'aborted':
          return makeCandidate('failed', key, frame.sessionId, 'Tugas telah dibatalkan.')
        case 'error':
          return makeCandidate('failed', key, frame.sessionId, 'Tugas berhenti karena terjadi kendala.')
        case 'interrupted':
          return makeCandidate('failed', key, frame.sessionId, 'Tugas terhenti sebelum selesai.')
        default:
          // Extensions remain understandable without exposing their internal reason key.
          return makeCandidate('failed', key, frame.sessionId, 'Tugas berhenti sebelum selesai.')
      }
    }
    case 'approval/requested':
      return makeCandidate(
        'attention',
        `${frame.sessionId}:approval:${frame.approvalId}`,
        frame.sessionId,
        'Persetujuan Anda diperlukan untuk melanjutkan tugas.',
      )
    case 'question/requested':
      return makeCandidate(
        'attention',
        `${frame.sessionId}:question:${frame.questions.map(question => question.id).join(',')}`,
        frame.sessionId,
        'Jawaban Anda diperlukan untuk melanjutkan tugas.',
      )
    case 'host/agent-error':
      return makeCandidate(
        'failed',
        `${frame.sessionId}:agent-error:${rpcId}`,
        frame.sessionId,
        'Tugas berhenti karena terjadi kendala.',
      )
    case 'stream/error':
      if (frame.error === undefined || typeof frame.error !== 'object' || frame.error === null) {
        return makeCandidate('failed', `stream-error:${rpcId}`, undefined, 'Koneksi terputus. Buka Giana CoWork untuk melanjutkan.')
      }
      return makeCandidate(
        'failed',
        `stream-error:${rpcId}`,
        undefined,
        'Koneksi terputus. Buka Giana CoWork untuk melanjutkan.',
      )
    default:
      return undefined
  }
}

/**
 * Default sink: use the desktop host bridge, then an already-granted browser
 * notification. Permission requests belong to an explicit user interaction.
 */
export function createDesktopNotificationSink(): DesktopNotificationSink {
  return {
    notify(candidate) {
      const desktop = globals().__GIANA_DESKTOP__
      if (desktop !== undefined) {
        return Promise.resolve(desktop.notify(candidate)).then(result => result === true)
      }
      const Notification = globals().Notification
      if (Notification?.permission === 'granted') {
        new Notification(candidate.title, { body: candidate.body, tag: candidate.tag })
        return true
      }
      return false
    },
  }
}

function pageIsInactive(): boolean {
  const document = globals().document
  if (document === undefined) return true
  if (document.hidden === true || document.visibilityState === 'hidden') return true
  return typeof document.hasFocus === 'function' && !document.hasFocus()
}

export interface DesktopNotificationControllerOptions {
  readonly sink?: DesktopNotificationSink
  readonly shouldNotify?: () => boolean
  /** Injectable for tests; production uses the browser's durable local store. */
  readonly store?: DesktopNotificationStore
  /** Uses the sessions domain's canonical open operation; the desktop bridge only carries intent. */
  readonly openSession?: (sessionId: string) => void
}

/** Converts push frames into at-most-once notices while the app is unattended. */
export class DesktopNotificationController {
  private readonly sink: DesktopNotificationSink
  private readonly shouldNotify: () => boolean
  private readonly store: DesktopNotificationStore | undefined
  private readonly delivered: Set<string>
  private readonly pending = new Set<string>()
  private readonly releaseOpenSession: () => void
  private disposed = false

  constructor(options: DesktopNotificationControllerOptions = {}) {
    this.sink = options.sink ?? createDesktopNotificationSink()
    this.shouldNotify = options.shouldNotify ?? pageIsInactive
    this.store = options.store ?? defaultNotificationStore()
    this.delivered = restoreDelivered(this.store)
    const registerOpenSession = globals().__GIANA_DESKTOP__?.onOpenSession
    const release = options.openSession === undefined || registerOpenSession === undefined
      ? undefined
      : registerOpenSession((sessionId) => {
        if (!this.disposed) options.openSession?.(sessionId)
      })
    this.releaseOpenSession = typeof release === 'function' ? release : () => undefined
  }

  handle(envelope: DesktopNotificationEnvelope): boolean {
    if (this.disposed || !this.shouldNotify()) return false
    const candidate = classifyNotification(envelope.payload, String(envelope.rpcId))
    if (candidate === undefined || this.delivered.has(candidate.key) || this.pending.has(candidate.key)) return false
    this.pending.add(candidate.key)
    let result: boolean | Promise<boolean>
    try {
      result = this.sink.notify(candidate)
    } catch {
      this.pending.delete(candidate.key)
      return false
    }
    if (typeof result === 'boolean') {
      this.pending.delete(candidate.key)
      if (result === true) {
        this.delivered.add(candidate.key)
        persistDelivered(this.store, this.delivered)
      }
      return true
    }
    void Promise.resolve(result).then((accepted) => {
      this.pending.delete(candidate.key)
      if (accepted === true) {
        this.delivered.add(candidate.key)
        persistDelivered(this.store, this.delivered)
      }
    }).catch(() => {
      this.pending.delete(candidate.key)
    })
    return true
  }

  dispose(): void {
    this.disposed = true
    this.releaseOpenSession()
  }
}
