import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
  const separator = entry.indexOf('=')
  if (separator === -1) return [entry.replace(/^--/, ''), 'true']
  return [entry.slice(0, separator).replace(/^--/, ''), entry.slice(separator + 1)]
}))

const baseURL = args.url ?? 'http://127.0.0.1:18101/'
const profilePackage = args.profilePackage
  ?? 'C:\\Users\\grinv\\.dsh-giana-code-putri-clean-20260827\\profiles\\web\\package.json'
const screenshotPath = resolve(args.screenshot
  ?? 'N:\\worktrees\\deepseek-harness\\giana-code-putri-20260827\\.artifacts\\m4-plugin-inventory-current\\plugin-inventory.png')
const receiptPath = resolve(args.receipt
  ?? 'N:\\worktrees\\deepseek-harness\\giana-code-putri-20260827\\.artifacts\\m4-plugin-inventory-current\\receipt.json')

const require = createRequire(profilePackage)
const { chromium } = require('playwright')
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const consoleErrors = []
const pageErrors = []
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', error => pageErrors.push(String(error)))

const allowedLoaderStatuses = new Set([
  'disabled',
  'enabled-unmounted',
  'pending',
  'loading',
  'mounted',
  'mount-failed',
  'unloading',
])

try {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.getByText('Giana Code Putri', { exact: true }).first().waitFor({ state: 'visible', timeout: 120_000 })
  await page.getByText('Settings', { exact: true }).first().click()
  await page.getByText('Plugins', { exact: true }).first().click()
  await page.getByText('Plugin list', { exact: true }).click()
  await page.getByRole('button', { name: 'Features' }).waitFor({ state: 'visible', timeout: 30_000 })

  const featureClaims = await page.locator('[data-feature-claim="discoverable"]').count()
  const legacyRuntimeStates = await page.locator('[data-feature-id] [data-state]').count()
  const summaryFeatures = await page.locator('[data-summary-count="features"]').textContent()

  await page.getByRole('button', { name: 'System internals' }).click()
  const liveRows = page.locator('[data-live-evidence="pluginInventory.list"]')
  await liveRows.first().waitFor({ state: 'visible', timeout: 30_000 })
  const loaderStatuses = await liveRows.evaluateAll(rows => rows.map(row => row.getAttribute('data-loader-status')))
  const invalidLoaderStatuses = loaderStatuses.filter(status => status === null || !allowedLoaderStatuses.has(status))

  const checks = {
    title: await page.title() === 'Giana Code Putri',
    featureCount: summaryFeatures?.trim() === '96',
    allFeatureClaimsDiscoverable: featureClaims === 96,
    noLegacyFeatureRuntimeState: legacyRuntimeStates === 0,
    liveLoaderRowsObserved: loaderStatuses.length > 0,
    loaderStatusesLiteral: invalidLoaderStatuses.length === 0,
    noConsoleErrors: consoleErrors.length === 0,
    noPageErrors: pageErrors.length === 0,
  }

  await mkdir(dirname(screenshotPath), { recursive: true })
  await mkdir(dirname(receiptPath), { recursive: true })
  await page.screenshot({ path: screenshotPath, fullPage: true })
  const receipt = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    baseURL,
    checks,
    evidence: {
      featureClaims,
      liveLoaderRows: loaderStatuses.length,
      loaderStatuses: [...new Set(loaderStatuses)].sort(),
    },
    pass: Object.values(checks).every(Boolean),
    screenshotPath,
  }
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  if (!receipt.pass) process.exitCode = 1
} finally {
  await browser.close()
}
