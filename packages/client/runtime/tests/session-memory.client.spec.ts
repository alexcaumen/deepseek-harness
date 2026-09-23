import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { Session } from '../src/client/sessions/session.ts'
import { resolveHistoryBudget } from '../src/client/sessions/history-budget.ts'
import { FakeApiClient, deferred, fakeRemote, ok } from './fake-api.client.ts'
import { ev } from './event-script.client.ts'

const sid = 'memory-test' as never
function raw(session: Session) {
  return session as unknown as { events: SessionEvent[]; views: unknown[]; conversation: { inputs: Map<number, unknown> } }
}
function send(session: Session, event: SessionEvent) {
  session.handleMuxEnvelope('audit' as never, { type: 'session/event', sessionId: sid, event })
}
function create(maxHistoryEvents = 20, maxHistoryChars = 100_000) {
  const api = new FakeApiClient()
  const session = new Session(sid, api, fakeRemote(), { historyBudget: { maxHistoryEvents, maxHistoryChars } })
  return { api, session }
}

describe('browser history lifetime', () => {
  it('evicts completed steps while a long turn continues and keeps a contiguous tail', async () => {
    const { session } = create()
    await session.open()
    let seq = 0
    send(session, ev.turnStart(seq++, 0))
    for (let step = 0; step < 1000; step++) {
      send(session, ev.stepStart(seq++, 0, step))
      send(session, ev.chunkText(seq++, 0, `text-${step}`, step))
      send(session, ev.assistant(seq++, 0, `text-${step}`, step))
      send(session, ev.stepEnd(seq++, 0, step))
      expect(raw(session).events.length).toBeLessThanOrEqual(20)
    }
    const events = raw(session).events
    expect(events[0]!.type).toBe('step/start')
    expect(events.map(event => event.seq)).toEqual(Array.from({ length: events.length }, (_, i) => events[0]!.seq + i))
    expect(raw(session).conversation.inputs.size).toBe(events.length)
    expect(session.getSnapshot().hasMore).toBe(true)
  })

  it('releases an oversized completed payload on the next step, not half a tool exchange', async () => {
    const { session } = create(1000, 1500)
    await session.open()
    const events = [ev.stepStart(0, 0), ev.toolCall(1, 0, 'c', 'read', '{}'), ev.toolResult(2, 0, 'c', 'x'.repeat(6000)), ev.stepEnd(3, 0)]
    events.forEach(event => send(session, event))
    expect(raw(session).events).toEqual(events)
    send(session, ev.stepStart(4, 0, 1))
    expect(raw(session).events.map(event => event.seq)).toEqual([4])
    expect(session.getSnapshot().hasMore).toBe(true)
  })

  it('retains a single in-flight group until a safe boundary exists', async () => {
    const { session } = create(3)
    await session.open()
    send(session, ev.stepStart(0, 0))
    for (let seq = 1; seq < 50; seq++) send(session, ev.chunkText(seq, 0, 'x'))
    expect(raw(session).events).toHaveLength(50)
    send(session, ev.assistant(50, 0, 'x'.repeat(49)))
    send(session, ev.stepEnd(51, 0))
    send(session, ev.stepStart(52, 0, 1))
    expect(raw(session).events.map(event => event.seq)).toEqual([52])
  })

  it('bounds a large initial history page and permits paging the evicted prefix', async () => {
    const { api, session } = create(6)
    const log = Array.from({ length: 6 }, (_, step) => [ev.stepStart(step * 2, 0, step), ev.stepEnd(step * 2 + 1, 0, step)]).flat()
    api.onHistory = () => Promise.resolve(ok({ events: log.map(event => ({ event })) as never[], hasMore: false }))
    await session.open()
    expect(raw(session).events.map(event => event.seq)).toEqual([10, 11])
    api.onHistory = (request) => {
      expect(request.beforeSeq).toBe(10)
      return Promise.resolve(ok({ events: log.slice(8, 10).map(event => ({ event })) as never[], hasMore: true }))
    }
    await session.loadOlder()
    expect(raw(session).events.map(event => event.seq)).toEqual([8, 9, 10, 11])
  })

  it('suspends display history without cancelling the task or losing approvals', async () => {
    const { api, session } = create()
    await session.open()
    send(session, ev.stepStart(0, 0))
    session.handleRunning(true)
    session.handleMuxEnvelope('approval' as never, { type: 'approval/requested', sessionId: sid, approvalId: 'a' as never, toolName: 'write' })
    session.suspendHistory()
    send(session, ev.chunkText(1, 0, 'offscreen'))
    expect(raw(session).events).toEqual([])
    expect(raw(session).conversation.inputs.size).toBe(0)
    expect(session.getSnapshot()).toMatchObject({ openState: 'cold', running: true })
    expect(session.getSnapshot().pending).toHaveLength(1)
    expect(api.calls.map(call => call.method)).toEqual(['session.history'])
    await session.open()
    expect(api.calls.map(call => call.method)).toEqual(['session.history', 'session.history'])
  })

  it('ignores an old paging response after suspension and reopening', async () => {
    const { api, session } = create()
    api.onHistory = () => Promise.resolve(ok({ events: [{ event: ev.stepStart(20, 0) }] as never[], hasMore: true }))
    await session.open()
    const waiting = deferred<ReturnType<typeof ok<{ events: never[]; hasMore: boolean }>>>()
    api.onHistory = () => waiting.promise
    const older = session.loadOlder()
    session.suspendHistory()
    api.onHistory = () => Promise.resolve(ok({ events: [{ event: ev.stepStart(40, 0, 1) }] as never[], hasMore: true }))
    await session.open()
    waiting.resolve(ok({ events: [{ event: ev.stepEnd(19, 0) }] as never[], hasMore: true }))
    await older
    expect(raw(session).events.map(event => event.seq)).toEqual([40])
  })

  it.each([false, true])('ignores paging from an evicted boundary (empty=%s)', async (empty) => {
    const { api, session } = create(4)
    api.onHistory = () => Promise.resolve(ok({ events: [{ event: ev.stepStart(20, 0) }] as never[], hasMore: true }))
    await session.open()
    const waiting = deferred<ReturnType<typeof ok<{ events: never[]; hasMore: boolean }>>>()
    api.onHistory = () => waiting.promise
    const older = session.loadOlder()
    for (let seq = 21; seq <= 25; seq++) send(session, ev.stepStart(seq, 0, seq))
    const boundary = raw(session).events[0]!.seq
    expect(boundary).toBeGreaterThan(20)
    waiting.resolve(ok({ events: empty ? [] : [{ event: ev.stepEnd(19, 0) }] as never[], hasMore: false }))
    await older
    expect(session.getSnapshot()).toMatchObject({ hasMore: true, loadingOlder: false })
    api.onHistory = (request) => {
      expect(request.beforeSeq).toBe(boundary)
      return Promise.resolve(ok({ events: [{ event: ev.stepEnd(boundary - 1, 0) }] as never[], hasMore: true }))
    }
    await session.loadOlder()
    expect(raw(session).events[0]!.seq).toBe(boundary - 1)
  })

  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid retention options: %s', (value) => {
    expect(() => resolveHistoryBudget({ maxHistoryEvents: value })).toThrow(RangeError)
    expect(() => resolveHistoryBudget({ maxHistoryChars: value })).toThrow(RangeError)
  })
})
