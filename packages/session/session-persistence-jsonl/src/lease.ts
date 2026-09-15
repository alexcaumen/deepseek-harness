/**
 * Kernel-backed cross-process write ownership for one JSONL session artifact.
 * POSIX holds a non-blocking flock on a stable lock-file inode; Windows holds
 * an exclusive kernel file handle with write sharing disabled. Process death
 * releases either primitive without stale-file recovery or an expiry window.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/lease
 */

import { mkdir, open, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type { PersistenceWriteLease } from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { acquireLockHandleWin32, releaseLockHandleWin32 } from './win32.ts'

/** Base name of the POSIX kernel lock file inside a session directory. */
export const LEASE_FILENAME = 'session.lock'

type HeldLock =
  | { readonly kind: 'posix'; readonly handle: FileHandle }
  | { readonly kind: 'win32'; readonly handle: number }

/** Promise face over fs-ext's callback flock. */
async function flockAsync(fd: number, flags: 'exnb'): Promise<void> {
  const { flock } = await import('fs-ext')
  await new Promise<void>((resolve, reject) => {
    flock(fd, flags, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/** Whether a non-blocking flock failed because another process holds it. */
function isLockContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EAGAIN' || code === 'EWOULDBLOCK'
}

/** One held kernel lease, released by closing its descriptor or object handle. */
export class SessionWriteLease implements PersistenceWriteLease {
  private released = false

  private constructor(private readonly held: HeldLock) {}

  /**
   * Acquire exclusive write ownership without waiting.
   * @param dir - deterministic session artifact directory.
   * @param id - session identity used by contention diagnostics.
   * @returns the held lease.
   * @throws {SessionAlreadyOwnedError} while another process owns the session.
   */
  static async acquire(dir: string, id: SessionId): Promise<SessionWriteLease> {
    const path = join(dir, LEASE_FILENAME)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    /* v8 ignore start -- native Windows coverage exercises this platform branch; POSIX covers its peer. */
    if (process.platform === 'win32') {
      try {
        return new SessionWriteLease({ kind: 'win32', handle: await acquireLockHandleWin32(path) })
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'EBUSY') {
          throw new SessionAlreadyOwnedError(id)
        }
        throw error
      }
    }
    /* v8 ignore stop */

    // A POSIX lock names an inode. Verify the locked inode is still present at
    // the path so unlink-and-recreate cannot split ownership between writers.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const handle = await open(path, 'a', 0o600)
      try {
        try {
          await flockAsync(handle.fd, 'exnb')
        } catch (error: unknown) {
          if (isLockContention(error)) throw new SessionAlreadyOwnedError(id)
          throw error
        }
        const held = await handle.stat({ bigint: true })
        const current = await stat(path, { bigint: true }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
          throw error
        })
        if (current !== undefined && current.ino === held.ino && current.dev === held.dev) {
          return new SessionWriteLease({ kind: 'posix', handle })
        }
      } catch (error: unknown) {
        await handle.close()
        throw error
      }
      await handle.close()
    }
    throw new SessionAlreadyOwnedError(id)
  }

  /** Release the kernel lease. Idempotent. */
  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    /* v8 ignore start -- native Windows coverage exercises this platform branch; POSIX covers its peer. */
    if (this.held.kind === 'win32') {
      releaseLockHandleWin32(this.held.handle)
      return
    }
    /* v8 ignore stop */
    await this.held.handle.close()
  }
}
