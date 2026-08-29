import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
  const separator = entry.indexOf('=')
  if (separator === -1) return [entry.replace(/^--/, ''), 'true']
  return [entry.slice(0, separator).replace(/^--/, ''), entry.slice(separator + 1)]
}))

const baseURL = args.url ?? 'http://127.0.0.1:17380'
const profilePackage = args.profilePackage
  ?? 'C:\\Users\\grinv\\.dsh-0.1.1-rc.2-20260822\\profiles\\web\\package.json'
const screenshotPath = resolve(args.screenshot
  ?? 'N:\\PrincessOS\\workbench\\dsh-capability-parity\\heqa\\princess-os-settings.png')
const receiptPath = resolve(args.receipt
  ?? 'N:\\PrincessOS\\workbench\\dsh-capability-parity\\heqa\\princess-os-heqa.json')

const require = createRequire(profilePackage)
const { chromium } = require('playwright')
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})

try {
  await page.goto(baseURL, { waitUntil: 'networkidle', timeout: 60_000 })
  await mkdir(dirname(screenshotPath), { recursive: true })
  await page.screenshot({ path: screenshotPath.replace(/\.png$/i, '-initial.png'), fullPage: true })
  const initialText = await page.locator('body').innerText()
  process.stdout.write(`${JSON.stringify({ initialText: initialText.slice(0, 6000) }, null, 2)}\n`)
  const testingNotice = page.getByText('Internal Testing Notice', { exact: true })
  if (await testingNotice.isVisible()) {
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
  }
  await page.getByText('Settings', { exact: true }).click()
  await page.getByText('Models', { exact: true }).click()
  await page.waitForTimeout(750)
  const modelText = await page.locator('body').innerText()
  await page.getByText('Plugins', { exact: true }).click()
  await page.waitForTimeout(750)
  const pluginConfigText = await page.locator('body').innerText()
  await page.getByText('Plugin list', { exact: true }).click()
  await page.waitForTimeout(750)
  const pluginText = await page.locator('body').innerText()
  process.stdout.write(`${JSON.stringify({
    modelText: modelText.slice(0, 6000),
    pluginConfigText: pluginConfigText.slice(0, 6000),
    pluginText: pluginText.slice(0, 12_000),
  }, null, 2)}\n`)
  await page.screenshot({ path: screenshotPath, fullPage: true })

  const checks = {
    title: (await page.title()) === 'Giana Code',
    deepSeek: modelText.includes('DeepSeek'),
    nativeCodexSignIn: modelText.includes('Open Codex sign-in'),
    nativeClaudeSignIn: modelText.includes('Open Claude Code sign-in'),
    nativeCredentialBoundary: modelText.includes('does not copy browser cookies or OAuth tokens'),
    pluginSettings: pluginConfigText.includes('Plugins'),
    pluginList: pluginText.includes('Plugin list'),
    mcpClient: pluginText.includes('MCP Client'),
    office: pluginText.includes('Office'),
    toolAccessPolicy: pluginText.includes('Access Policy'),
    codexWorker: pluginText.includes('Subagent Codex'),
    claudeCodeWorker: pluginText.includes('Subagent Claude Code'),
  }
  const receipt = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    baseURL,
    checks,
    pass: Object.values(checks).every(Boolean) && consoleErrors.length === 0,
    consoleErrors,
    screenshotPath,
  }
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  if (!receipt.pass) process.exitCode = 1
} finally {
  await browser.close()
}
