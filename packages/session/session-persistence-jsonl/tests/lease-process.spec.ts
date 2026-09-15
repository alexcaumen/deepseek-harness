import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const HOLDER = fileURLToPath(new URL('./fixtures/lease-holder.ts', import.meta.url))
const TSX_LOADER = import.meta.resolve('tsx/esm')
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-lease-'))
  dirs.push(root)
  return root
}

async function mount(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return ctx
}

function continuation(fromSeq: number): SessionEvent[] {
  return [
    { type: 'turn/start', seq: fromSeq, time: 3, data: { turn: 2 } },
    {
      type: 'turn/end',
      seq: fromSeq + 1,
      time: 4,
      data: { turn: 2, reason: { kind: 'completed' } },
    },
  ]
}

function startHolder(root: string, id: string): {
  child: ChildProcessWithoutNullStreams
  stderr: () => string
} {
  let errorOutput = ''
  const child = spawn(process.execPath, ['--import', TSX_LOADER, HOLDER, root, id], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { errorOutput += chunk })
  return { child, stderr: () => errorOutput }
}

async function waitForOutput(child: ChildProcessWithoutNullStreams, expected: RegExp, stderr: () => string): Promise<string> {
  const chunk = await new Promise<Buffer>((resolve, reject) => {
    const cleanup = (): void => {
      child.stdout.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    const onData = (data: Buffer): void => {
      cleanup()
      resolve(data)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup()
      reject(new Error(`holder exited before output (code ${String(code)}, signal ${String(signal)}): ${stderr()}`))
    }
    child.stdout.once('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
  const output = String(chunk).trim()
  if (!expected.test(output)) throw new Error(`unexpected holder output ${JSON.stringify(output)}; stderr: ${stderr()}`)
  return output
}

async function stopHolder(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGKILL')
  await once(child, 'exit')
}

describe('cross-process JSONL write lease', () => {
  it('excludes a live writer and permits immediate takeover after normal session close', { timeout: 30_000 }, async () => {
    const root = await createRoot()
    const id = SessionId('lease-normal-close')
    const holder = startHolder(root, id)
    let ctx: Context | undefined
    try {
      const holding = await waitForOutput(holder.child, /^holding:\d+$/, holder.stderr)
      const nextSeq = Number(holding.slice('holding:'.length))
      ctx = await mount(root)

      await expect(ctx.sessionPersistence.append(id, continuation(nextSeq)))
        .rejects.toBeInstanceOf(SessionAlreadyOwnedError)
      await expect(ctx.sessionPersistence.prepare(id))
        .rejects.toBeInstanceOf(SessionAlreadyOwnedError)
      expect(ctx.sessions.get(id)).toBeUndefined()

      holder.child.stdin.write('close\n')
      await waitForOutput(holder.child, /^closed$/, holder.stderr)
      const preparation = await ctx.sessionPersistence.prepare(id)
      preparation[Symbol.dispose]()
      await expect(ctx.sessionPersistence.append(id, continuation(nextSeq))).resolves.toBeUndefined()
      expect((await ctx.sessionPersistence.load(id)).events).toHaveLength(nextSeq + 2)
    } finally {
      await ctx?.fiber.dispose()
      await stopHolder(holder.child)
    }
  })

  it('excludes a live writer and permits immediate takeover after process crash', { timeout: 30_000 }, async () => {
    const root = await createRoot()
    const id = SessionId('lease-crash')
    const holder = startHolder(root, id)
    let ctx: Context | undefined
    try {
      const holding = await waitForOutput(holder.child, /^holding:\d+$/, holder.stderr)
      const nextSeq = Number(holding.slice('holding:'.length))
      ctx = await mount(root)

      await expect(ctx.sessionPersistence.append(id, continuation(nextSeq)))
        .rejects.toBeInstanceOf(SessionAlreadyOwnedError)

      holder.child.kill('SIGKILL')
      await once(holder.child, 'exit')
      await expect(ctx.sessionPersistence.append(id, continuation(nextSeq))).resolves.toBeUndefined()
      expect((await ctx.sessionPersistence.load(id)).events).toHaveLength(nextSeq + 2)
    } finally {
      await ctx?.fiber.dispose()
      await stopHolder(holder.child)
    }
  })

  it.runIf(process.platform === 'win32')(
    'treats a junction alias as the same physical Windows lock object',
    { timeout: 30_000 },
    async () => {
      const container = await createRoot()
      const physicalRoot = join(container, 'physical')
      const aliasRoot = join(container, 'alias')
      await mkdir(physicalRoot)
      await symlink(physicalRoot, aliasRoot, 'junction')
      const id = SessionId('lease-junction-alias')
      const holder = startHolder(physicalRoot, id)
      let ctx: Context | undefined
      try {
        await waitForOutput(holder.child, /^holding:\d+$/, holder.stderr)
        ctx = await mount(aliasRoot)

        await expect(ctx.sessionPersistence.prepare(id))
          .rejects.toBeInstanceOf(SessionAlreadyOwnedError)
        expect(ctx.sessions.get(id)).toBeUndefined()

        holder.child.kill('SIGKILL')
        await once(holder.child, 'exit')
        const preparation = await ctx.sessionPersistence.prepare(id)
        preparation[Symbol.dispose]()
      } finally {
        await ctx?.fiber.dispose()
        await stopHolder(holder.child)
      }
    },
  )
})
