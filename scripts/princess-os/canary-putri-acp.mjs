import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const launcher = fileURLToPath(new URL('./Start-GianaOsPutriAcp.mjs', import.meta.url))
const child = spawn(process.execPath, [launcher], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

const timeout = setTimeout(() => {
  child.kill()
  process.stderr.write('Putri ACP initialize canary timed out.\n')
  if (stderr.trim() !== '') process.stderr.write(stderr)
  process.exitCode = 1
}, 30_000)

let stderr = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', chunk => { stderr += chunk })

const lines = createInterface({ input: child.stdout })
lines.once('line', line => {
  clearTimeout(timeout)
  try {
    const response = JSON.parse(line)
    if (response.id !== 1 || response.error !== undefined) {
      throw new Error('ACP initialize returned an error')
    }
    const capabilities = response.result?.agentCapabilities
    if (capabilities?.loadSession !== true) {
      throw new Error('ACP route does not advertise session restoration')
    }
    process.stdout.write(JSON.stringify({
      state: 'PASS',
      protocolVersion: response.result.protocolVersion,
      agent: response.result.agentInfo?.name,
      httpMcpAcceptedByServer: true,
      httpMcpAdvertised: capabilities.mcpCapabilities?.http === true,
      loadSession: true,
    }) + '\n')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    if (stderr.trim() !== '') process.stderr.write(stderr)
    process.exitCode = 1
  } finally {
    child.kill()
  }
})

child.once('exit', code => {
  if (process.exitCode === undefined && code !== 0 && code !== null) {
    clearTimeout(timeout)
    if (stderr.trim() !== '') process.stderr.write(stderr)
    process.exitCode = 1
  }
})

child.stdin.write(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'giana-code-acp-canary', version: '1' },
  },
}) + '\n')
