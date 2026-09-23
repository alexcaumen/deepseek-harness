import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/response-annotation', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/response-annotation/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'response-annotation-web-e2e'
const PASSAGE = 'the selected passage stays anchored to this answer'

function settledReply(): string {
  const session = Session.create(SessionId(SEED_ID))
  const eventTimeOrigin = new Date().setHours(12, 0, 0, 0)
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Explain the annotation target.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Annotation target', messageSeqs: [user.seq], source: { kind: 'fallback' },
  })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `Please note that ${PASSAGE} after selection.` }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0, cwd: '{{cwd}}' }),
    ...session.events.map(event => JSON.stringify({ ...event, time: eventTimeOrigin + event.seq * 1_000 })),
    '',
  ].join('\n')
}

describe('web e2e: response annotation in the shipped composition', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    if (MODE === 'refresh') await mkdir(SNAPSHOT_DIR, { recursive: true })
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, settledReply(), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('keeps selected text out of the editable draft and previews its source', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-response-annotation'))
    const group = page.locator('[role="treeitem"]').first()
    await group.waitFor({ timeout: 15_000 })
    await group.click()
    const session = page.locator('[role="treeitem"]').nth(1)
    await session.waitFor({ timeout: 10_000 })
    await session.click()
    const answer = page.locator('[data-response-message-id]').filter({ hasText: PASSAGE })
    await answer.waitFor({ timeout: 15_000 })
    await answer.evaluate((element, passage) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let text: Node | null = walker.nextNode()
      while (text !== null && !text.textContent?.includes(passage)) text = walker.nextNode()
      if (text === null) throw new Error('annotation passage text node missing')
      const start = text.textContent?.indexOf(passage) ?? -1
      const range = document.createRange()
      range.setStart(text, start)
      range.setEnd(text, start + passage.length)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    }, PASSAGE)
    await page.getByRole('button', { name: 'Add to chat' }).click()

    const attachment = page.locator('[data-annotation-attachment]')
    const chip = attachment.locator('[data-annotation-count="1"]')
    const marker = page.locator('[data-response-annotation-marker="1"]')
    await chip.waitFor()
    await marker.waitFor()
    expect(await page.locator('textarea').first().inputValue()).toBe('')
    expect(await marker.getAttribute('title')).toBe(PASSAGE)

    await chip.hover()
    const preview = page.locator('[data-annotation-preview]')
    await preview.waitFor()
    expect(await preview.innerText()).toContain(PASSAGE)
    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)

    await marker.hover()
    const sourcePreview = page.locator('[data-response-annotation-preview="source"]')
    await sourcePreview.waitFor()
    expect(await sourcePreview.textContent()).toBe(PASSAGE)

    if (await chip.getAttribute('aria-expanded') === 'false') await chip.click()
    await page.getByRole('button', { name: 'Edit comment for annotation 1' }).click()
    await page.getByRole('button', { name: 'Cancel' }).click()
    expect(await chip.evaluate(element => document.activeElement === element)).toBe(true)
    await page.getByRole('button', { name: 'Edit comment for annotation 1' }).click()
    await page.getByRole('textbox', { name: 'Comment for annotation 1' }).press('Escape')
    expect(await chip.evaluate(element => document.activeElement === element)).toBe(true)
    await preview.waitFor({ state: 'hidden' })
    expect(await chip.getAttribute('aria-expanded')).toBe('false')

    const longQuote = `${PASSAGE} `.repeat(80)
    await marker.evaluate((element, quote) => { element.setAttribute('title', quote) }, longQuote)
    for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 667 }]) {
      await page.setViewportSize(viewport)
      await marker.hover()
      await sourcePreview.waitFor({ state: 'visible' })
      const bounds = await sourcePreview.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.y).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
      await page.mouse.move(0, 0)
    }

    if (await chip.getAttribute('aria-expanded') === 'false') await chip.click()
    await page.getByRole('button', { name: 'Edit comment for annotation 1' }).click()
    await page.getByRole('button', { name: 'Delete annotation 1' }).click()
    expect(await page.locator('textarea[data-phase]').evaluate(element => document.activeElement === element)).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  }, 60_000)
})
