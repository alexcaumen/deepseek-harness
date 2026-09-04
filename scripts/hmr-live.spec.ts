import { PassThrough } from 'node:stream'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { readClientBuildRecord, writeClientBuildRecord } from './client-build-environment.ts'

const harness = vi.hoisted(() => ({
  root: '',
  run: undefined as (() => Promise<void>) | undefined,
  spawn: vi.fn(),
  dispose: vi.fn(),
  launch: vi.fn(),
}))

// Register the real HMR callback without putting a browser test in the host lane.
vi.mock('vitest', () => ({
  expect,
  it: (_name: string, run: () => Promise<void>) => { harness.run = run },
}))
vi.mock('../apps/web/tests/support.ts', () => ({
  get REPO_ROOT() { return harness.root },
}))
// Playwright belongs to apps/web, not the root scripts package. Match its ESM entry.
vi.mock('../apps/web/node_modules/playwright/index.mjs', () => ({ chromium: { launch: harness.launch } }))
vi.mock('@deepseek-ai/dsh-subprocess-local', () => ({ default: vi.fn() }))
vi.mock('@deepseek-ai/cordis', () => ({
  Context: class {
    subprocess = { spawn: harness.spawn }
    async plugin() { return { dispose: harness.dispose } }
  },
}))

const sourcePath = 'packages/client/ui-conversation/src/client/locales.ts'
const originalSource = "// Existing uncommitted edit must survive.\nexport const en = { 'hero.headline': 'Giana CoWork' }\n"
const originals: Record<string, string> = {
  [sourcePath]: originalSource,
  'apps/cli/lib/bin.js': '// built host\n',
  'apps/web/dist/index.html': '<html><head></head><body><div id="root"></div></body></html>',
  'apps/web/dist/assets/index-original.js': 'original shell',
  'apps/web/dist/assets/fonts/original.woff2': 'original font',
  'packages/client/ui-conversation/lib/client.js': 'original dynamic bundle',
  'packages/client/ui-conversation/lib/client.js.map': 'original dynamic map',
  'packages/client/ui-conversation/lib/types/client/locales.js': 'original type emit',
  'packages/client/ui-conversation/lib/tsconfig.tsbuildinfo': 'original incremental state',
  'packages/client/web/lib/index.js': 'original linked shell',
  'packages/client/ui-theme/lib/index.js': 'original host half',
  'packages/core/session/lib/types/index.js': 'original shared type emit',
  'vendor/cordis/lib/index.js': 'original vendored emit',
  'apps/web/lib/types/main.js': 'original app emit',
  'tsconfig.client.tsbuildinfo': 'original aggregate state',
}
const addedPaths = [
  'apps/web/dist/assets/index-hmr.js',
  'packages/client/web/lib/added.js.map',
]
let sourceAtStop: string | undefined
let failBrowser = false
let failStartup = false
let originalRecord: Buffer

function write(path: string, content: string): void {
  const absolute = join(harness.root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

function rebuild(): void {
  for (const path of Object.keys(originals)) {
    if (path !== sourcePath && path !== 'apps/cli/lib/bin.js') write(path, `HMR ${path}`)
  }
  for (const path of addedPaths) write(path, 'new hashed artifact')
  rmSync(join(harness.root, 'apps/web/dist/assets/fonts/original.woff2'))
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  harness.root = await mkdtemp(join(tmpdir(), 'dsh-hmr-restore-test-'))
  harness.run = undefined
  sourceAtStop = undefined
  failBrowser = false
  failStartup = false
  for (const [path, content] of Object.entries(originals)) write(path, content)
  writeClientBuildRecord(harness.root, { DSH_CLIENT_COMMIT_HASH: '8fb269f' })
  originalRecord = readFileSync(join(harness.root, '.dsh-build/client-build-environment.json'))

  let spawns = 0
  harness.dispose.mockResolvedValue(undefined)
  harness.spawn.mockImplementation(() => {
    const watcher = spawns++ === 0
    if (watcher) rebuild()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let finish: (() => void) | undefined
    const done = new Promise<void>((resolve) => { finish = resolve })
    queueMicrotask(() => {
      if (watcher && failStartup) finish?.()
      else stdout.write(watcher ? 'dev-web: watching' : 'dsh web: http://127.0.0.1:1234')
    })
    return {
      pid: watcher ? 1 : 2,
      stdout,
      stderr,
      done,
      terminate: () => {
        if (watcher) {
          sourceAtStop = readFileSync(join(harness.root, sourcePath), 'utf8')
          rebuild()
        }
        finish?.()
      },
      waitForExit: async () => { await done; return true },
    }
  })
  harness.launch.mockResolvedValue({
    close: async () => {},
    newPage: async () => ({
      on: () => {},
      goto: async () => {},
      locator: () => ({ getByText: () => ({ waitFor: async () => {} }) }),
      evaluate: async () => 'same-page-identity',
      getByText: () => ({ waitFor: async () => {
        expect(readFileSync(join(harness.root, sourcePath), 'utf8')).toContain('HMR UPDATED')
        if (failBrowser) throw new Error('simulated browser failure')
      } }),
    }),
  })
  await import('../apps/web/tests/hmr-live.e2e.ts')
})

afterEach(async () => {
  await rm(harness.root, { recursive: true, force: true })
})

function expectRestored(): void {
  for (const [path, content] of Object.entries(originals)) {
    expect(readFileSync(join(harness.root, path), 'utf8'), path).toBe(content)
  }
  for (const path of addedPaths) expect(existsSync(join(harness.root, path)), path).toBe(false)
  expect(readFileSync(join(harness.root, '.dsh-build/client-build-environment.json'))).toEqual(originalRecord)
  expect(readClientBuildRecord(harness.root).environment).toEqual({ DSH_CLIENT_COMMIT_HASH: '8fb269f' })
  expect(harness.dispose).toHaveBeenCalledOnce()
}

test('restores the full artifact chain and digest after HMR, stopping writers before source restoration', async () => {
  await harness.run!()
  expectRestored()
  expect(sourceAtStop).toContain('HMR UPDATED')
})

test('restores artifacts and the pre-existing source edit when the browser scenario fails', async () => {
  failBrowser = true
  await expect(harness.run!()).rejects.toThrow('HMR browser test or cleanup failed')
  expectRestored()
})

test('restores initial rebuild artifacts when the watcher exits before readiness', async () => {
  failStartup = true
  await expect(harness.run!()).rejects.toThrow('HMR browser test or cleanup failed')
  expectRestored()
  expect(harness.launch).not.toHaveBeenCalled()
})

test('keeps the HMR regression in the host compiler and outside the web client project', () => {
  const specPath = resolve(import.meta.dirname, 'hmr-live.spec.ts').replaceAll('\\', '/')
  for (const [configPath, included] of [
    ['../tsconfig.host.json', true],
    ['../tsconfig.client.json', false],
    ['../apps/web/tsconfig.json', false],
  ] as const) {
    const config = ts.getParsedCommandLineOfConfigFile(resolve(import.meta.dirname, configPath), {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      },
    })
    expect(config?.errors, configPath).toEqual([])
    expect(config?.fileNames.includes(specPath), configPath).toBe(included)
  }
})
