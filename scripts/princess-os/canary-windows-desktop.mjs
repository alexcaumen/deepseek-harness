import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
  const separator = entry.indexOf('=')
  if (separator === -1) return [entry.replace(/^--/, ''), 'true']
  return [entry.slice(0, separator).replace(/^--/, ''), entry.slice(separator + 1)]
}))

const profilePackage = args.profilePackage
  ?? 'C:\\Users\\grinv\\.dsh-0.1.1-rc.2-20260822\\profiles\\web\\package.json'
const server = args.server
  ?? 'N:\\PrincessOS\\workbench\\third-party\\windows-computer-use-mcp-20260822\\.venv\\Scripts\\windows-computer-use-mcp.exe'
const outputRoot = resolve(args.output
  ?? 'N:\\PrincessOS\\workbench\\dsh-capability-parity\\windows-desktop-canary')
const receiptPath = resolve(outputRoot, 'windows-desktop-canary.json')
const windowHandle = Number(args.windowHandle ?? 0)

const require = createRequire(profilePackage)
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

await mkdir(outputRoot, { recursive: true })
const transport = new StdioClientTransport({
  command: server,
  cwd: 'N:\\PrincessOS\\workbench\\third-party\\windows-computer-use-mcp-20260822',
  env: {
    ...process.env,
    WINDOWS_COMPUTER_USE_MCP_BYPASS_HITL: '0',
    WINDOWS_COMPUTER_USE_MCP_KILL_SWITCH: '0',
    WINDOWS_COMPUTER_USE_MCP_DRY_RUN: '1',
    WINDOWS_COMPUTER_USE_MCP_ENABLE_FACE: '0',
    WINDOWS_COMPUTER_USE_MCP_ENABLE_KEYLOGGER: '0',
  },
  stderr: 'pipe',
})
const client = new Client({ name: 'giana-windows-desktop-canary', version: '1.0.0' })

try {
  await client.connect(transport)
  const listed = await client.listTools()
  const names = listed.tools.map((tool) => tool.name).sort()
  const desktopStateTool = listed.tools.find((tool) => tool.name === 'get_desktop_state')
  const screenshotTool = listed.tools.find((tool) => tool.name === 'cua_computer_use_screenshot')
  let desktopStateSucceeded = false
  let screenshotSucceeded = false
  let screenshotSkippedNoWindowHandle = false
  let desktopStateError
  let screenshotError

  if (desktopStateTool) {
    const result = await client.callTool({
      name: desktopStateTool.name,
      arguments: { request: { use_vision: false, use_ocr: false, capture_mode: 'ax' } },
    })
    desktopStateSucceeded = result.isError !== true
    if (!desktopStateSucceeded) desktopStateError = result.content?.find((row) => row.type === 'text')?.text
  }
  if (screenshotTool && Number.isSafeInteger(windowHandle) && windowHandle > 0) {
    const result = await client.callTool({
      name: screenshotTool.name,
      arguments: { window_handle: windowHandle, format: 'png' },
    })
    screenshotSucceeded = result.isError !== true
    if (!screenshotSucceeded) screenshotError = result.content?.find((row) => row.type === 'text')?.text
  } else if (screenshotTool) {
    screenshotSkippedNoWindowHandle = true
  }

  const receipt = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    checks: {
      desktopStateToolDiscovered: Boolean(desktopStateTool),
      screenshotToolDiscovered: Boolean(screenshotTool),
      desktopStateSucceeded,
      screenshotSucceeded,
      screenshotSkippedNoWindowHandle,
      mutatingInputIssued: false,
      keyloggerExposed: names.includes('global_keylogger'),
      faceAutomationExposed: names.includes('automation_face'),
    },
    pass: Boolean(desktopStateTool)
      && Boolean(screenshotTool)
      && desktopStateSucceeded
      && screenshotSucceeded
      && !names.includes('global_keylogger')
      && !names.includes('automation_face'),
    toolCount: names.length,
    toolNames: names,
    readToolSchemas: {
      get_desktop_state: desktopStateTool?.inputSchema,
      cua_computer_use_screenshot: screenshotTool?.inputSchema,
    },
    readErrors: {
      desktopState: desktopStateError,
      screenshot: screenshotError,
    },
  }
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  if (!receipt.pass) process.exitCode = 1
} finally {
  await client.close()
}
