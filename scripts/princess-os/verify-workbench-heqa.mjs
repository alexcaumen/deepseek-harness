import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(new URL('../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')

const endpoint = process.env.DSH_HEQA_URL ?? 'http://127.0.0.1:3110'
const outputRoot = resolve(process.env.DSH_HEQA_OUTPUT ?? 'N:\\BIG DATA\\11_GIANA\\05_REPORTS\\NEWTECH_DSH_PLUGIN_TOOL_PARITY_UPGRADE_20260822')
await mkdir(outputRoot, { recursive: true })

const browser = await chromium.launch({ headless: true })
const results = []
const errors = []

try {
  for (const viewport of [
    { name: 'desktop-1600x1000', width: 1600, height: 1000 },
    { name: 'compact-1024x768', width: 1024, height: 768 },
  ]) {
    const page = await browser.newPage({ viewport })
    page.on('console', message => {
      if (message.type() === 'error') errors.push({ viewport: viewport.name, source: 'console', text: message.text() })
    })
    page.on('pageerror', error => errors.push({ viewport: viewport.name, source: 'pageerror', text: error.message }))

    await page.goto(endpoint, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.getByText('Giana CoWork', { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(1_000)

    const requiredControls = [
      'Start automatic-language dictation',
      'Send message',
      'Collapse sidebar',
      'Toggle full inspector',
    ]
    const controls = {}
    for (const name of requiredControls) {
      controls[name] = await page.getByRole('button', { name, exact: true }).isVisible()
      if (!controls[name]) throw new Error(`${viewport.name}: required workbench control is not visible: ${name}`)
    }

    for (const title of ['Files', 'Source Control', 'Tasks', 'Side Chat (beta)', 'Terminal', 'Browser']) {
      const control = page.locator(`button[title="${title}"]`)
      if (await control.count() !== 1) {
        throw new Error(`${viewport.name}: workbench tool is missing: ${title}`)
      }
      const rendered = await control.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        return {
          width: rect.width,
          height: rect.height,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
        }
      })
      controls[`workbench:${title}`] = rendered
    }

    const collapseBottom = page.getByRole('button', { name: 'Collapse bottom panel', exact: true }).first()
    const expandBottom = page.getByRole('button', { name: 'Expand bottom panel', exact: true }).first()
    if (!(await collapseBottom.isVisible()) && !(await expandBottom.isVisible())) {
      throw new Error(`${viewport.name}: bottom panel toggle is not visible`)
    }
    controls.bottomPanelToggle = (await collapseBottom.isVisible()) ? 'collapse' : 'expand'

    await page.screenshot({
      path: resolve(outputRoot, `HEQA_DSH_PRINCESS_OS_WORKBENCH_${viewport.name.toUpperCase()}_20260822.png`),
      fullPage: true,
    })

    if (await collapseBottom.isVisible()) {
      await collapseBottom.click()
      await expandBottom.waitFor({ state: 'visible' })
      await expandBottom.click()
      await collapseBottom.waitFor({ state: 'visible' })
    } else {
      await expandBottom.click()
      await collapseBottom.waitFor({ state: 'visible' })
      await collapseBottom.click()
      await expandBottom.waitFor({ state: 'visible' })
    }

    const geometry = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      bodyHeight: document.body.scrollHeight,
      viewportHeight: window.innerHeight,
    }))
    if (geometry.bodyWidth > geometry.viewportWidth + 2) {
      throw new Error(`${viewport.name}: page has horizontal overflow (${geometry.bodyWidth} > ${geometry.viewportWidth})`)
    }

    results.push({ viewport, controls, geometry, collapseRestore: 'PASS' })
    await page.close()
  }
} finally {
  await browser.close()
}

if (errors.length > 0) {
  throw new Error(`Workbench emitted browser errors: ${JSON.stringify(errors)}`)
}

const report = {
  schemaVersion: 1,
  testedAt: new Date().toISOString(),
  endpoint,
  result: 'PASS',
  errors,
  viewports: results,
}
await writeFile(resolve(outputRoot, 'HEQA_DSH_PRINCESS_OS_WORKBENCH_20260822.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(report)}\n`)
