// Keyless replay of a real two-round Goal run. Each autonomous round ends as
// its own turn, so the first answer must keep its IconActions when Goal opens
// round two and the final answer must own a second, distinct action row.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-goal'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/goal-multi-turn-actions', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
const OVERRIDE = join(SNAPSHOT_DIR, 'replay.override.json')
const UI_EXPECTED = join(
  SNAPSHOT_DIR,
  process.platform === 'win32' ? 'ui.windows.expected.md' : 'ui.expected.md',
)
const MODE = webSnapshotMode()

const PROMPT = '做两个turn，每个turn输出随机一个包的文件结构。注意你做完一个turn之后，直接输出内容，停止，我们的系统会帮你再开一个turn，你看着做一个类似的'
const COMMAND = `/goal ${PROMPT}`

const PACKAGE_FILES: Readonly<Record<string, string>> = {
  'packages/client/ui-conversation/README.md': '# UI conversation\n',
  'packages/client/ui-conversation/package.json': '{"name":"@deepseek-ai/dsh-client-ui-conversation"}\n',
  'packages/client/ui-conversation/src/client.ts': 'export {}\n',
  'packages/client/ui-conversation/tests/chat-view.client.spec.tsx': 'export {}\n',
  'packages/context/session-reference/README.md': '# Session reference\n',
  'packages/context/session-reference/package.json': '{"name":"@deepseek-ai/dsh-session-reference"}\n',
  'packages/context/session-reference/src/index.ts': 'export {}\n',
  'packages/context/session-reference/src/uri.ts': 'export {}\n',
  'packages/context/session-reference/tests/session-reference.spec.ts': 'export {}\n',
  'packages/llm/token-meter/README.md': '# Token meter\n',
  'packages/llm/token-meter/package.json': '{"name":"@deepseek-ai/dsh-token-meter"}\n',
  'packages/llm/token-meter/src/index.ts': 'export {}\n',
  'packages/llm/token-meter/tests/token-meter.spec.ts': 'export {}\n',
  'packages/skill/skill-filesystem/README.md': '# Local skill provider\n',
  'packages/skill/skill-filesystem/package.json': '{"name":"@deepseek-ai/dsh-skill-filesystem"}\n',
  'packages/skill/skill-filesystem/src/index.ts': 'export {}\n',
  'packages/skill/skill-filesystem/src/invariant.ts': 'export {}\n',
  'packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts': 'export {}\n',
}

/** A successful Windows-native equivalent for each recorded POSIX shell step. */
function windowsCommand(description: string): string {
  if (description.includes('session-reference')) {
    return "Get-ChildItem 'packages/context/session-reference' -File -Recurse | ForEach-Object { $_.FullName }"
  }
  if (description.includes('token-meter')) {
    return "Get-ChildItem 'packages/llm/token-meter' -File -Recurse | ForEach-Object { $_.FullName }"
  }
  if (description.includes('Re-roll') || description.includes('another package')) {
    return "Write-Output 'packages/llm/token-meter'"
  }
  if (description.includes('Randomly')) {
    return "Write-Output 'packages/context/session-reference'"
  }
  if (description.includes('packages directory')) {
    return "Get-ChildItem 'packages' -Directory; Get-ChildItem 'packages' -Directory -Recurse -Depth 1"
  }
  return 'Get-Location; Get-ChildItem -Force'
}

/** Rewrite only recorded shell-call leaves; the canonical fixture stays byte-identical. */
function windowsReplayValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(windowsReplayValue)
  if (value === null || typeof value !== 'object') return value
  const input = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(input)) output[key] = windowsReplayValue(child)
  if (output.name === 'bash') output.name = 'pwsh'
  for (const key of ['arguments', 'argumentsDelta'] as const) {
    const encoded = output[key]
    if (typeof encoded !== 'string') continue
    try {
      const args = JSON.parse(encoded) as { command?: unknown; description?: unknown }
      if (typeof args.command === 'string' && typeof args.description === 'string') {
        args.command = windowsCommand(args.description)
        output[key] = JSON.stringify(args)
      }
    } catch {
      // Incremental argument fragments are left intact; replay uses complete assistant chunks.
    }
  }
  return output
}

/** Materialize Windows-only replay copies in the OS temp directory. */
async function windowsReplayCopies(home: string): Promise<{ fixture: string; override: string }> {
  const fixture = join(home, 'session.windows.jsonl')
  const sourceLines = (await readFile(FIXTURE, 'utf8')).split(/\r?\n/u).filter(Boolean)
  const rewritten = sourceLines.map(line => JSON.stringify(windowsReplayValue(JSON.parse(line)))).join('\n') + '\n'
  await writeFile(fixture, rewritten)
  const override = join(home, 'replay.windows.override.json')
  const overrideDoc = JSON.parse(await readFile(OVERRIDE, 'utf8')) as unknown
  await writeFile(override, JSON.stringify(windowsReplayValue(overrideDoc)))
  return { fixture, override }
}

/** Materialize a stable package inventory inside the isolated session workspace. */
async function seedPackageInventory(workspaceRoot: string): Promise<void> {
  for (const [relativePath, content] of Object.entries(PACKAGE_FILES)) {
    const path = join(workspaceRoot, 'workspace', relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
}

/** Await exactly the requested number of durable turn ends, then flush the session. */
function whenTurnsSettled(scaffold: WebScaffold, count: number, timeoutMs: number): Promise<SessionId> {
  return new Promise<SessionId>((resolve, reject) => {
    let completed = 0
    const timer = setTimeout(() => {
      off()
      reject(new Error(`only ${completed}/${count} Goal turns ended within ${timeoutMs}ms`))
    }, timeoutMs)
    const off = scaffold.ctx.on('session/event', (session, event: SessionEvent) => {
      if (event.type !== 'turn/end') return
      completed += 1
      if (completed !== count) return
      clearTimeout(timer)
      off()
      scaffold.ctx.sessions.flush(session).then(() => { resolve(session.id) }, reject)
    })
  })
}

/** Goal-owned round numbers in durable user-message order. */
function goalRounds(events: readonly SessionEvent[]): number[] {
  return events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'goal'
    ? [event.data.source.round]
    : [])
}

/** Objective written by each durable Goal creation. */
function createdObjectives(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => event.type === 'goal/change' && event.data.operation === 'create'
    ? [event.data.goal.objective]
    : [])
}

describe('web e2e: Goal keeps one assistant action row per completed turn', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let sessionEvents: SessionEvent[]
  let sidecarDir: string | undefined

  afterEach(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    browser = undefined
    const closing = scaffold
    scaffold = undefined
    await closing?.close().catch((error: unknown) => failures.push(error))
    if (sidecarDir !== undefined) {
      await rm(sidecarDir, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    }
    sidecarDir = undefined
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'goal-multi-turn-actions teardown failed')
  })

  /** Boot the real Web composition and connect a fresh package fixture workspace. */
  async function launch(): Promise<void> {
    sessionEvents = []
    let replayFixture = FIXTURE
    let replayOverride = OVERRIDE
    if (MODE !== 'record' && process.platform === 'win32') {
      sidecarDir = await mkdtemp(join(tmpdir(), 'dsh-web-goal-windows-'))
      const copies = await windowsReplayCopies(sidecarDir)
      replayFixture = copies.fixture
      replayOverride = copies.override
    }
    scaffold = await launchWebScaffold(
      MODE === 'record' ? {} : { replayFixture, replayOverride },
    )
    await seedPackageInventory(scaffold.workspaceCwd)
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }

  /** Submit the Goal command after arming the two-turn barrier. */
  async function runGoal(timeoutMs: number): Promise<SessionId> {
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = whenTurnsSettled(scaffold!, 2, timeoutMs)
    await input.fill(COMMAND)
    await input.press('Enter')
    return settled
  }

  it.skipIf(MODE !== 'record')('records the two-round Goal through the real model', async () => {
    await launch()
    onTestFailed(() => saveFailureShot(page, 'web-e2e-goal-multi-turn-actions-record'))
    const sessionId = await runGoal(360_000)
    await recordFixture(scaffold!, sessionId, FIXTURE)
  }, 380_000)

  it.skipIf(MODE === 'record')('keeps actions on both completed Goal turn tails', async () => {
    const fixtureEvents = parseSessionLog(await readFile(FIXTURE, 'utf8'))
    expect(createdObjectives(fixtureEvents)).toEqual([PROMPT])
    expect(goalRounds(fixtureEvents)).toEqual([1, 2])

    await launch()
    onTestFailed(() => saveFailureShot(page, 'web-e2e-goal-multi-turn-actions'))
    await runGoal(120_000)

    expect(sessionEvents.flatMap(event => event.type === 'turn/end' ? [event.data.turn] : []))
      .toEqual([1, 2])
    expect(goalRounds(sessionEvents)).toEqual([1, 2])
    const branchButtons = page.getByRole('button', { name: 'Branch into a new conversation' })
    await expect.poll(() => branchButtons.count(), { timeout: 15_000 }).toBe(2)
    expect(await branchButtons.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-disabled'))))
      .toEqual([null, null])
    expect(await page.getByText(/unknown tool/u).count()).toBe(0)
    expect(await page.getByRole('button', { name: /^Failed /u }).count()).toBe(0)
    await branchButtons.last().focus()
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold!.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 140_000)

  it.skipIf(MODE === 'record')('keeps a closed fixture inventory', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'replay.override.json', 'session.jsonl', 'ui.expected.md', 'ui.windows.expected.md',
    ])
  })
})
