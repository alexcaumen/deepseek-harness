import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const baseURL = process.env.GIANA_CODE_HEQA_URL ?? 'http://127.0.0.1:18101/'
const evidenceRoot = process.env.GIANA_CODE_HEQA_ROOT
  ?? 'N:/worktrees/deepseek-harness/giana-code-putri-20260827/.artifacts/m5-putri-native-tools'
const dshHome = process.env.GIANA_CODE_HEQA_HOME
  ?? 'C:/Users/grinv/.dsh-giana-code-putri-clean-20260827'

class HeqaAssertionError extends Error {
  constructor(code) {
    super(code)
    this.name = 'HeqaAssertionError'
    this.code = code
  }
}

function assert(condition, code) {
  if (!condition) throw new HeqaAssertionError(code)
}

async function selectPutri(page) {
  const current = page.getByRole('button', { name: /^Putri(?:\s|$)/ }).last()
  if (await current.count()) return
  const modelButton = page.locator('[data-composer-trailing] button').filter({ hasText: /Putri|DeepSeek|Qwen/ }).first()
  await modelButton.click()
  const putri = page.getByText('Putri', { exact: true }).last()
  await putri.waitFor({ state: 'visible', timeout: 30_000 })
  await putri.click()
}

async function waitForIdle(page, timeout = 300_000) {
  await page.getByRole('button', { name: 'Stop generating' }).waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByRole('button', { name: 'Stop generating' }).waitFor({ state: 'detached', timeout })
  await page.waitForTimeout(500)
}

async function latestAssistantTextBlocks(page) {
  const settled = page.locator(
    '[data-chat-flow-kind="assistant-step"] [data-assistant-status="settled"]',
  ).last()
  await settled.waitFor({ state: 'visible', timeout: 30_000 })
  return (await settled.locator('[data-assistant-block-kind="text"]').allInnerTexts())
    .map(value => value.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
}

async function newestSessionLogContaining(needle) {
  const root = path.join(dshHome, 'sessions')
  const pending = [root]
  const candidates = []
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) pending.push(target)
      else if (entry.isFile() && entry.name === 'session.jsonl.zstd') {
        candidates.push({ target, modified: (await stat(target)).mtimeMs })
      }
    }
  }
  candidates.sort((left, right) => right.modified - left.modified)
  for (const candidate of candidates.slice(0, 20)) {
    const text = execFileSync('zstd.exe', ['-q', '-dc', '--', candidate.target], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
    if (text.includes(needle)) return { path: candidate.target, text }
  }
  throw new HeqaAssertionError('CANARY_SESSION_LOG_NOT_FOUND')
}

function completedGoal(cache, objective) {
  const pending = [cache]
  while (pending.length > 0) {
    const value = pending.pop()
    if (value === null || typeof value !== 'object') continue
    if (value.objective === objective && value.phase === 'complete' && value.revision === 2) return value
    pending.push(...Object.values(value))
  }
  return undefined
}

async function run() {
  const { chromium } = require('C:/Users/grinv/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
  const nonce = `NATIVE_${Date.now().toString(36).toUpperCase()}`
  const expectedReply = `PUTRI_NATIVE_TOOLS_PASS_${nonce}`
  const objective = `${nonce} native capability canary`
  const markerPath = path.join(evidenceRoot, `${nonce}.txt`)
  const expectedTools = [
    'mcp__giana_code_tool_runtime__create_goal',
    'mcp__giana_code_tool_runtime__get_goal',
    'mcp__giana_code_tool_runtime__pwsh',
    'mcp__giana_code_tool_runtime__skill_search',
    'mcp__giana_code_tool_runtime__skill',
    'mcp__giana_code_tool_runtime__update_goal',
  ]
  const result = {
    schema: 'giana-code-putri/native-tools-heqa/v1',
    verdict: 'HELD',
    observedAt: new Date().toISOString(),
    baseURL,
    nonce,
    expectedTools,
    checks: {},
  }
  const consoleErrors = []
  const pageErrors = []
  let browser
  let context
  let page
  let failure

  await mkdir(evidenceRoot, { recursive: true })
  try {
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    page = await context.newPage()
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', error => { pageErrors.push(String(error)) })

    await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByText('Giana Code Putri', { exact: true }).first().waitFor({ state: 'visible', timeout: 120_000 })
    await page.getByRole('button', { name: 'New session' }).filter({ hasText: 'New Session' }).click()
    await page.waitForTimeout(600)
    await selectPutri(page)

    const prompt = [
      'Run a controlled candidate-only capability canary.',
      'Use these exact Giana Code MCP tools in this exact order:',
      `1. mcp__giana_code_tool_runtime__create_goal with objective "${objective}".`,
      '2. mcp__giana_code_tool_runtime__get_goal.',
      `3. mcp__giana_code_tool_runtime__pwsh to run: [IO.File]::WriteAllText('${markerPath.replaceAll("'", "''")}', '${nonce}'); Write-Output ${nonce}.`,
      '4. mcp__giana_code_tool_runtime__skill_search with query "define-goal".',
      '5. mcp__giana_code_tool_runtime__skill with name "define-goal".',
      '6. mcp__giana_code_tool_runtime__update_goal with status "complete".',
      'Do not substitute your native terminal or native goal helpers.',
      `Only after all six calls succeed, reply with exactly ${expectedReply} and nothing else.`,
    ].join('\n')
    const textarea = page.locator('textarea').last()
    await textarea.fill(prompt)
    await page.getByRole('button', { name: 'Send message' }).click()
    await waitForIdle(page)

    const finalTextBlocks = await latestAssistantTextBlocks(page)
    const finalReply = finalTextBlocks.join('\n\n')
    const finalTokenCount = finalReply.split(expectedReply).length - 1
    const sessionLog = await newestSessionLogContaining(nonce)
    const activityCount = (sessionLog.text.match(/Giana Code tool started\./g) ?? []).length
    const goalCache = JSON.parse(await readFile(path.join(dshHome, 'storages', 'session_projcache.json'), 'utf8'))
    const goal = completedGoal(goalCache, objective)
    const marker = await readFile(markerPath, 'utf8').catch(() => '')
    result.checks = {
      goalLifecyclePersisted: goal !== undefined,
      terminalSideEffectPersisted: marker === nonce,
      remoteToolActivityObserved: activityCount >= expectedTools.length,
      exactlyOneFinalTextBlock: finalTextBlocks.length === 1,
      finalTokenAppearsOnceAtEnd: finalTokenCount === 1 && finalReply.endsWith(expectedReply),
      noConsoleErrors: consoleErrors.length === 0,
      noPageErrors: pageErrors.length === 0,
    }
    result.evidence = {
      sessionLogPath: sessionLog.path,
      toolActivityCount: activityCount,
      persistedGoal: goal,
      terminalMarkerPath: markerPath,
      finalTextBlocks,
      finalTokenCount,
    }
    assert(result.checks.goalLifecyclePersisted, 'GOAL_LIFECYCLE_SIDE_EFFECT_NOT_PERSISTED')
    assert(result.checks.terminalSideEffectPersisted, 'TERMINAL_SIDE_EFFECT_NOT_PERSISTED')
    assert(result.checks.remoteToolActivityObserved, 'REMOTE_TOOL_ACTIVITY_NOT_OBSERVED')
    assert(result.checks.exactlyOneFinalTextBlock, 'NATIVE_TOOL_CANARY_FINAL_BLOCK_COUNT_MISMATCH')
    assert(result.checks.finalTokenAppearsOnceAtEnd, 'NATIVE_TOOL_CANARY_FINAL_TOKEN_MISMATCH')
    assert(result.checks.noConsoleErrors, 'BROWSER_CONSOLE_ERRORS_OBSERVED')
    assert(result.checks.noPageErrors, 'BROWSER_PAGE_ERRORS_OBSERVED')
    result.verdict = 'READY_FOR_ALEX_HEQA'
    await page.screenshot({ path: path.join(evidenceRoot, 'giana-code-putri-native-tools-pass.png'), fullPage: true })
  } catch (error) {
    failure = error
    result.failureCode = error instanceof HeqaAssertionError ? error.code : 'HEQA_EXECUTION_ERROR'
    await page?.screenshot({ path: path.join(evidenceRoot, 'giana-code-putri-native-tools-held.png'), fullPage: true }).catch(() => {})
  } finally {
    result.completedAt = new Date().toISOString()
    result.runtimeErrors = { console: consoleErrors, page: pageErrors }
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
    await writeFile(
      path.join(evidenceRoot, 'giana-code-putri-native-tools-heqa.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    )
    console.log(JSON.stringify({ verdict: result.verdict, failureCode: result.failureCode ?? null }, null, 2))
  }

  if (failure) throw failure
}

await run()
