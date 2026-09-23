import { describe, expect, it, vi } from 'vitest'
import type { ModelSelection, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { ModelDirectory } from '../src/client/directory.ts'

const sid = 'session' as SessionId

describe('ModelDirectory request ordering', () => {
  it('refreshes after a pending selection instead of projecting the old Host route', async () => {
    let current: ModelSelection = { provider: 'deepseek-official', model: 'chat' }
    let accept!: (response: { result: { ok: true; value: { selected: ModelSelection } } }) => void
    const pendingResponse = new Promise<{ result: { ok: true; value: { selected: ModelSelection } } }>(
      (resolve) => { accept = resolve },
    )
    const sessions = {
      models: vi.fn(async () => ({
        result: { ok: true as const, value: { current, routable: true, groups: [], failures: [] } },
      })),
      selectModel: vi.fn(() => pendingResponse),
    }
    const directory = new ModelDirectory(
      sessions as unknown as ConstructorParameters<typeof ModelDirectory>[0], sid, () => true,
    )
    await directory.load()

    const next: ModelSelection = { provider: 'local', model: 'putri' }
    const selecting = directory.select(next)
    const refreshing = directory.load()
    expect(sessions.models).toHaveBeenCalledTimes(1)

    current = next
    accept({ result: { ok: true, value: { selected: next } } })
    await selecting
    await refreshing
    expect(sessions.models).toHaveBeenCalledTimes(2)
    expect(directory.store.getSnapshot()).toMatchObject({ current: next, status: 'ready' })
    expect(sessions.selectModel).toHaveBeenCalledWith({
      sessionId: sid, provider: 'local', model: 'putri',
    })
  })

  it('serializes rapid selections so the later provider remains current', async () => {
    let releaseFirst!: () => void
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve })
    const sessions = {
      models: vi.fn(async () => ({
        result: {
          ok: true as const,
          value: {
            current: { provider: 'deepseek-official', model: 'chat' },
            routable: true, groups: [], failures: [],
          },
        },
      })),
      selectModel: vi.fn(async (payload: { provider: string; model: string }) => {
        if (payload.provider === 'local') await firstPending
        return { result: { ok: true as const, value: {
          selected: { provider: payload.provider, model: payload.model },
        } } }
      }),
    }
    const directory = new ModelDirectory(
      sessions as unknown as ConstructorParameters<typeof ModelDirectory>[0], sid, () => true,
    )
    const first = directory.select({ provider: 'local', model: 'putri' })
    const second = directory.select({ provider: 'deepseek-official', model: 'reasoner' })
    expect(sessions.selectModel).toHaveBeenCalledTimes(1)
    releaseFirst()
    await Promise.all([first, second])
    expect(sessions.selectModel).toHaveBeenCalledTimes(2)
    expect(directory.store.getSnapshot().current).toEqual({
      provider: 'deepseek-official', model: 'reasoner',
    })
  })
})
