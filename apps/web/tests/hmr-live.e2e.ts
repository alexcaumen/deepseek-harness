/** Published dsh web + pnpm dev:web → browser HMR, with no page reload. */

import { existsSync, globSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  CLIENT_BUILD_RECORD_PATH, readClientBuildRecord,
} from '../../../scripts/client-build-environment.ts'
import { REPO_ROOT } from './support.ts'

function spawnSpec(argv: readonly string[], cwd: string, env?: Record<string, string>): SubprocessSpawnSpec {
  return {
    argv,
    cwd,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 5_000,
    ...env === undefined ? {} : { env },
  }
}

function pnpmDevWebArgv(): readonly string[] {
  return process.platform === 'win32'
    ? [process.env.ComSpec ?? 'cmd.exe', '/d', '/s', '/c', 'pnpm run dev:web']
    : ['pnpm', 'run', 'dev:web']
}

function waitForOutput(child: SubprocessHandle, pattern: RegExp, label: string): Promise<string> {
  return new Promise((resolveReady, reject) => {
    let output = ''
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
    }
    const resolveOnce = (value: string): void => {
      if (settled) return
      settled = true
      cleanup()
      resolveReady(value)
    }
    const rejectOnce = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onData = (chunk: Buffer): void => {
      output += chunk.toString()
      const match = pattern.exec(output)
      if (match === null) return
      resolveOnce(match[1] ?? match[0])
    }
    const timer = setTimeout(() => { rejectOnce(new Error(`${label} not ready:\n${output}`)) }, 60_000)
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    void child.done.then((outcome) => {
      rejectOnce(new Error(`${label} exited before ready (${JSON.stringify(outcome)}):\n${output}`))
    }, (error: unknown) => {
      rejectOnce(new Error(`${label} failed before ready:\n${output}`, { cause: error }))
    })
  })
}

async function stopTree(child: SubprocessHandle): Promise<void> {
  child.terminate()
  const stopped = await child.waitForExit(AbortSignal.timeout(15_000))
  if (!stopped) throw new Error(`process tree ${String(child.pid)} did not stop after termination escalation`)
  await child.done
}

function artifactPaths(): string[] {
  // dev:web runs tsc, both tsdown faces, and Vite. Preserve their intermediate
  // outputs too: restoring only client.js leaves the next build on HMR inputs.
  return globSync([
    'packages/*/*/lib/**/*',
    'vendor/*/lib/**/*',
    'apps/web/lib/**/*',
    'apps/web/dist/**/*',
    'tsconfig.client.tsbuildinfo',
  ], { cwd: REPO_ROOT })
    .map(path => join(REPO_ROOT, path))
    .filter(path => statSync(path).isFile())
}

it('hot-reloads a real client-plugin source edit without refreshing the page', async () => {
  const sourcePath = join(REPO_ROOT, 'packages/client/ui-conversation/src/client/locales.ts')
  const binPath = join(REPO_ROOT, 'apps/cli/lib/bin.js')
  const buildRecordPath = join(REPO_ROOT, CLIENT_BUILD_RECORD_PATH)
  if (!existsSync(binPath)) throw new Error('HMR browser test needs the built dsh bin; run pnpm run build first')
  const clientBuildEnvironment = readClientBuildRecord(REPO_ROOT).environment
  const originalArtifacts = new Map<string, Buffer>()
  for (const path of artifactPaths()) originalArtifacts.set(path, await readFile(path))
  const originalBuildRecord = await readFile(buildRecordPath)
  const originalSource = await readFile(sourcePath)
  const oldText = 'Giana CoWork'
  const sourceNeedle = "'hero.headline': 'Giana CoWork'"
  const newText = `HMR UPDATED ${'x'.repeat(80)}`
  const sourceText = originalSource.toString()
  const sourceIndex = sourceText.lastIndexOf(sourceNeedle)
  if (sourceIndex === -1) throw new Error(`HMR source lacks ${JSON.stringify(sourceNeedle)}`)
  const updatedSource = `${sourceText.slice(0, sourceIndex)}'hero.headline': '${newText}'${sourceText.slice(sourceIndex + sourceNeedle.length)}`

  const world = await mkdtemp(join(tmpdir(), 'dsh-web-hmr-world-'))
  const subprocessCtx = new Context()
  let subprocessFiber: Fiber | undefined
  let watcher: SubprocessHandle | undefined
  let host: SubprocessHandle | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  const failures: unknown[] = []
  try {
    subprocessFiber = await subprocessCtx.plugin(LocalSubprocessRuntime)
    watcher = subprocessCtx.subprocess.spawn(spawnSpec(
      pnpmDevWebArgv(),
      REPO_ROOT,
      { ...clientBuildEnvironment },
    ))
    await waitForOutput(watcher, /dev-web: watching/, 'pnpm run dev:web')
    host = subprocessCtx.subprocess.spawn(spawnSpec(
      [process.execPath, binPath, 'web', '--no-open', '--port', '0'],
      world,
      {
        DEEPSEEK_API_KEY: 'keyless-hmr-no-call',
        DSH_HOME: join(world, '.dsh'),
        DSH_MCP_TOOL_RUNTIME_PORT: '0',
      },
    ))
    const baseUrl = await waitForOutput(host, /dsh web: (http:\/\/[^\s]+)/, 'built dsh web')
    browser = await chromium.launch()
    const page = await browser.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(String(error)))
    await page.goto(baseUrl, { waitUntil: 'load' })
    await page.locator('div[data-phase="hero"]').getByText(oldText, { exact: true })
      .waitFor({ timeout: 15_000 })
    const pageIdentity = await page.evaluate(() => {
      const identity = crypto.randomUUID()
      Object.defineProperty(window, '__dshHmrPageIdentity', { value: identity })
      return identity
    })

    await writeFile(sourcePath, updatedSource)
    await page.getByText(newText, { exact: true }).waitFor({ timeout: 30_000 })
    expect(await page.evaluate(() => (window as Window & { __dshHmrPageIdentity?: string }).__dshHmrPageIdentity))
      .toBe(pageIdentity)
    expect(pageErrors).toEqual([])
  } catch (error) {
    failures.push(error)
  } finally {
    // Stop every writer before restoring source; a live watcher would rebuild
    // again on that write and could be terminated halfway through dist/index.html.
    if (watcher !== undefined) await stopTree(watcher).catch((error: unknown) => failures.push(error))
    await browser?.close().catch((error: unknown) => failures.push(error))
    if (host !== undefined) await stopTree(host).catch((error: unknown) => failures.push(error))
    await subprocessFiber?.dispose().catch((error: unknown) => failures.push(error))
    await writeFile(sourcePath, originalSource).catch((error: unknown) => failures.push(error))
    // Vite watch uses --no-emptyOutDir, so copying old files back alone leaves
    // newly hashed chunks in the digest. Remove only files absent at entry.
    try {
      for (const path of artifactPaths()) {
        if (!originalArtifacts.has(path)) await rm(path).catch((error: unknown) => failures.push(error))
      }
    } catch (error) {
      failures.push(error)
    }
    for (const [path, content] of originalArtifacts) {
      try {
        if (existsSync(path) && (await readFile(path)).equals(content)) continue
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content)
      } catch (error) {
        failures.push(error)
      }
    }
    await writeFile(buildRecordPath, originalBuildRecord).catch((error: unknown) => failures.push(error))
    try {
      readClientBuildRecord(REPO_ROOT)
    } catch (error) {
      failures.push(error)
    }
    await rm(world, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
  }
  if (failures.length > 0) throw new AggregateError(failures, 'HMR browser test or cleanup failed')
}, 120_000)
