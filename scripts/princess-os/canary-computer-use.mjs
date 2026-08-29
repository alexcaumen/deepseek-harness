import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
  const separator = entry.indexOf('=')
  if (separator === -1) return [entry.replace(/^--/, ''), 'true']
  return [entry.slice(0, separator).replace(/^--/, ''), entry.slice(separator + 1)]
}))

const baseURL = args.url ?? 'http://127.0.0.1:17380'
const profilePackage = args.profilePackage
  ?? 'C:\\Users\\grinv\\.dsh-0.1.1-rc.2-20260822\\profiles\\web\\package.json'
const playwrightCli = args.playwrightCli
  ?? 'C:\\Users\\grinv\\.dsh-0.1.1-rc.2-20260822\\profiles\\web\\node_modules\\@playwright\\mcp\\cli.js'
const outputRoot = resolve(args.output
  ?? 'N:\\PrincessOS\\workbench\\dsh-capability-parity\\computer-use-canary')
const receiptPath = resolve(outputRoot, 'computer-use-canary.json')

const require = createRequire(profilePackage)
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

await mkdir(outputRoot, { recursive: true })
const transport = new StdioClientTransport({
  command: 'C:\\Program Files\\nodejs\\node.exe',
  args: [
    playwrightCli,
    '--isolated',
    '--headless',
    '--sandbox',
    '--browser',
    'chrome',
    '--caps',
    'vision,testing,devtools',
    '--output-dir',
    outputRoot,
    '--block-service-workers',
    '--snapshot-mode',
    'full',
  ],
  cwd: outputRoot,
  stderr: 'pipe',
})
const client = new Client({ name: 'princess-os-computer-use-canary', version: '1.0.0' })

try {
  await client.connect(transport)
  const discovered = await client.listTools()
  const toolNames = discovered.tools.map(tool => tool.name).sort()
  const navigate = await client.callTool({ name: 'browser_navigate', arguments: { url: baseURL } })
  const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} })
  const screenshot = await client.callTool({
    name: 'browser_take_screenshot',
    arguments: { filename: 'dsh-local-canary.png', fullPage: true, type: 'png' },
  })
  const snapshotText = extractText(snapshot)
  const checks = {
    navigateSucceeded: navigate.isError !== true,
    snapshotSucceeded: snapshot.isError !== true,
    screenshotSucceeded: screenshot.isError !== true,
    dshContentObserved: snapshotText.includes('Giana Code'),
    snapshotToolDiscovered: toolNames.includes('browser_snapshot'),
    screenshotToolDiscovered: toolNames.includes('browser_take_screenshot'),
    unsafeCodeToolAvailable: toolNames.includes('browser_run_code_unsafe'),
    fileUploadToolAvailable: toolNames.includes('browser_file_upload'),
  }
  const receipt = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    baseURL,
    checks,
    capabilities: {
      browserInstallToolExposed: toolNames.includes('browser_install'),
      browserRuntimeAlreadyInstalled: navigate.isError !== true,
    },
    pass: Object.values(checks).every(Boolean),
    toolCount: toolNames.length,
    toolNames,
    screenshotPath: resolve(outputRoot, 'dsh-local-canary.png'),
  }
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  if (!receipt.pass) process.exitCode = 1
} finally {
  await client.close()
}

function extractText(result) {
  return (result.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}
