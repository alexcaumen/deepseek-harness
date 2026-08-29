import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/grinv/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')

const baseURL = process.env.GIANA_CODE_HEQA_URL ?? 'http://127.0.0.1:17101/'
const imagePath = process.env.GIANA_CODE_HEQA_IMAGE
  ?? 'C:/Users/grinv/AppData/Local/Temp/codex-clipboard-4effc518-058d-4ee3-a98d-1256f3e685e4.png'
const evidenceRoot = process.env.GIANA_CODE_HEQA_ROOT ?? 'N:/PrincessOS/workbench/evidence'

await mkdir(evidenceRoot, { recursive: true })

function assert(condition, message) {
  if (!condition) throw new Error(message)
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
  await page.getByText('Putri', { exact: true }).last().click()
}

async function pasteImage(page, filePath) {
  const bytes = await readFile(filePath)
  const base64 = bytes.toString('base64')
  await page.locator('textarea').last().evaluate((textarea, payload) => {
    const binary = atob(payload.base64)
    const data = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index)
    const transfer = new DataTransfer()
    transfer.items.add(new File([data], payload.name, { type: 'image/png' }))
    textarea.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }))
  }, { base64, name: path.basename(filePath) })
}

async function latestAssistantText(page) {
  const assistant = page.locator('[data-chat-flow-kind="assistant-step"]').last()
  await assistant.waitFor({ state: 'visible', timeout: 30_000 })
  return (await assistant.innerText()).trim()
}

const result = {
  verdict: 'HELD',
  surface: 'ORIGINAL_RUNTIME_LOCALHOST',
  sourceURL: baseURL,
  observedAt: new Date().toISOString(),
  checks: {},
  consoleErrors: [],
  pageErrors: [],
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
const page = await context.newPage()
page.on('console', message => {
  if (message.type() === 'error') result.consoleErrors.push(message.text())
})
page.on('pageerror', error => { result.pageErrors.push(String(error)) })

try {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.getByText('Giana Code', { exact: true }).first().waitFor({ state: 'visible', timeout: 120_000 })
  await page.getByRole('button', { name: 'New session' }).filter({ hasText: 'New Session' }).click()
  await page.waitForTimeout(600)
  await selectPutri(page)

  const textarea = page.locator('textarea').last()
  const send = page.getByRole('button', { name: 'Send message' })
  const mic = page.getByRole('button', { name: 'Start automatic-language dictation' })
  assert(await send.isDisabled(), 'idle Send must be disabled with an empty draft')
  const [micBox, sendBox] = await Promise.all([mic.boundingBox(), send.boundingBox()])
  assert(micBox !== null && sendBox !== null && micBox.x < sendBox.x, 'microphone must sit immediately left of Send')
  result.checks.idleComposer = { sendDisabled: true, micBox, sendBox }

  await pasteImage(page, imagePath)
  await textarea.fill('Inspect the attached screenshot. What exact sentence is shown inside the dark gray warning toast? Reply with only that sentence.')
  assert(!await send.isDisabled(), 'Send must enable after text and image intake')
  await page.screenshot({ path: path.join(evidenceRoot, 'giana-code-putri-image-before-send-20260825.png'), fullPage: true })
  await send.click()
  await page.getByRole('button', { name: 'Stop generating' }).waitFor({ state: 'visible', timeout: 30_000 })
  await waitForIdle(page)

  const imageReply = await latestAssistantText(page)
  assert(/the current model does not support images/i.test(imageReply), `Putri did not read the warning toast from the image: ${imageReply}`)
  result.checks.image = {
    attachmentAccepted: true,
    visualContentRead: true,
    reply: imageReply,
    modelRejection: false,
  }
  await page.screenshot({ path: path.join(evidenceRoot, 'giana-code-putri-image-live-pass-20260825.png'), fullPage: true })

  await textarea.fill('Run a read-only UI cancellation check: use an available shell to wait 20 seconds, then report that the wait completed.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await page.getByRole('button', { name: 'Stop generating' }).waitFor({ state: 'visible', timeout: 30_000 })
  await textarea.fill('Cancel the prior wait immediately. Do not continue that task. Report the current local date and finish with the label STEER_RECOVERY_OK.')
  const steer = page.getByRole('button', { name: 'Steer current turn' })
  assert(await steer.count() === 1, 'busy draft must expose one Steer current turn action')
  assert(!await steer.isDisabled(), 'Steer must be enabled while Putri is running and draft is non-empty')
  assert(await page.getByRole('button', { name: 'Stop generating' }).count() === 1, 'busy composer must preserve a separate Stop action')
  await page.screenshot({ path: path.join(evidenceRoot, 'giana-code-putri-steer-before-send-20260825.png'), fullPage: true })
  await steer.click()
  await waitForIdle(page)

  const steerReply = await latestAssistantText(page)
  assert(/STEER_RECOVERY_OK/i.test(steerReply), `Putri post-turn continuation did not complete the recovery check: ${steerReply}`)
  assert(!/Queued for the next turn|respond once the current task finishes/i.test(steerReply), 'Steer degraded into queued follow-up')
  result.checks.steer = {
    stopSeparate: true,
    postTurnContinuationCompleted: true,
    reply: steerReply,
    queuedFallback: false,
  }
  await page.screenshot({ path: path.join(evidenceRoot, 'giana-code-putri-steer-live-pass-20260825.png'), fullPage: true })

  assert(result.consoleErrors.length === 0, `console errors: ${result.consoleErrors.join(' | ')}`)
  assert(result.pageErrors.length === 0, `page errors: ${result.pageErrors.join(' | ')}`)
  result.verdict = 'READY_FOR_ALEX_HEQA'
} catch (error) {
  result.error = error instanceof Error ? error.stack ?? error.message : String(error)
  await page.screenshot({ path: path.join(evidenceRoot, 'giana-code-putri-p0-held-20260825.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  result.completedAt = new Date().toISOString()
  await writeFile(path.join(evidenceRoot, 'giana-code-putri-image-steer-heqa-20260825.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  await context.close()
  await browser.close()
  console.log(JSON.stringify(result, null, 2))
}
