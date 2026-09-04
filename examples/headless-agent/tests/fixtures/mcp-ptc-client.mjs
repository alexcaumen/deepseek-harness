/** Separate-process MCP consumer; the exact live capability arrives only on stdin. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

// Reuse the bridge's installed SDK without adding an examples dependency or loading built DSH code.
const require = createRequire(new URL('../../../../packages/mcp/mcp-server-tool-runtime/package.json', import.meta.url))
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
let input = ''
for await (const chunk of process.stdin) input += chunk
const { endpoint, token } = JSON.parse(input)
const url = new URL(endpoint)
assert.equal(url.hostname, '127.0.0.1')
assert.equal(url.protocol, 'http:')
const client = new Client({ name: 'keyless-ptc-regression', version: '1.0.0' })
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
})
try {
  await client.connect(transport)
  const { tools } = await client.listTools()
  const direct = await client.callTool({ name: 'ptc_echo', arguments: { message: 'remote-native', count: 2 } })
  const code = await client.callTool({
    name: 'run_code',
    arguments: {
      code: 'const value = await tools.ptc_echo({ message: "remote-code", count: 3 }); return { value, bindings: Object.keys(tools).sort() };',
      description: 'Echo through the scoped worker bindings',
    },
  })
  process.stdout.write(JSON.stringify({ tools, direct, code }) + '\n')
} finally {
  await client.close()
}
