import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/grinv/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')

const baseURL = process.env.GIANA_CODE_HEQA_URL ?? 'http://127.0.0.1:17101/'
const evidenceRoot = process.env.GIANA_CODE_HEQA_ROOT ?? 'N:/PrincessOS/workbench/evidence'
await mkdir(evidenceRoot, { recursive: true })

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitForIdle(page, timeout = 180_000) {
  await page.getByRole('button', { name: 'Stop generating' }).waitFor({ state: 'detached', timeout })
  await page.waitForTimeout(500)
}

const result = {
  verdict: 'HELD',
  surface: 'GIANA_CODE_ACTIVE_DESKTOP_BACKEND',
  sourceURL: baseURL,
  sessionTitle: 'Kirana',
  observedAt: new Date().toISOString(),
  checks: {},
  consoleErrors: [],
  pageErrors: [],
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL).origin })
const page = await context.newPage()
page.on('console', message => {
  if (message.type() === 'error') result.consoleErrors.push(message.text())
})
page.on('pageerror', error => { result.pageErrors.push(String(error)) })

try {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.getByText('Giana Code Putri', { exact: true }).first().waitFor({ state: 'visible', timeout: 120_000 })
  const moreSessions = page.getByRole('button', { name: /Show \d+ more sessions/ }).first()
  await moreSessions.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
  if (await moreSessions.isVisible().catch(() => false)) {
    await moreSessions.click()
    await page.waitForTimeout(500)
  }
  const kirana = page.getByText('Kirana', { exact: true }).first()
  await kirana.waitFor({ state: 'visible', timeout: 60_000 })
  await kirana.click()
  await page.waitForTimeout(750)

  const textarea = page.locator('textarea').last()
  await textarea.fill('Read-only recovery check: report the current local date, then finish with the label KIRANA_RECOVERY_OK.')
  const send = page.getByRole('button', { name: 'Send message' })
  assert(!await send.isDisabled(), 'Kirana composer did not accept a fresh message')
  await send.click()
  await page.getByRole('button', { name: 'Stop generating' }).waitFor({ state: 'visible', timeout: 30_000 })
  await waitForIdle(page)

  const assistant = page.locator('[data-chat-flow-kind="assistant-step"]').last()
  await assistant.waitFor({ state: 'visible', timeout: 30_000 })
  const reply = (await assistant.innerText()).trim()
  assert(/KIRANA_RECOVERY_OK/i.test(reply), `Kirana did not complete the recovery check: ${reply}`)
  assert(!/Queued for the next turn|respond once the current task finishes/i.test(reply), 'Kirana still degraded into a queued follow-up')
  result.checks.kirana = { exactSessionSelected: true, freshTurnCompleted: true, queuedFallback: false, reply }

  await assistant.hover()
  await page.evaluate(() => {
    const prototype = Object.getPrototypeOf(navigator.clipboard)
    Object.defineProperty(prototype, 'writeText', {
      configurable: true,
      value: () => Promise.reject(new DOMException('Simulated desktop WebView denial', 'NotAllowedError')),
    })
  })
  const copy = page.getByRole('button', { name: /^(Copy|复制)$/ }).last()
  await copy.waitFor({ state: 'visible', timeout: 10_000 })
  await copy.click()
  await page.waitForTimeout(250)
  const clipboard = await page.evaluate(() => navigator.clipboard.readText())
  assert(clipboard.includes('KIRANA_RECOVERY_OK'), `clipboard fallback copied the wrong content: ${clipboard}`)
  result.checks.copy = { asyncClipboardDenied: true, fallbackSucceeded: true, copiedCharacters: clipboard.length }

  assert(result.consoleErrors.length === 0, `console errors: ${result.consoleErrors.join(' | ')}`)
  assert(result.pageErrors.length === 0, `page errors: ${result.pageErrors.join(' | ')}`)
  result.verdict = 'READY_FOR_ALEX_HEQA'
  await page.screenshot({ path: path.join(evidenceRoot, 'giana-code-kirana-copy-recovery-pass-20260827.png'), fullPage: true })
} catch (error) {
  result.error = error instanceof Error ? error.stack ?? error.message : String(error)
  await page.screenshot({ path: path.join(evidenceRoot, 'giana-code-kirana-copy-recovery-held-20260827.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  result.completedAt = new Date().toISOString()
  await writeFile(path.join(evidenceRoot, 'giana-code-kirana-copy-recovery-heqa-20260827.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  await context.close()
  await browser.close()
  console.log(JSON.stringify(result, null, 2))
}
