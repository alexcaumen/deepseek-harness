import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildCanaryEnvironment,
  createFreshOutputRoot,
  exerciseReadOnlyComputerUse,
  parseCanaryArguments,
  readGitState,
  runCanary,
} from './canary-windows-desktop.mjs'

const fixturePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const fixtureSha256 = (await import('node:crypto')).createHash('sha256').update(fixturePng).digest('hex')

const validArguments = [
  '--profilePackage=N:\\fixtures\\profile\\package.json',
  '--server=N:\\fixtures\\server\\windows-computer-use-mcp.exe',
  '--serverCwd=N:\\fixtures\\server',
  '--sourceRoot=N:\\fixtures\\source',
  '--output=N:\\codex-temp\\giana-cowork-windows-desktop-test-001',
  '--sourceCommit=1111111111111111111111111111111111111111',
  '--sourceTree=2222222222222222222222222222222222222222',
  '--fixtureId=owned-hidden-window-001',
  '--windowHandle=4242',
  `--expectedScreenshotSha256=${fixtureSha256}`,
]

test('requires an explicit N-drive fixture and complete source watermark', () => {
  const parsed = parseCanaryArguments(validArguments)
  assert.equal(parsed.windowHandle, 4242)
  assert.equal(parsed.fixtureId, 'owned-hidden-window-001')
  assert.throws(() => parseCanaryArguments(validArguments.filter((entry) => !entry.startsWith('--windowHandle='))))
  assert.throws(() => parseCanaryArguments(validArguments.map((entry) => (
    entry.startsWith('--output=') ? '--output=F:\\forbidden' : entry
  ))))
  assert.throws(() => parseCanaryArguments([...validArguments, '--unexpected=true']))
})

test('scrubs inherited credentials and pins every dry-run safety switch', () => {
  const environment = buildCanaryEnvironment({
    PATH: 'safe-path',
    USERPROFILE: 'N:\\fixtures\\user',
    DEEPSEEK_API_KEY: 'do-not-forward',
    dsh_home: 'do-not-forward',
    SERVICE_TOKEN: 'do-not-forward',
    GITHUB_PAT: 'do-not-forward',
    NPM_CONFIG__AUTH: 'do-not-forward',
    DOCKER_AUTH_CONFIG: 'do-not-forward',
    SSH_AUTH_SOCK: 'do-not-forward',
    KUBECONFIG: 'do-not-forward',
    HTTPS_PROXY: 'do-not-forward',
    GOOGLE_APPLICATION_CREDENTIALS: 'do-not-forward',
  })
  assert.equal(environment.PATH, 'safe-path')
  assert.equal(environment.USERPROFILE, 'N:\\fixtures\\user')
  assert.equal(environment.DEEPSEEK_API_KEY, undefined)
  assert.equal(environment.dsh_home, undefined)
  assert.equal(environment.SERVICE_TOKEN, undefined)
  assert.equal(environment.GITHUB_PAT, undefined)
  assert.equal(environment.DOCKER_AUTH_CONFIG, undefined)
  assert.equal(environment.HTTPS_PROXY, undefined)
  assert.deepEqual({
    bypass: environment.WINDOWS_COMPUTER_USE_MCP_BYPASS_HITL,
    killSwitch: environment.WINDOWS_COMPUTER_USE_MCP_KILL_SWITCH,
    dryRun: environment.WINDOWS_COMPUTER_USE_MCP_DRY_RUN,
    face: environment.WINDOWS_COMPUTER_USE_MCP_ENABLE_FACE,
    keylogger: environment.WINDOWS_COMPUTER_USE_MCP_ENABLE_KEYLOGGER,
    rate: environment.WINDOWS_COMPUTER_USE_MCP_MAX_ACTIONS_PER_MINUTE,
  }, { bypass: '0', killSwitch: '0', dryRun: '1', face: '0', keylogger: '0', rate: '240' })
})

test('the no-spawn exercise can call only the fixture screenshot tool', async () => {
  const calls = []
  const client = {
    async listTools() {
      return { tools: [
        { name: 'automation_keyboard', inputSchema: {} },
        { name: 'automation_mouse', inputSchema: {} },
        { name: 'cua_computer_use_screenshot', inputSchema: { type: 'object' } },
      ] }
    },
    async callTool(call) {
      calls.push(call)
      return { content: [{ type: 'image', mimeType: 'image/png', data: fixturePng.toString('base64') }] }
    },
  }
  const result = await exerciseReadOnlyComputerUse(client, 4242, fixtureSha256)
  assert.equal(result.readOnlyContractPass, true)
  assert.equal(result.scopedPass, false)
  assert.equal(result.checks.independentWindowOwnershipProven, false)
  assert.equal(result.checks.liveCaptureProven, false)
  assert.equal(result.checks.mutatingInputIssued, false)
  assert.deepEqual(calls, [{
    name: 'cua_computer_use_screenshot',
    arguments: { window_handle: 4242, format: 'png' },
  }])
  assert.deepEqual(result.callLedger.map((entry) => entry.name), ['cua_computer_use_screenshot'])
})

test('rejects malformed or wrong-fixture screenshot evidence', async () => {
  const client = {
    async listTools() {
      return { tools: [{ name: 'cua_computer_use_screenshot', inputSchema: {} }] }
    },
    async callTool() {
      return { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('not-a-png').toString('base64') }] }
    },
  }
  const malformed = Buffer.from('not-a-png')
  const malformedSha256 = (await import('node:crypto')).createHash('sha256').update(malformed).digest('hex')
  await assert.rejects(() => exerciseReadOnlyComputerUse(client, 4242, malformedSha256), /not a PNG/)

  client.callTool = async () => ({
    content: [{ type: 'image', mimeType: 'image/png', data: fixturePng.toString('base64') }],
  })
  const wrong = await exerciseReadOnlyComputerUse(client, 4242, 'f'.repeat(64))
  assert.equal(wrong.scopedPass, false)
  assert.equal(wrong.checks.exactFixtureScreenshot, false)
  assert.equal(wrong.screenshotEvidence[0].decoded, false)
})

test('creates evidence only as a fresh direct directory', async () => {
  const calls = []
  const directory = { isDirectory: () => true, isSymbolicLink: () => false }
  const fs = {
    async realpath(path) {
      calls.push(['realpath', path])
      return path
    },
    async mkdir(path) {
      calls.push(['mkdir', path])
    },
    async lstat(path) {
      calls.push(['lstat', path])
      return directory
    },
  }
  const output = 'N:\\codex-temp\\giana-cowork-windows-desktop-owned-001'
  await createFreshOutputRoot(output, fs)
  assert.deepEqual(calls.map(([operation]) => operation), ['realpath', 'mkdir', 'lstat', 'realpath'])

  await assert.rejects(() => createFreshOutputRoot(output, {
    ...fs,
    async realpath(path) {
      return path === 'N:\\codex-temp' ? 'N:\\redirected' : path
    },
  }), /resolve directly/)
})

test('hashes source, server and profile before loading the profile SDK', async () => {
  const events = []
  const git = { head: '1'.repeat(40), tree: '2'.repeat(40), clean: true }
  class Transport {}
  class Client {
    async connect() {
      events.push('connect')
    }

    async listTools() {
      return { tools: [{ name: 'cua_computer_use_screenshot', inputSchema: {} }] }
    }

    async callTool() {
      return { content: [{ type: 'image', mimeType: 'image/png', data: fixturePng.toString('base64') }] }
    }

    async close() {
      events.push('close')
    }
  }
  const options = {
    profilePackage: 'N:\\fixtures\\profile\\package.json',
    server: 'N:\\fixtures\\server\\server.exe',
    serverCwd: 'N:\\fixtures\\server',
    sourceRoot: 'N:\\fixtures\\source',
    sourceCommit: git.head,
    sourceTree: git.tree,
    expectedScreenshotSha256: fixtureSha256,
    fixtureId: 'owned-hidden-window-001',
    windowHandle: 4242,
  }
  const receipt = await runCanary(options, {
    readGitState() {
      events.push('git')
      return git
    },
    async hashFile(path) {
      events.push(`hash:${path}`)
      return path.includes('server') ? 'a'.repeat(64) : 'b'.repeat(64)
    },
    loadClientDependencies() {
      events.push('load-sdk')
      return { Client, StdioClientTransport: Transport }
    },
  })
  assert.equal(receipt.readOnlyContractPass, true)
  assert.equal(receipt.scopedPass, false)
  assert.equal(receipt.claimCeiling, 'HELD_STATIC_FIXTURE_HASH_NO_INDEPENDENT_WINDOW_OWNERSHIP')
  assert.deepEqual(events.slice(0, 4), [
    'git',
    'hash:N:\\fixtures\\server\\server.exe',
    'hash:N:\\fixtures\\profile\\package.json',
    'load-sdk',
  ])
})

test('forces complete untracked-file visibility in Git provenance', () => {
  const calls = []
  const spawn = (_command, args) => {
    calls.push(args)
    if (args.includes('status')) return { status: 0, stdout: '', stderr: '' }
    return { status: 0, stdout: `${(args.includes('HEAD^{tree}') ? '2' : '1').repeat(40)}\n`, stderr: '' }
  }
  readGitState('N:\\fixtures\\source', spawn)
  assert.deepEqual(calls.at(-1), [
    '-C', 'N:\\fixtures\\source', 'status', '--porcelain', '--untracked-files=all',
  ])
})
