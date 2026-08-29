import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/grinv/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')

const baseURL = process.env.GIANA_CODE_HEQA_URL
  ?? process.env.GIANA_WINDOWS_HEQA_URL
  ?? 'http://127.0.0.1:17101/'
const evidenceRoot = process.env.GIANA_CODE_HEQA_ROOT
  ?? process.env.GIANA_WINDOWS_HEQA_ROOT
  ?? 'N:/PrincessOS/workbench/dsh-capability-parity/execution-20260823/heqa'

await mkdir(evidenceRoot, { recursive: true })

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function isInViewport(box, viewport) {
  if (!box) return false
  return box.x < viewport.width
    && box.y < viewport.height
    && box.x + box.width > 0
    && box.y + box.height > 0
}

async function pageOverflow(page) {
  return page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }))
}

async function waitForShell(page) {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.getByText('Giana Code', { exact: true }).first().waitFor({ state: 'visible', timeout: 120_000 })
  await page.waitForTimeout(1_000)
}

async function selectAuditSession(page) {
  const session = page.getByText('CCW DSW UI Automation Check', { exact: true }).first()
  if (await session.count()) {
    await session.click()
    await page.waitForTimeout(700)
    return true
  }
  return false
}

function rightWorkbenchControls(page) {
  const cluster = page.locator('[data-dsh-toggle-cluster]')
  return {
    cluster,
    collapse: cluster.getByRole('button', { name: 'Collapse sidebar' }),
    expand: cluster.getByRole('button', { name: 'Expand sidebar' }),
    panel: page.locator('[data-dsh-panel]:not([data-dsh-bottom-panel])').first(),
  }
}

async function rightWorkbenchState(page, viewport) {
  const controls = rightWorkbenchControls(page)
  const box = await controls.panel.count() ? await controls.panel.boundingBox() : null
  return {
    box,
    inViewport: isInViewport(box, viewport),
    collapseCount: await controls.collapse.count(),
    expandCount: await controls.expand.count(),
  }
}

async function closeRightWorkbenchIfOpen(page, viewport) {
  const controls = rightWorkbenchControls(page)
  const state = await rightWorkbenchState(page, viewport)
  if (state.inViewport && await controls.collapse.count()) {
    await controls.collapse.click()
    await page.waitForTimeout(450)
  }
}

async function validateDetails(page, viewport, prefix) {
  const controls = rightWorkbenchControls(page)
  const nativeToggle = page.getByRole('button', { name: 'Toggle details panel' })
  assert(await nativeToggle.count() === 0, `${prefix}: duplicate native details toggle is still present`)
  assert(await controls.cluster.count() === 1, `${prefix}: expected one workbench toggle cluster`)

  const initial = await rightWorkbenchState(page, viewport)
  assert(initial.collapseCount + initial.expandCount === 1,
    `${prefix}: expected exactly one authoritative right workbench toggle`)

  await closeRightWorkbenchIfOpen(page, viewport)
  const closed = await rightWorkbenchState(page, viewport)
  assert(!closed.inViewport && closed.expandCount === 1,
    `${prefix}: right workbench must begin visually closed`)
  await page.screenshot({ path: path.join(evidenceRoot, `${prefix}-details-closed.png`), fullPage: true })

  await controls.expand.click()
  await page.waitForTimeout(450)
  const opened = await rightWorkbenchState(page, viewport)
  assert(opened.inViewport && opened.collapseCount === 1,
    `${prefix}: right workbench did not enter the viewport`)
  await page.screenshot({ path: path.join(evidenceRoot, `${prefix}-details-open.png`), fullPage: true })

  await controls.collapse.click()
  await page.waitForTimeout(450)
  const reclosed = await rightWorkbenchState(page, viewport)
  assert(!reclosed.inViewport && reclosed.expandCount === 1,
    `${prefix}: right workbench did not leave the viewport`)
  return { initial, closed, opened, reclosed }
}

async function validateSidebar(page) {
  const collapse = page.getByRole('button', { name: 'Collapse sidebar' })
  if (await collapse.count()) {
    await collapse.first().click()
    await page.waitForTimeout(250)
    assert(await page.getByRole('button', { name: 'Open sidebar' }).count() > 0, 'sidebar did not expose its reopen control')
    await page.getByRole('button', { name: 'Open sidebar' }).first().click()
    await page.waitForTimeout(250)
    assert(await page.getByRole('button', { name: 'Collapse sidebar' }).count() > 0, 'sidebar did not reopen')
    return true
  }
  const open = page.getByRole('button', { name: 'Open sidebar' })
  if (await open.count()) {
    await open.first().click()
    await page.waitForTimeout(250)
    assert(await page.getByRole('button', { name: 'Collapse sidebar' }).count() > 0, 'mobile sidebar did not open')
    return true
  }
  throw new Error('sidebar control is not reachable')
}

async function validateDesktopSettings(page) {
  await page.getByText('Settings', { exact: true }).first().click()
  await page.getByText('Plugins', { exact: true }).first().click()
  await page.getByText('Plugin list', { exact: true }).click()
  await page.getByRole('button', { name: 'Features' }).waitFor({ state: 'visible', timeout: 30_000 })
  assert(await page.getByRole('button', { name: 'System internals' }).count() === 1,
    'system internals catalog tab missing')

  const counts = await page.evaluate(() => Object.fromEntries(
    ['features', 'skills', 'providers', 'actions'].map(key => [
      key,
      document.querySelector(`[data-summary-count="${key}"]`)?.textContent?.trim() ?? null,
    ]),
  ))
  assert(counts.features === '96', `features count mismatch: ${counts.features}`)
  assert(counts.skills === '647', `skills count mismatch: ${counts.skills}`)
  assert(counts.providers === '1,409', `providers count mismatch: ${counts.providers}`)
  assert(counts.actions === '14,799', `actions count mismatch: ${counts.actions}`)

  const marketplace = page.getByRole('button', { name: 'Marketplace' })
  assert(await marketplace.count() === 1, 'marketplace catalog tab missing')
  await marketplace.click()
  await page.getByText('4,826', { exact: true }).first().waitFor({ state: 'visible' })
  await page.screenshot({ path: path.join(evidenceRoot, 'desktop-settings-catalog.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  return counts
}

async function validateModelSettings(page) {
  await page.getByText('Settings', { exact: true }).first().click()
  await page.getByText('Models', { exact: true }).first().click()
  await page.getByText('Qwen3.8-27B', { exact: true }).first().waitFor({
    state: 'visible',
    timeout: 30_000,
  })
  assert(await page.getByText(/R5300 lokal/).count() === 0,
    'infrastructure location leaked into the model label')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.waitForTimeout(250)
}

async function runViewport(browser, descriptor) {
  const context = await browser.newContext({
    viewport: descriptor.viewport,
    colorScheme: 'light',
    locale: 'en-US',
  })
  const page = await context.newPage()
  const consoleErrors = []
  const pageErrors = []
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', error => pageErrors.push(String(error)))

  await waitForShell(page)
  assert(await page.getByRole('button', { name: 'Start automatic-language dictation' }).count() > 0,
    `${descriptor.name}: automatic-language dictation control missing`)
  if (descriptor.name === 'desktop') await validateModelSettings(page)
  await selectAuditSession(page)

  const details = await validateDetails(page, descriptor.viewport, descriptor.name)
  const sidebar = await validateSidebar(page)
  if (descriptor.viewport.width < 768) {
    const collapseSidebar = page.getByRole('button', { name: 'Collapse sidebar' }).first()
    if (await collapseSidebar.count()) {
      await collapseSidebar.click()
      await page.waitForTimeout(250)
    }
  }
  const counts = descriptor.name === 'desktop' ? await validateDesktopSettings(page) : null
  await page.screenshot({ path: path.join(evidenceRoot, `${descriptor.name}-final.png`), fullPage: true })

  const overflow = await pageOverflow(page)
  assert(overflow.scrollWidth <= overflow.clientWidth + 1,
    `${descriptor.name}: horizontal overflow ${overflow.scrollWidth}/${overflow.clientWidth}`)
  assert(consoleErrors.length === 0, `${descriptor.name}: console errors: ${consoleErrors.join(' | ')}`)
  assert(pageErrors.length === 0, `${descriptor.name}: page errors: ${pageErrors.join(' | ')}`)

  await context.close()
  return { ...descriptor, details, sidebar, counts, overflow, consoleErrors, pageErrors }
}

const browser = await chromium.launch({ headless: true })
let result
try {
  const desktop = await runViewport(browser, { name: 'desktop', viewport: { width: 1440, height: 960 } })
  const mobile = await runViewport(browser, { name: 'mobile', viewport: { width: 390, height: 844 } })
  result = {
    verdict: 'READY_FOR_ALEX_HEQA',
    surface: 'ORIGINAL_RUNTIME_LOCALHOST',
    sourceURL: baseURL,
    observedAt: new Date().toISOString(),
    desktop,
    mobile,
  }
} catch (error) {
  result = {
    verdict: 'HELD',
    surface: 'ORIGINAL_RUNTIME_LOCALHOST',
    sourceURL: baseURL,
    observedAt: new Date().toISOString(),
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  }
  throw error
} finally {
  await writeFile(path.join(evidenceRoot, 'heqa-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  await browser.close()
}

console.log(JSON.stringify(result, null, 2))
