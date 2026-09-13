import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { ServerManagerOperation, ServerManagerTransport } from './index.ts'

/** Deployment-owned command. Never populate this from a model or request payload. */
export interface ServerManagerStdioOptions {
  readonly executable: string
  readonly args: readonly string[]
  /** Explicit process environment; ambient application credentials are not inherited. */
  readonly env: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly maxOperationMs: number
  readonly maxFrameBytes?: number
  readonly maxPendingRequests?: number
  readonly closeTimeoutMs?: number
}

/** Transport failures never include child output, commands, or private lease payloads. */
export class ServerManagerTransportError extends Error {
  constructor(readonly code: 'INVALID_CONFIG' | 'UNAVAILABLE' | 'TARGET_UNAVAILABLE' | 'PROTOCOL_INVALID' | 'ABORTED' | 'TIMEOUT' | 'QUEUE_FULL') {
    super(`Local model controller transport: ${code}`)
    this.name = 'ServerManagerTransportError'
  }
}

interface Pending {
  readonly operation: ServerManagerOperation
  settle(error: ServerManagerTransportError | undefined, value?: unknown): void
  readonly timer: ReturnType<typeof setTimeout>
  readonly removeAbort: () => void
}

function boundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

/**
 * Lazy, multiplexed JSON-lines connection to the existing Server Manager service.
 * No process or resource is touched at construction. Renewals can complete while
 * a slow model-start stage is running. There is no automatic retry or reconnect:
 * a lost reply cannot be treated as evidence that a physical action did not occur.
 */
export class ServerManagerStdioTransport implements ServerManagerTransport {
  private readonly options: ServerManagerStdioOptions
  private readonly maxFrameBytes: number
  private readonly maxPendingRequests: number
  private readonly closeTimeoutMs: number
  private child: ChildProcessWithoutNullStreams | undefined
  private exited: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private closed = false
  private buffer = Buffer.alloc(0)
  private readonly pending = new Map<string, Pending>()

  constructor(options: ServerManagerStdioOptions) {
    this.maxFrameBytes = options.maxFrameBytes ?? 262_144
    this.maxPendingRequests = options.maxPendingRequests ?? 32
    this.closeTimeoutMs = options.closeTimeoutMs ?? 2_000
    if (!isAbsolute(options.executable)
      || !boundedInteger(options.maxOperationMs, 1, 2_147_483_647)
      || !boundedInteger(this.maxFrameBytes, 128, 16_777_216)
      || !boundedInteger(this.maxPendingRequests, 1, 256)
      || !boundedInteger(this.closeTimeoutMs, 1, 60_000)
      || options.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
      || Object.entries(options.env).some(([key, value]) => !key || key.includes('=') || key.includes('\0') || value.includes('\0'))) {
      throw new ServerManagerTransportError('INVALID_CONFIG')
    }
    this.options = { ...options, args: [...options.args], env: { ...options.env } }
  }

  async invoke(operation: ServerManagerOperation, envelope: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new ServerManagerTransportError('ABORTED')
    if (this.closed) throw new ServerManagerTransportError('UNAVAILABLE')
    const reserved = (candidate: ServerManagerOperation): boolean => ['renew', 'release', 'cancel-clean'].includes(candidate)
    const occupied = [...this.pending.values()].filter(pending => reserved(operation)
      ? pending.operation === operation
      : !reserved(pending.operation)).length
    // Unknown model-stage outcomes may fill the normal queue, but cannot consume
    // the separately bounded renewal and cleanup lanes needed for reconciliation.
    if (occupied >= (reserved(operation) ? 1 : this.maxPendingRequests)) throw new ServerManagerTransportError('QUEUE_FULL')
    const timeoutMs = envelope.timeout_ms
    if (typeof timeoutMs !== 'number' || !boundedInteger(timeoutMs, 1, this.options.maxOperationMs)) {
      throw new ServerManagerTransportError('INVALID_CONFIG')
    }
    const id = randomUUID()
    let frame: string
    try { frame = JSON.stringify({ id, operation, envelope }) + '\n' } catch {
      throw new ServerManagerTransportError('PROTOCOL_INVALID')
    }
    if (Buffer.byteLength(frame) > this.maxFrameBytes) throw new ServerManagerTransportError('PROTOCOL_INVALID')
    const child = this.connect()
    return new Promise((resolve, reject) => {
      let settled = false
      const settle: Pending['settle'] = (error, value) => {
        if (settled) return
        settled = true
        if (error !== undefined) reject(error)
        else resolve(value)
      }
      // Keep cancelled ids until their reply/connection closure. A late physical
      // settlement must not be mistaken for a response to a subsequent request.
      const aborted = (): void => { settle(new ServerManagerTransportError('ABORTED')) }
      const timer = setTimeout(() => { settle(new ServerManagerTransportError('TIMEOUT')) }, timeoutMs)
      this.pending.set(id, { operation, settle, timer, removeAbort: () => { signal.removeEventListener('abort', aborted) } })
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) {
        this.finish(id, new ServerManagerTransportError('ABORTED'))
        return
      }
      child.stdin.write(frame, (error) => {
        if (error) this.fail(new ServerManagerTransportError('UNAVAILABLE'))
      })
    })
  }

  /** Close and await the transport child, not an assertion of remote GPU cleanup. */
  close(): Promise<void> {
    this.closing ??= this.closeChild()
    return this.closing
  }

  private connect(): ChildProcessWithoutNullStreams {
    if (this.child !== undefined) return this.child
    const child = spawn(this.options.executable, [...this.options.args], {
      cwd: this.options.cwd, env: { ...this.options.env }, shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.exited = new Promise(resolve => child.once('close', () => {
      this.fail(new ServerManagerTransportError('UNAVAILABLE'))
      resolve()
    }))
    child.on('error', () => { this.fail(new ServerManagerTransportError('UNAVAILABLE')) })
    child.stdin.on('error', () => { this.fail(new ServerManagerTransportError('UNAVAILABLE')) })
    child.stdout.on('data', (chunk: Buffer) => { this.receive(chunk) })
    // Drain but never retain or display potentially private backend diagnostics.
    child.stderr.resume()
    return child
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return
    let offset = 0
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset)
      const part = chunk.subarray(offset, end === -1 ? chunk.length : end)
      if (this.buffer.length + part.length > this.maxFrameBytes) {
        this.fail(new ServerManagerTransportError('PROTOCOL_INVALID'))
        return
      }
      this.buffer = Buffer.concat([this.buffer, part])
      if (end === -1) return
      const frame = this.buffer
      this.buffer = Buffer.alloc(0)
      offset = end + 1
      try {
        const result: unknown = JSON.parse(frame.toString('utf8'))
        if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error('frame')
        const record = result as Record<string, unknown>
        if (typeof record.id !== 'string' || !this.pending.has(record.id)
          || (Object.hasOwn(record, 'result') === Object.hasOwn(record, 'error'))) throw new Error('frame')
        let error: ServerManagerTransportError | undefined
        if (Object.hasOwn(record, 'error')) {
          const payload = record.error
          error = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
            && (payload as Record<string, unknown>).code === 'TARGET_UNAVAILABLE'
            ? new ServerManagerTransportError('TARGET_UNAVAILABLE')
            : new ServerManagerTransportError('UNAVAILABLE')
        }
        this.finish(record.id, error, record.result)
      } catch {
        this.fail(new ServerManagerTransportError('PROTOCOL_INVALID'))
        return
      }
    }
  }

  private finish(id: string, error?: ServerManagerTransportError, value?: unknown): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.removeAbort()
    pending.settle(error, value)
  }

  private fail(error: ServerManagerTransportError): void {
    this.closed = true
    this.buffer = Buffer.alloc(0)
    for (const id of this.pending.keys()) this.finish(id, error)
  }

  private async closeChild(): Promise<void> {
    this.fail(new ServerManagerTransportError('UNAVAILABLE'))
    const child = this.child
    const exited = this.exited
    if (child === undefined || exited === undefined) return
    child.stdin.end()
    const wait = async (): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          exited.then(() => true),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false) }, this.closeTimeoutMs) }),
        ])
      } finally { clearTimeout(timer) }
    }
    if (await wait()) return
    child.kill('SIGKILL')
    if (!await wait()) throw new ServerManagerTransportError('UNAVAILABLE')
  }
}
