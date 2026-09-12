import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('.', import.meta.url))
const repo = resolve(root, '../../../..')
const output = process.argv[2]
if (!output) throw new Error('Pass an evidence output directory')
await mkdir(output, { recursive: true })
const server = await createServer({
  root, configFile: false, plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^@deepseek-ai\/dsh-client-runtime\/client$/, replacement: resolve(repo, 'packages/client/runtime/src/client/contract/store.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: resolve(root, 'primitives.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } },
})
let browser
const evidence = { source: repo, checks: [], errors: [] }
function check(name, passed, detail) {
  evidence.checks.push({ name, passed, detail })
  if (!passed) throw new Error(`${name}: ${JSON.stringify(detail)}`)
}
try {
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 900, height: 760 }, reducedMotion: 'reduce' })
  page.on('pageerror', error => evidence.errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') evidence.errors.push(message.text()) })
  const port = server.httpServer.address().port
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' })
  const chip = page.locator('[data-annotation-inline-chip="1"]')
  const marker = page.locator('[data-response-annotation-marker="1"]')
  await chip.waitFor()
  await marker.waitFor()
  const quote = 'annotated source passage wraps over several lines in this deliberately narrow response column'
  check('visible numbered source badge', await marker.isVisible() && await marker.innerText() === '1', await marker.boundingBox())
  check('visible numbered inline chip', await chip.isVisible() && (await chip.innerText()).includes('Annotation 1'), await chip.innerText())
  const wrap = await page.evaluate(() => {
    const host = document.querySelector('[data-response-message-id]')
    const marker = document.querySelector('[data-response-annotation-marker="1"]')
    const highlights = [...document.querySelectorAll('[class*="highlight"]')].filter(el => el.parentElement?.querySelector('[data-response-annotation-marker]'))
    const content = host?.getBoundingClientRect()
    const badge = marker?.getBoundingClientRect()
    return { highlightCount: highlights.length, content: content && { left: content.left, right: content.right }, badge: badge && { left: badge.left, right: badge.right, top: badge.top }, lines: [...new Set(highlights.map(el => Math.round(el.getBoundingClientRect().top)))] }
  })
  check('wrapped source annotation remains badged', wrap.lines.length > 1 && wrap.badge?.left >= wrap.content?.left && wrap.badge?.right <= 900, wrap)
  await page.screenshot({ path: join(output, 'desktop-base.png'), fullPage: true })
  await chip.hover()
  await page.getByRole('tooltip').waitFor()
  check('chip hover tooltip', (await page.getByRole('tooltip').innerText()) === `Annotation 1 source: ${quote}`, await page.getByRole('tooltip').innerText())
  await page.screenshot({ path: join(output, 'desktop-chip-hover.png'), fullPage: true })
  await page.mouse.move(890, 740)
  await page.getByRole('tooltip').waitFor({ state: 'detached' })
  await chip.focus()
  await page.getByRole('tooltip').waitFor()
  check('chip keyboard focus tooltip', (await page.getByRole('tooltip').innerText()) === `Annotation 1 source: ${quote}`, await page.getByRole('tooltip').innerText())
  await page.screenshot({ path: join(output, 'desktop-chip-focus.png'), fullPage: true })
  await chip.evaluate(element => element.blur())
  await page.getByRole('tooltip').waitFor({ state: 'detached' })
  await page.setViewportSize({ width: 390, height: 844 })
  const mobile = await page.evaluate(() => {
    const chip = document.querySelector('[data-annotation-inline-chip="1"]')?.getBoundingClientRect()
    const badge = document.querySelector('[data-response-annotation-marker="1"]')?.getBoundingClientRect()
    return { scrollWidth: document.documentElement.scrollWidth, chip: chip && { left: chip.left, right: chip.right }, badge: badge && { left: badge.left, right: badge.right } }
  })
  check('mobile chip and source badge fit viewport', mobile.scrollWidth <= 390 && mobile.chip?.left >= 0 && mobile.chip?.right <= 390 && mobile.badge?.left >= 0 && mobile.badge?.right <= 390, mobile)
  await page.screenshot({ path: join(output, 'mobile-base.png'), fullPage: true })
  await chip.hover()
  await page.getByRole('tooltip').waitFor()
  const mobileTooltip = await page.getByRole('tooltip').boundingBox()
  check('mobile hover tooltip fits viewport', mobileTooltip !== null && mobileTooltip.x >= 0 && mobileTooltip.x + mobileTooltip.width <= 390, mobileTooltip)
  await page.screenshot({ path: join(output, 'mobile-chip-hover.png'), fullPage: true })
  check('no browser errors', evidence.errors.length === 0, evidence.errors)
} catch (error) {
  evidence.errors.push(String(error))
  process.exitCode = 1
} finally {
  await browser?.close()
  await server.close()
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2))
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n')
}
