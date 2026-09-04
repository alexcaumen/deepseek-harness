/** Regression coverage for the pinned sidebar's explicit-directory bypass. */
import { describe, expect, it, vi } from 'vitest'
import { wrapOpenPath } from 'dsh-better-sidebar/src/client/openpath-intercept.ts'

describe('sidebar file interception preserves directory opens', () => {
  it.each(['.', '..', '/', '/work/.', '/work/..', '/work/', 'N:\\work\\.', 'N:\\work\\..', 'N:\\', '\\\\server\\share\\'])
  ('forwards explicit directory %s to the host exactly once', async (path) => {
    const original = vi.fn(async function (this: unknown, _path: string) {
      expect(this).toBe(workspaces)
    })
    const workspaces = { openPath: original }
    const sidebar = vi.fn()
    const dispose = wrapOpenPath(workspaces, {
      takeoverEnabled: () => true,
      currentSessionId: () => 'session-1',
      openInSidebar: sidebar,
    })
    await workspaces.openPath(path)
    expect(original).toHaveBeenCalledExactlyOnceWith(path)
    expect(sidebar).not.toHaveBeenCalled()
    dispose()
    expect(workspaces.openPath).toBe(original)
  })

  it.each(['/work/file.ts', '/work/.env', '/work/../file.ts', 'N:\\work\\file.txt'])
  ('preserves editor takeover for file path %s', async (path) => {
    const original = vi.fn(async (_path: string) => {})
    const workspaces = { openPath: original }
    const sidebar = vi.fn()
    const dispose = wrapOpenPath(workspaces, {
      takeoverEnabled: () => true,
      currentSessionId: () => 'session-1',
      openInSidebar: sidebar,
    })
    await workspaces.openPath(path)
    expect(sidebar).toHaveBeenCalledExactlyOnceWith(path, 'session-1')
    expect(original).not.toHaveBeenCalled()
    dispose()
  })

  it('propagates a directory-open failure rather than reporting editor success', async () => {
    const error = new Error('host open failed')
    const original = vi.fn(async (_path: string) => { throw error })
    const workspaces = { openPath: original }
    const sidebar = vi.fn()
    const dispose = wrapOpenPath(workspaces, {
      takeoverEnabled: () => true,
      currentSessionId: () => 'session-1',
      openInSidebar: sidebar,
    })
    await expect(workspaces.openPath('/work/.')).rejects.toBe(error)
    expect(original).toHaveBeenCalledOnce()
    expect(sidebar).not.toHaveBeenCalled()
    dispose()
  })
})
