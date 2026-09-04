import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, win32 } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const SCREENSHOT_TOOL = 'cua_computer_use_screenshot'
const MUTATING_INPUT_PATTERN = /(?:^|_)(?:mouse|keyboard|shortcut|macro|task|mission|smart|system)(?:_|$)/i
const ALLOWED_PARENT_ENVIRONMENT = Object.freeze([
  'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
])
const EXPECTED_ARGUMENTS = new Set([
  'profilePackage', 'server', 'serverCwd', 'sourceRoot', 'output',
  'sourceCommit', 'sourceTree', 'fixtureId', 'windowHandle', 'expectedScreenshotSha256',
])
const SAFETY_ENVIRONMENT = Object.freeze({
  WINDOWS_COMPUTER_USE_MCP_BYPASS_HITL: '0',
  WINDOWS_COMPUTER_USE_MCP_KILL_SWITCH: '0',
  WINDOWS_COMPUTER_USE_MCP_DRY_RUN: '1',
  WINDOWS_COMPUTER_USE_MCP_ENABLE_FACE: '0',
  WINDOWS_COMPUTER_USE_MCP_ENABLE_KEYLOGGER: '0',
  WINDOWS_COMPUTER_USE_MCP_MAX_ACTIONS_PER_MINUTE: '240',
})

function parseEntries(argv) {
  const entries = argv.map((entry) => {
    const separator = entry.indexOf('=')
    if (!entry.startsWith('--') || separator < 3) throw new Error(`Invalid argument: ${entry}`)
    return [entry.slice(2, separator), entry.slice(separator + 1)]
  })
  const names = entries.map(([name]) => name)
  if (new Set(names).size !== names.length) throw new Error('Duplicate canary arguments are not allowed.')
  const unknown = names.filter((name) => !EXPECTED_ARGUMENTS.has(name))
  if (unknown.length > 0) throw new Error(`Unknown canary argument: ${unknown[0]}`)
  return Object.fromEntries(entries)
}

function required(args, name) {
  const value = args[name]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`--${name}=... is required.`)
  return value
}

function requireNDrivePath(value, label) {
  const absolute = win32.resolve(value)
  if (win32.parse(absolute).root.toLowerCase() !== 'n:\\') throw new Error(`${label} must be on N:.`)
  return absolute
}

export function parseCanaryArguments(argv) {
  const args = parseEntries(argv)
  const windowHandle = Number(required(args, 'windowHandle'))
  if (!Number.isSafeInteger(windowHandle) || windowHandle <= 0) {
    throw new Error('--windowHandle must identify an approved disposable fixture window.')
  }
  const fixtureId = required(args, 'fixtureId')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(fixtureId)) {
    throw new Error('--fixtureId must be a stable non-secret identifier.')
  }
  const sourceCommit = required(args, 'sourceCommit').toLowerCase()
  const sourceTree = required(args, 'sourceTree').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(sourceCommit) || !/^[0-9a-f]{40}$/.test(sourceTree)) {
    throw new Error('--sourceCommit and --sourceTree must be full Git object IDs.')
  }
  const expectedScreenshotSha256 = required(args, 'expectedScreenshotSha256').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expectedScreenshotSha256)) {
    throw new Error('--expectedScreenshotSha256 must be a full SHA-256 digest.')
  }
  const outputRoot = requireNDrivePath(required(args, 'output'), 'Evidence output')
  const outputRelative = win32.relative('N:\\codex-temp', outputRoot)
  if (outputRelative.startsWith('..') || win32.isAbsolute(outputRelative)
    || !/^giana-cowork-windows-desktop-[A-Za-z0-9._-]+$/.test(outputRelative)) {
    throw new Error('Evidence output must be a fresh direct child of N:\\codex-temp named giana-cowork-windows-desktop-*')
  }
  return {
    profilePackage: requireNDrivePath(required(args, 'profilePackage'), 'Profile package'),
    server: requireNDrivePath(required(args, 'server'), 'Computer-use server'),
    serverCwd: requireNDrivePath(required(args, 'serverCwd'), 'Computer-use server cwd'),
    sourceRoot: requireNDrivePath(required(args, 'sourceRoot'), 'Source root'),
    outputRoot,
    sourceCommit,
    sourceTree,
    expectedScreenshotSha256,
    fixtureId,
    windowHandle,
  }
}

export function scrubParentEnvironment(parentEnvironment) {
  const environment = {}
  const entries = new Map(Object.entries(parentEnvironment).map(([name, value]) => [name.toUpperCase(), value]))
  for (const name of ALLOWED_PARENT_ENVIRONMENT) {
    const value = entries.get(name)
    if (value !== undefined) environment[name] = value
  }
  return environment
}

export function buildCanaryEnvironment(parentEnvironment) {
  return { ...scrubParentEnvironment(parentEnvironment), ...SAFETY_ENVIRONMENT }
}

function textError(result) {
  return result.content?.find((row) => row.type === 'text')?.text
}

function parsePng(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) throw new Error('Screenshot is not a PNG.')
  let offset = 8
  let width
  let height
  const compressed = []
  let ended = false
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) throw new Error('Screenshot PNG contains a truncated chunk.')
    const data = bytes.subarray(dataStart, dataEnd)
    if (type === 'IHDR') {
      if (length !== 13) throw new Error('Screenshot PNG has an invalid IHDR.')
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
    } else if (type === 'IDAT') compressed.push(data)
    else if (type === 'IEND') {
      ended = true
      break
    }
    offset = dataEnd + 4
  }
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('Screenshot PNG dimensions are invalid.')
  }
  if (!ended || compressed.length === 0 || inflateSync(Buffer.concat(compressed)).length === 0) {
    throw new Error('Screenshot PNG is not decodable.')
  }
  return { width, height }
}

function imageEvidence(result) {
  const images = (result.content ?? []).filter((row) => row.type === 'image' && typeof row.data === 'string')
  return images.map((row) => {
    const bytes = Buffer.from(row.data, 'base64')
    if (row.mimeType !== 'image/png') throw new Error(`Unexpected screenshot MIME type: ${String(row.mimeType)}`)
    const dimensions = parsePng(bytes)
    return {
      mimeType: row.mimeType,
      bytes: bytes.length,
      ...dimensions,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  })
}

export async function exerciseReadOnlyComputerUse(client, windowHandle, expectedScreenshotSha256) {
  const listed = await client.listTools()
  const names = listed.tools.map((tool) => tool.name).sort()
  const screenshotTool = listed.tools.find((tool) => tool.name === SCREENSHOT_TOOL)
  if (screenshotTool === undefined) throw new Error(`${SCREENSHOT_TOOL} is unavailable.`)

  const callLedger = []
  const call = async (name, arguments_) => {
    const entry = { sequence: callLedger.length + 1, name, arguments: arguments_, isError: null }
    callLedger.push(entry)
    if (MUTATING_INPUT_PATTERN.test(name)) throw new Error(`Mutating input tool is forbidden in this canary: ${name}`)
    const result = await client.callTool({ name, arguments: arguments_ })
    entry.isError = result.isError === true
    return result
  }

  const screenshot = await call(SCREENSHOT_TOOL, { window_handle: windowHandle, format: 'png' })
  const mutatingCalls = callLedger.filter((entry) => MUTATING_INPUT_PATTERN.test(entry.name))
  const images = imageEvidence(screenshot)
  const exactFixtureScreenshot = images.length === 1 && images[0].sha256 === expectedScreenshotSha256
  const checks = {
    screenshotToolDiscovered: true,
    screenshotSucceeded: screenshot.isError !== true,
    screenshotImageReturned: images.length === 1 && images[0].bytes > 0,
    exactFixtureScreenshot,
    onlyApprovedReadCallsIssued: callLedger.every((entry) => entry.name === SCREENSHOT_TOOL),
    mutatingInputIssued: mutatingCalls.length > 0,
    keyloggerExposed: names.includes('global_keylogger'),
    faceAutomationExposed: names.includes('automation_face'),
  }
  return {
    checks,
    scopedPass: checks.screenshotSucceeded
      && checks.screenshotImageReturned
      && checks.exactFixtureScreenshot
      && checks.onlyApprovedReadCallsIssued
      && !checks.mutatingInputIssued
      && !checks.keyloggerExposed
      && !checks.faceAutomationExposed,
    toolCount: names.length,
    toolNames: names,
    readToolSchemas: { [SCREENSHOT_TOOL]: screenshotTool.inputSchema },
    callLedger,
    screenshotEvidence: images,
    readErrors: { screenshot: checks.screenshotSucceeded ? undefined : textError(screenshot) },
  }
}

async function hashFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

export function readGitState(sourceRoot, spawn = spawnSync) {
  const run = (args) => spawn('git.exe', ['-C', sourceRoot, ...args], { encoding: 'utf8', windowsHide: true })
  const head = run(['rev-parse', 'HEAD'])
  const tree = run(['rev-parse', 'HEAD^{tree}'])
  const status = run(['status', '--porcelain', '--untracked-files=all'])
  for (const [label, result] of [['HEAD', head], ['tree', tree], ['status', status]]) {
    if (result.status !== 0) throw new Error(`Could not read source ${label}.`)
  }
  return { head: head.stdout.trim().toLowerCase(), tree: tree.stdout.trim().toLowerCase(), clean: status.stdout === '' }
}

export async function runCanary(options, dependencies) {
  const gitBefore = readGitState(options.sourceRoot)
  if (gitBefore.head !== options.sourceCommit || gitBefore.tree !== options.sourceTree || !gitBefore.clean) {
    throw new Error('Source watermark is not the requested clean commit/tree.')
  }
  const serverBefore = await hashFile(options.server)
  const profileBefore = await hashFile(options.profilePackage)
  const { Client, StdioClientTransport } = dependencies
  const transport = new StdioClientTransport({
    command: options.server,
    cwd: options.serverCwd,
    env: buildCanaryEnvironment(process.env),
    stderr: 'pipe',
  })
  const client = new Client({ name: 'giana-cowork-windows-desktop-canary', version: '2.0.0' })
  let result
  try {
    await client.connect(transport)
    result = await exerciseReadOnlyComputerUse(
      client, options.windowHandle, options.expectedScreenshotSha256,
    )
  } finally {
    await client.close()
  }
  const serverAfter = await hashFile(options.server)
  const profileAfter = await hashFile(options.profilePackage)
  const gitAfter = readGitState(options.sourceRoot)
  if (serverAfter !== serverBefore || profileAfter !== profileBefore
    || JSON.stringify(gitAfter) !== JSON.stringify(gitBefore)) {
    throw new Error('Canary provenance changed during execution.')
  }
  return {
    schemaVersion: 2,
    observedAt: new Date().toISOString(),
    claimCeiling: 'SCOPED_READ_ONLY_FIXTURE_SCREENSHOT_NO_DESKTOP_INPUT',
    fixture: {
      id: options.fixtureId,
      windowHandle: options.windowHandle,
      expectedScreenshotSha256: options.expectedScreenshotSha256,
    },
    source: { before: gitBefore, after: gitAfter },
    executable: { path: options.server, beforeSha256: serverBefore, afterSha256: serverAfter },
    profilePackage: { path: options.profilePackage, beforeSha256: profileBefore, afterSha256: profileAfter },
    requestedSafetyEnvironment: SAFETY_ENVIRONMENT,
    dryRunReadback: 'NOT_EXPOSED_BY_SERVER_CONTRACT',
    ...result,
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('The Windows desktop canary runs only on Windows.')
  const options = parseCanaryArguments(process.argv.slice(2))
  await mkdir(options.outputRoot, { recursive: true })
  const receiptPath = resolve(options.outputRoot, 'windows-desktop-canary.json')
  const require = createRequire(options.profilePackage)
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
  const receipt = await runCanary(options, { Client, StdioClientTransport })
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  if (!receipt.scopedPass) process.exitCode = 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: 'HELD', error: String(error?.message ?? error) })}\n`)
    process.exitCode = 1
  })
}
