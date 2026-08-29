import { describe, expect, it, vi } from 'vitest'
import type { HostFrame, MuxFrame } from '@deepseek-ai/dsh-api-remotes/client'
import {
  classifyNotification, DesktopNotificationController,
} from '../src/client/notifications.ts'

const sessionId = 'session-1' as never

function memoryStore() {
  const values = new Map<string, string>()
  return {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value) },
  }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

function envelope(payload: MuxFrame | HostFrame) {
  return { rpcId: 'rpc-1' as never, payload }
}

function turnEnd(reason: unknown): MuxFrame {
  return {
    type: 'session/event',
    sessionId,
    event: {
      type: 'turn/end',
      seq: 42,
      time: 1,
      data: { turn: 3, reason },
    },
  } as MuxFrame
}

describe('desktop notifications', () => {
  it('classifies durable completion, attention, and failure boundaries', () => {
    expect(classifyNotification(turnEnd({ kind: 'completed' }))?.kind).toBe('completed')
    expect(classifyNotification(turnEnd({ kind: 'completed' }))?.sessionId).toBe('session-1')
    expect(classifyNotification(turnEnd({ kind: 'blocked' }))?.kind).toBe('attention')
    expect(classifyNotification(turnEnd({ kind: 'error', error: { message: 'backend failed' } }))?.kind)
      .toBe('failed')
    expect(classifyNotification({
      type: 'approval/requested', sessionId, approvalId: 'approval-1' as never, toolName: 'terminal',
    })?.kind).toBe('attention')
    expect(classifyNotification({
      type: 'question/requested', sessionId,
      questions: [{ id: 'question-1', header: 'Confirm', options: [] }],
    } as never)?.kind).toBe('attention')
    expect(classifyNotification({ type: 'session-status', sessionId, running: false } as never)).toBeUndefined()
  })

  it('routes a typed host click to the registered session opener and releases it on disposal', () => {
    let listener: ((sessionId: string) => void) | undefined
    const release = vi.fn()
    const openSession = vi.fn()
    vi.stubGlobal('__GIANA_DESKTOP__', {
      notify: () => true,
      onOpenSession: (next: (sessionId: string) => void) => {
        listener = next
        return release
      },
    })
    try {
      const controller = new DesktopNotificationController({ openSession })
      listener?.('session-1')
      expect(openSession).toHaveBeenCalledWith('session-1')
      controller.dispose()
      expect(release).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('delivers an unattended event once and ignores duplicates', () => {
    const notify = vi.fn((_candidate: unknown) => true)
    const controller = new DesktopNotificationController({
      sink: { notify },
      shouldNotify: () => true,
    })
    const event = envelope(turnEnd({ kind: 'completed' }))

    expect(controller.handle(event)).toBe(true)
    expect(controller.handle(event)).toBe(false)
    expect(notify).toHaveBeenCalledOnce()
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ kind: 'completed', tag: expect.stringContaining('session-1') })
  })

  it('rehydrates delivered keys after a controller restart', () => {
    const notify = vi.fn(() => true)
    const store = memoryStore()
    const event = envelope(turnEnd({ kind: 'completed' }))
    const first = new DesktopNotificationController({
      sink: { notify },
      shouldNotify: () => true,
      store,
    })
    expect(first.handle(event)).toBe(true)
    first.dispose()

    const second = new DesktopNotificationController({
      sink: { notify },
      shouldNotify: () => true,
      store,
    })
    expect(second.handle(event)).toBe(false)
    expect(notify).toHaveBeenCalledOnce()
  })

  it('does not notify while focused and does not notify after disposal', () => {
    const notify = vi.fn(() => true)
    const controller = new DesktopNotificationController({
      sink: { notify },
      shouldNotify: () => false,
    })
    const event = envelope(turnEnd({ kind: 'completed' }))

    expect(controller.handle(event)).toBe(false)
    expect(notify).not.toHaveBeenCalled()
    controller.dispose()
    expect(controller.handle(event)).toBe(false)
  })

  it('does not commit rejected async delivery and allows a later retry', async () => {
    const store = memoryStore()
    let rejectFirst!: (accepted: boolean) => void
    const firstAttempt = new Promise<boolean>((resolve) => { rejectFirst = resolve })
    const notify = vi.fn()
      .mockReturnValueOnce(firstAttempt)
      .mockResolvedValueOnce(true)
    const controller = new DesktopNotificationController({
      sink: { notify },
      shouldNotify: () => true,
      store,
    })
    const event = envelope(turnEnd({ kind: 'completed' }))

    expect(controller.handle(event)).toBe(true)
    expect(controller.handle(event)).toBe(false)
    expect(store.getItem('giana.code.putri.notifications.delivered.v1')).toBeNull()

    rejectFirst(false)
    await settle()
    expect(controller.handle(event)).toBe(true)
    await settle()
    expect(controller.handle(event)).toBe(false)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(store.getItem('giana.code.putri.notifications.delivered.v1')).toContain('session-1:turn-end:42')
  })

  it('allows retry after a rejected sink promise', async () => {
    const notify = vi.fn()
      .mockRejectedValueOnce(new Error('synthetic host failure'))
      .mockResolvedValueOnce(true)
    const controller = new DesktopNotificationController({
      sink: { notify },
      shouldNotify: () => true,
    })
    const event = envelope(turnEnd({ kind: 'completed' }))

    expect(controller.handle(event)).toBe(true)
    await settle()
    expect(controller.handle(event)).toBe(true)
    await settle()
    expect(controller.handle(event)).toBe(false)
    expect(notify).toHaveBeenCalledTimes(2)
  })
})
