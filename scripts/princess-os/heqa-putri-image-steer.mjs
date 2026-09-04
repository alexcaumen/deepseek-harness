import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

const baseURL = process.env.GIANA_CODE_HEQA_URL ?? 'http://127.0.0.1:17101/'
const defaultImagePath = 'C:/Users/grinv/AppData/Local/Temp/codex-clipboard-4effc518-058d-4ee3-a98d-1256f3e685e4.png'
const evidenceRoot = process.env.GIANA_CODE_HEQA_ROOT ?? 'N:/PrincessOS/workbench/evidence'

const MODEL_REJECTION_PATTERNS = [
  /\b(?:current|selected|this)\s+model\b[\s\S]{0,80}\b(?:does\s+not|doesn't|cannot|can't|is\s+unable\s+to)\b[\s\S]{0,80}\b(?:support|accept|process|view|see|read|inspect|analy[sz]e)\b[\s\S]{0,40}\b(?:images?|screenshots?|visuals?|attachments?)\b/i,
  /\b(?:i|we)\b[\s\S]{0,20}\b(?:cannot|can't|am\s+unable\s+to|are\s+unable\s+to|do\s+not\s+have)\b[\s\S]{0,60}\b(?:view|see|read|inspect|analy[sz]e|process|access)\b[\s\S]{0,40}\b(?:images?|screenshots?|visuals?|attachments?)\b/i,
  /\b(?:image|vision|visual)\s+(?:input|support|capabilit(?:y|ies))\b[\s\S]{0,40}\b(?:unavailable|unsupported|disabled|not\s+supported)\b/i,
]

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

function normalizeVisualFact(value) {
  return String(value).trim().replace(/\s+/g, ' ')
}

export function isModelRejection(reply) {
  return MODEL_REJECTION_PATTERNS.some(pattern => pattern.test(String(reply)))
}

export function evaluateVisualReply(reply, expectedAnswer) {
  if (isModelRejection(reply)) {
    return { valid: false, failureCode: 'VISUAL_MODEL_REJECTION' }
  }
  if (normalizeVisualFact(reply) !== normalizeVisualFact(expectedAnswer)) {
    return { valid: false, failureCode: 'VISUAL_FACT_MISMATCH' }
  }
  return { valid: true, failureCode: null }
}

export function joinAssistantTextBlocks(blocks) {
  return blocks.map(normalizeVisualFact).filter(Boolean).join('\n\n')
}

function resolveVisualChallenge() {
  const configuredImagePath = process.env.GIANA_CODE_HEQA_IMAGE?.trim()
  const configuredQuestion = process.env.GIANA_CODE_HEQA_VISUAL_QUESTION?.trim()
  const configuredExpectedAnswer = process.env.GIANA_CODE_HEQA_VISUAL_EXPECTED?.trim()
  const hasQuestion = Boolean(configuredQuestion)
  const hasExpectedAnswer = Boolean(configuredExpectedAnswer)

  assert(hasQuestion === hasExpectedAnswer, 'VISUAL_CHALLENGE_INCOMPLETE')
  assert(!configuredImagePath || (hasQuestion && hasExpectedAnswer), 'CUSTOM_IMAGE_VISUAL_CHALLENGE_REQUIRED')

  return {
    imagePath: configuredImagePath ?? defaultImagePath,
    question: configuredQuestion
      ?? "Inspect the attached screenshot. What exact four-word heading appears at the top left, immediately before 'PTC mode'? Reply with only that heading.",
    expectedAnswer: configuredExpectedAnswer ?? 'All Fix By Putri',
    source: configuredQuestion ? 'configured' : 'default',
  }
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
  const settled = assistant.locator('[data-assistant-status="settled"]')
  await settled.waitFor({ state: 'visible', timeout: 30_000 })
  const textBlocks = settled.locator('[data-assistant-block-kind="text"]')
  await textBlocks.first().waitFor({ state: 'visible', timeout: 30_000 })
  return joinAssistantTextBlocks(await textBlocks.allInnerTexts())
}

async function settledAssistantTexts(page) {
  const settled = page.locator(
    '[data-chat-flow-kind="assistant-step"] [data-assistant-status="settled"]',
  )
  const values = []
  for (let index = 0; index < await settled.count(); index += 1) {
    const blocks = settled.nth(index).locator('[data-assistant-block-kind="text"]')
    values.push(joinAssistantTextBlocks(await blocks.allInnerTexts()))
  }
  return values
}

function occurrenceCount(value, pattern) {
  return value.match(pattern)?.length ?? 0
}

async function run() {
  const { chromium } = require('C:/Users/grinv/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
  const visualChallenge = resolveVisualChallenge()
  await mkdir(evidenceRoot, { recursive: true })

  const result = {
    verdict: 'HELD',
    surface: 'ORIGINAL_RUNTIME_LOCALHOST',
    observedAt: new Date().toISOString(),
    checks: {},
  }
  const consoleErrors = []
  const pageErrors = []
  let browser
  let context
  let page
  let failure

  try {
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    page = await context.newPage()
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', error => { pageErrors.push(String(error)) })

    await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.getByText('Giana CoWork', { exact: true }).first().waitFor({ state: 'visible', timeout: 120_000 })
    await page.getByRole('button', { name: 'New session' }).filter({ hasText: 'New Session' }).click()
    await page.waitForTimeout(600)
    await selectPutri(page)

    const textarea = page.locator('textarea').last()
    const send = page.getByRole('button', { name: 'Send message' })
    const mic = page.getByRole('button', { name: 'Start automatic-language dictation' })
    assert(await send.isDisabled(), 'IDLE_SEND_MUST_BE_DISABLED')
    const [micBox, sendBox] = await Promise.all([mic.boundingBox(), send.boundingBox()])
    assert(micBox !== null && sendBox !== null && micBox.x < sendBox.x, 'COMPOSER_CONTROL_ORDER_INVALID')
    result.checks.idleComposer = { sendDisabled: true, micBox, sendBox }

    await pasteImage(page, visualChallenge.imagePath)
    await textarea.fill(visualChallenge.question)
    assert(!await send.isDisabled(), 'SEND_DISABLED_AFTER_IMAGE_INTAKE')
    await page.screenshot({ path: path.join(evidenceRoot, 'giana-code-putri-image-before-send-20260825.png'), fullPage: true })
    await send.click()
    await page.getByRole('button', { name: 'Stop generating' }).waitFor({ state: 'visible', timeout: 30_000 })
    await waitForIdle(page)

    const imageReply = await latestAssistantText(page)
    const imageEvaluation = evaluateVisualReply(imageReply, visualChallenge.expectedAnswer)
    assert(imageEvaluation.valid, imageEvaluation.failureCode)
    result.checks.image = {
      attachmentAccepted: true,
      visualFactVerified: true,
      modelRejection: false,
      challengeSource: visualChallenge.source,
    }
    await page.screenshot({ path: path.join(evidenceRoot, 'giana-code-putri-image-live-pass-20260825.png'), fullPage: true })

    const settledBeforeSteer = await settledAssistantTexts(page)
    const interruptedBeforeSteer = await page.locator('[data-assistant-status="interrupted"]').count()
    const userMessagesBeforeSteer = await page.locator('[data-chat-flow-kind="user"]').count()
    const steeringMessagesBeforeSteer = await page.locator('[data-chat-flow-kind="steering"]').count()

    await textarea.fill('Run a read-only continuity check: use an available shell to wait 20 seconds, then finish with the exact label ORIGINAL_WORK_COMPLETED.')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.getByRole('button', { name: 'Stop generating' }).waitFor({ state: 'visible', timeout: 30_000 })
    await textarea.fill('Steering context: preserve and finish the work already in progress; do not cancel or abandon it. After it completes, report the current local date and finish with the exact label STEER_RECOVERY_OK.')
    const steer = page.getByRole('button', { name: 'Steer current turn' })
    assert(await steer.count() === 1, 'STEER_ACTION_COUNT_INVALID')
    assert(!await steer.isDisabled(), 'STEER_DISABLED_WHILE_BUSY')
    assert(await page.getByRole('button', { name: 'Stop generating' }).count() === 1, 'SEPARATE_STOP_ACTION_MISSING')
    await page.screenshot({ path: path.join(evidenceRoot, 'giana-code-putri-steer-before-send-20260825.png'), fullPage: true })
    await steer.click()
    await waitForIdle(page)

    const postSteerTexts = (await settledAssistantTexts(page)).slice(settledBeforeSteer.length)
    const postSteerTranscript = postSteerTexts.join('\n\n')
    const interruptedAfterSteer = await page.locator('[data-assistant-status="interrupted"]').count()
    const userMessagesAfterSteer = await page.locator('[data-chat-flow-kind="user"]').count()
    const steeringMessagesAfterSteer = await page.locator('[data-chat-flow-kind="steering"]').count()
    assert(postSteerTexts.length === 2, 'STEER_SETTLED_RESPONSE_COUNT_INVALID')
    assert(occurrenceCount(postSteerTexts[0] ?? '', /ORIGINAL_WORK_COMPLETED/gi) === 1, 'STEER_ORIGINAL_WORK_NOT_PRESERVED_EXACTLY_ONCE')
    assert(occurrenceCount(postSteerTexts[1] ?? '', /STEER_RECOVERY_OK/gi) === 1, 'STEER_RECOVERY_LABEL_NOT_OBSERVED_EXACTLY_ONCE')
    assert(postSteerTexts[0] !== postSteerTexts[1], 'STEER_DUPLICATED_SETTLED_RESPONSE')
    assert(!/Queued for the next turn|respond once the current task finishes/i.test(postSteerTranscript), 'STEER_DEGRADED_TO_QUEUE')
    assert(interruptedAfterSteer === interruptedBeforeSteer, 'STEER_INTERRUPTED_RUNNING_PROGRESS')
    assert(userMessagesAfterSteer === userMessagesBeforeSteer + 1, 'STEER_USER_MESSAGE_COUNT_INVALID')
    assert(steeringMessagesAfterSteer === steeringMessagesBeforeSteer + 1, 'STEER_TYPED_MESSAGE_COUNT_INVALID')
    result.checks.steer = {
      stopSeparate: true,
      originalProgressCompleted: true,
      steeringContextCompleted: true,
      settledResponseDelta: 2,
      labelsObservedExactlyOncePerResponse: true,
      interruptionDelta: 0,
      userMessageDelta: 1,
      steeringMessageDelta: 1,
      queuedFallback: false,
    }
    await page.screenshot({ path: path.join(evidenceRoot, 'giana-code-putri-steer-live-pass-20260825.png'), fullPage: true })

    assert(consoleErrors.length === 0, 'BROWSER_CONSOLE_ERRORS_OBSERVED')
    assert(pageErrors.length === 0, 'BROWSER_PAGE_ERRORS_OBSERVED')
    result.verdict = 'READY_FOR_ALEX_HEQA'
  } catch (error) {
    failure = error
    result.failureCode = error instanceof HeqaAssertionError ? error.code : 'HEQA_EXECUTION_ERROR'
    await page?.screenshot({ path: path.join(evidenceRoot, 'giana-code-putri-p0-held-20260825.png'), fullPage: true }).catch(() => {})
  } finally {
    result.completedAt = new Date().toISOString()
    result.runtimeErrorCounts = {
      console: consoleErrors.length,
      page: pageErrors.length,
    }
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
    await writeFile(path.join(evidenceRoot, 'giana-code-putri-image-steer-heqa-20260825.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify({
      verdict: result.verdict,
      imageVerified: result.checks.image?.visualFactVerified === true,
      steerVerified: result.checks.steer?.originalProgressCompleted === true
        && result.checks.steer?.steeringContextCompleted === true,
      failureCode: result.failureCode ?? null,
    }, null, 2))
  }

  if (failure) throw failure
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isMain) {
  try {
    await run()
  } catch (error) {
    const failureCode = error instanceof HeqaAssertionError ? error.code : 'HEQA_EXECUTION_ERROR'
    console.error(`HEQA_FAILED:${failureCode}`)
    process.exitCode = 1
  }
}
