import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const baseURL = process.env.GIANA_CODE_HEQA_URL ?? 'http://127.0.0.1:18101/'
const evidenceRoot = process.env.GIANA_CODE_HEQA_ROOT
  ?? 'N:/PrincessOS/workbench/evidence/giana-code-putri-annotation-copy'
const sourceToken = `ANNOTATION_SOURCE_${Date.now().toString(36).toUpperCase()}`

function assert(condition, code) {
  if (!condition) throw new Error(code)
}

async function waitForIdle(page, timeout = 180_000) {
  await page.getByRole('button', { name: 'Stop generating' }).waitFor({ state: 'detached', timeout })
  await page.waitForTimeout(500)
}

async function selectPutri(page) {
  const current = page.getByRole('button', { name: /^Putri(?:\s|$)/ }).last()
  if (await current.count()) return
  const modelButton = page.locator('[data-composer-trailing] button').filter({ hasText: /Putri|DeepSeek|Qwen/ }).first()
  await modelButton.click()
  const putri = page.getByText('Putri', { exact: true }).last()
  if (!await putri.isVisible().catch(() => false)) {
    await page.getByText(/Qwen3\.8-27B/, { exact: true }).last().click()
  }
  await putri.waitFor({ state: 'visible', timeout: 30_000 })
  await putri.click()
}

async function latestSettledText(page) {
  const assistant = page.locator('[data-chat-flow-kind="assistant-step"]').last()
  const settled = assistant.locator('[data-assistant-status="settled"]')
  await settled.waitFor({ state: 'visible', timeout: 30_000 })
  const blocks = await settled.locator('[data-assistant-block-kind="text"]').allInnerTexts()
  return blocks.map(value => value.trim().replace(/\s+/g, ' ')).filter(Boolean).join('\n\n')
}

async function selectLatestAnswer(page) {
  const block = page.locator(
    '[data-chat-flow-kind="assistant-step"] [data-assistant-status="settled"] [data-assistant-block-kind="text"]',
  ).last()
  await block.evaluate((element) => {
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(element)
    selection?.removeAllRanges()
    selection?.addRange(range)
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }))
  })
}

async function run() {
  const { chromium } = require('C:/Users/grinv/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
  await mkdir(evidenceRoot, { recursive: true })
  const result = {
    verdict: 'HELD',
    observedAt: new Date().toISOString(),
    sourceToken,
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
    await page.getByText('Giana Code Putri', { exact: true }).first().waitFor({ timeout: 120_000 })
    await page.getByRole('button', { name: 'New session' }).filter({ hasText: 'New Session' }).click()
    await page.waitForTimeout(600)
    await selectPutri(page)

    const textarea = page.locator('textarea').last()
    await textarea.fill(`Reply with exactly this token and nothing else: ${sourceToken}`)
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.getByRole('button', { name: 'Stop generating' }).waitFor({ state: 'visible', timeout: 30_000 })
    await waitForIdle(page)
    assert(await latestSettledText(page) === sourceToken, 'ANNOTATION_SOURCE_REPLY_MISMATCH')

    await selectLatestAnswer(page)
    const addToChat = page.getByRole('button', { name: 'Add to chat' })
    await addToChat.waitFor({ state: 'visible', timeout: 10_000 })
    await addToChat.click()
    const draftWithAnnotation = await textarea.inputValue()
    assert(draftWithAnnotation.includes('@Annotation 1'), 'ANNOTATION_REFERENCE_NOT_INSERTED')
    assert(await page.getByText('Annotation 1', { exact: true }).count() > 0, 'ANNOTATION_CHIP_NOT_VISIBLE')

    await textarea.focus()
    await textarea.press('End')
    await textarea.type(' Return only the selected text from Annotation 1.')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.getByRole('button', { name: 'Stop generating' }).waitFor({ state: 'visible', timeout: 30_000 })
    await waitForIdle(page)
    const annotationReply = await latestSettledText(page)
    assert(annotationReply === sourceToken, 'ANNOTATION_MODEL_REPLY_MISMATCH')
    result.checks.annotation = {
      selectionToolbarVisible: true,
      annotationNumber: 1,
      modelFacingReplyExact: true,
    }

    const assistant = page.locator('[data-chat-flow-kind="assistant-step"]').last()
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
    assert(clipboard.trim() === sourceToken, 'ANNOTATION_COPY_FALLBACK_MISMATCH')
    result.checks.copy = { asyncClipboardDenied: true, fallbackExact: true }

    assert(result.consoleErrors.length === 0, 'ANNOTATION_BROWSER_CONSOLE_ERRORS')
    assert(result.pageErrors.length === 0, 'ANNOTATION_BROWSER_PAGE_ERRORS')
    result.verdict = 'READY_FOR_ALEX_HEQA'
    await page.screenshot({ path: path.join(evidenceRoot, 'giana-code-putri-annotation-copy-pass.png'), fullPage: true })
  } catch (error) {
    result.failureCode = error instanceof Error ? error.message : String(error)
    await page.screenshot({ path: path.join(evidenceRoot, 'giana-code-putri-annotation-copy-held.png'), fullPage: true }).catch(() => {})
    throw error
  } finally {
    result.completedAt = new Date().toISOString()
    await writeFile(path.join(evidenceRoot, 'giana-code-putri-annotation-copy-heqa.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    await context.close()
    await browser.close()
    console.log(JSON.stringify({ verdict: result.verdict, failureCode: result.failureCode ?? null }, null, 2))
  }
}

await run()
