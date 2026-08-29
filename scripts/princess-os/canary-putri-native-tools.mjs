import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const workspaceRequire = createRequire(new URL('../../apps/cli/package.json', import.meta.url))
const agentRequire = createRequire(new URL('../../packages/core/agent/package.json', import.meta.url))
const toolsRequire = createRequire(new URL('../../packages/core/tools/package.json', import.meta.url))
const [cordisModule, agentModule, scopeModule, sessionModule, systemPromptModule, toolsModule, approvalModule] = await Promise.all([
  import(pathToFileURL(workspaceRequire.resolve('@deepseek-ai/cordis')).href),
  import(pathToFileURL(workspaceRequire.resolve('@deepseek-ai/dsh-agent')).href),
  import(pathToFileURL(agentRequire.resolve('@deepseek-ai/dsh-scope')).href),
  import(pathToFileURL(workspaceRequire.resolve('@deepseek-ai/dsh-session')).href),
  import(pathToFileURL(workspaceRequire.resolve('@deepseek-ai/dsh-system-prompt')).href),
  import(pathToFileURL(workspaceRequire.resolve('@deepseek-ai/dsh-tools')).href),
  import(pathToFileURL(toolsRequire.resolve('@deepseek-ai/dsh-user-approval')).href),
])
const { Context } = cordisModule
const AgentRegistry = agentModule.default
const { createScope } = scopeModule
const { default: SessionStore, SessionId } = sessionModule
const SystemPrompt = systemPromptModule.default
const ToolRuntime = toolsModule.default
const ApprovalService = approvalModule.default

import ToolRuntimeMcpServer from '../../packages/mcp/mcp-server-tool-runtime/src/index.ts'

const execFileAsync = promisify(execFile)
const CANARY_HOST = process.env.DSH_CANARY_TOOL_RUNTIME_HOST ?? '127.0.0.1'
const CANARY_PORT = Number.parseInt(process.env.DSH_CANARY_TOOL_RUNTIME_PORT ?? '0', 10)
const EXPECTED_ENDPOINT = process.env.DSH_CANARY_EXPECTED_TOOL_RUNTIME_URL
  ?? (CANARY_PORT === 0 ? undefined : `http://${CANARY_HOST}:${CANARY_PORT}/mcp/tool-runtime`)
const SERVER_NAME = 'giana-code-tool-runtime'
const CANARY_AGENT_ID = 'putri-native-tools-canary'
const BLOCKER = 'CANONICAL_GIANAOS_ACP_LACKS_NONPERSISTING_SESSION_ATTACH_FOR_MCP_CANARY'
const root = fileURLToPath(new URL('../..', import.meta.url))

const sources = {
  adapter: fileURLToPath(new URL('../../packages/llm/llm-gianaos-acp/src/index.ts', import.meta.url)),
  runtime: fileURLToPath(new URL('../../packages/mcp/mcp-server-tool-runtime/src/index.ts', import.meta.url)),
  canonicalServer: 'N:\\GianaOS\\gianaos-agent\\acp_adapter\\server.py',
  canonicalSession: 'N:\\GianaOS\\gianaos-agent\\acp_adapter\\session.py',
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex').toUpperCase()
}

function definition(name, category, execute = async args => args) {
  return {
    name,
    description: `Read-only Giana Code canary capability: ${category}`,
    parameters: {
      type: 'object',
      properties: { nonce: { type: 'string' } },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 2_000,
    isConcurrencySafe: () => true,
    execute,
  }
}

function structuredResult(result) {
  return result.structuredContent?.result
}

async function rpc(endpoint, token, body, sessionId) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(sessionId === undefined ? {} : { 'Mcp-Session-Id': sessionId }),
    },
    body: JSON.stringify(body),
  })
  assert(response.ok, `MCP request failed with HTTP ${response.status}`)
  const text = await response.text()
  return {
    sessionId: response.headers.get('mcp-session-id') ?? sessionId,
    body: text === '' ? undefined : JSON.parse(text),
  }
}

async function auditSources() {
  const entries = await Promise.all(
    Object.entries(sources).map(async ([name, path]) => [name, path, await readFile(path, 'utf8')]),
  )
  const text = Object.fromEntries(entries.map(([name, _path, content]) => [name, content]))

  assert(text.adapter.includes('ctx.mcpToolRuntime.issue(agent)'), 'adapter does not issue a scoped ToolRuntime capability')
  assert(text.adapter.includes("name: 'giana-code-tool-runtime'"), 'adapter MCP server identity is missing')
  assert(text.adapter.includes('Authorization'), 'adapter does not project MCP authorization')
  assert(text.adapter.includes('Bearer ${capability.token}'), 'adapter does not project the scoped bearer capability')
  assert(text.adapter.includes('mcpServers'), 'adapter does not pass MCP servers to canonical ACP')
  assert(text.runtime.includes('this.ctx.tools.schemas(binding.agent)'), 'runtime does not list exact-agent schemas')
  assert(text.runtime.includes('this.ctx.agents.withInitiator(binding.agent'), 'runtime does not preserve exact initiator identity')
  assert(text.runtime.includes('agent/session that is not exactly live'), 'runtime exact live-object guard is missing')
  assert(text.canonicalServer.includes('async def _register_session_mcp_servers'), 'canonical ACP MCP registration hook is missing')
  assert(text.canonicalServer.includes('register_mcp_servers, config_map'), 'canonical ACP does not call MCP registration')
  assert(text.canonicalServer.includes('def _cmd_tools'), 'canonical ACP cannot enumerate its refreshed tool surface')

  const newSessionPersists = /def create_session[\s\S]*?self\._persist\(state\)/.test(text.canonicalSession)
  const loadSessionPersists = /def update_cwd[\s\S]*?self\._persist\(state\)/.test(text.canonicalSession)
  const registrationFollowsCreate = /async def new_session[\s\S]*?create_session\([\s\S]*?_register_session_mcp_servers/.test(text.canonicalServer)
  const registrationFollowsUpdate = /async def load_session[\s\S]*?update_cwd\([\s\S]*?_register_session_mcp_servers/.test(text.canonicalServer)
  assert(newSessionPersists && loadSessionPersists, 'canonical ACP persistence precondition changed; re-audit required')
  assert(registrationFollowsCreate && registrationFollowsUpdate, 'canonical ACP session-to-MCP ordering changed; re-audit required')

  return {
    hashes: Object.fromEntries(entries.map(([name, _path, content]) => [name, digest(content)])),
    adapterProjectsScopedEndpoint: true,
    canonicalRegistrationHookPresent: true,
    canonicalToolListingPresent: true,
    newSessionPersistsBeforeRegistration: true,
    loadSessionPersistsBeforeRegistration: true,
  }
}

async function initializeCanonicalAcp() {
  const canary = fileURLToPath(new URL('./canary-putri-acp.mjs', import.meta.url))
  const { stdout } = await execFileAsync(process.execPath, [canary], {
    cwd: root,
    encoding: 'utf8',
    timeout: 45_000,
    windowsHide: true,
    maxBuffer: 128 * 1024,
  })
  const line = stdout.trim().split(/\r?\n/).find(Boolean)
  const result = JSON.parse(line ?? '{}')
  assert(result.state === 'PASS', 'canonical ACP initialize canary did not pass')
  assert(
    result.agent === 'gianaos-agent' || result.agent === 'hermes-agent',
    'canonical ACP agent identity mismatch',
  )
  assert(result.loadSession === true, 'canonical ACP does not advertise session restoration')
  return {
    initialized: true,
    agent: result.agent,
    protocolVersion: result.protocolVersion,
    loadSession: true,
  }
}

async function mountScopedRuntime() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ApprovalService, {})
  await ctx.plugin(ToolRuntimeMcpServer, {
    host: CANARY_HOST,
    port: CANARY_PORT,
    path: '/mcp/tool-runtime',
  })

  const session = ctx.sessions.prepare(SessionId(CANARY_AGENT_ID))
  const disposeSession = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  const mutable = {
    id: session.id,
    options: {},
    session,
    inbox: {},
    status: 'idle',
    ctx,
    cancel() {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
  const agent = mutable
  let scope
  await ctx.plugin(Object.assign(
    inner => { scope = createScope(inner, agent) },
    { inject: ['tools', 'systemPrompt'] },
  ))
  mutable.ctx = scope.ctx
  const disposeAgent = ctx.agents.enter(agent, undefined)
  ctx.agents.announce(agent)

  return {
    ctx,
    agent,
    scope,
    session,
    disposeAgent,
    disposeSession,
    async dispose() {
      disposeAgent()
      disposeSession()
      await ctx.fiber.dispose()
    },
  }
}

async function proveScopedRuntime(runtime) {
  let harmlessRuns = 0
  let exactInitiator = false
  runtime.scope.ctx.tools.register(definition('goal_capability_canary', 'goal lifecycle'))
  runtime.scope.ctx.tools.register(definition('skill_capability_canary', 'skill discovery and invocation'))
  runtime.scope.ctx.tools.register(definition('tool_capability_canary', 'tool inventory'))
  runtime.scope.ctx.tools.register(definition('native_noop_canary', 'harmless native invocation', async (args, exec) => {
    harmlessRuns += 1
    exactInitiator = exec.agent === runtime.agent
    return { acknowledged: true, nonce: args.nonce }
  }))

  const capability = runtime.ctx.mcpToolRuntime.issue(runtime.agent)
  if (EXPECTED_ENDPOINT !== undefined) {
    assert(capability.endpoint === EXPECTED_ENDPOINT, 'scoped endpoint differs from the expected ACP projection')
  }
  try {
    const initialized = await rpc(capability.endpoint, capability.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'putri-native-tools-canary', version: '1' },
      },
    })
    assert(initialized.sessionId !== undefined, 'MCP initialize did not return a session id')
    await rpc(capability.endpoint, capability.token, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }, initialized.sessionId)
    const listed = await rpc(capability.endpoint, capability.token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }, initialized.sessionId)
    const names = (listed.body?.result?.tools ?? []).map(tool => tool.name).sort()
    for (const expected of [
      'goal_capability_canary',
      'skill_capability_canary',
      'tool_capability_canary',
      'native_noop_canary',
    ]) {
      assert(names.includes(expected), `representative capability missing: ${expected}`)
    }
    const called = await rpc(capability.endpoint, capability.token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'native_noop_canary',
        arguments: { nonce: 'public-canary-nonce' },
      },
    }, initialized.sessionId)
    const result = structuredResult(called.body?.result ?? {})
    assert(result?.isError === false, 'harmless ToolRuntime invocation failed')
    assert(result?.value?.acknowledged === true, 'harmless ToolRuntime acknowledgement missing')
    assert(result?.value?.nonce === 'public-canary-nonce', 'harmless ToolRuntime nonce mismatch')
    assert(harmlessRuns === 1 && exactInitiator, 'harmless ToolRuntime invocation lost exact-agent identity')
    return {
      endpoint: capability.endpoint,
      serverName: SERVER_NAME,
      representativeCapabilities: names,
      harmlessInvocation: 'PASS',
      exactAgentScope: true,
      credentialInOutput: false,
    }
  } finally {
    await capability.revoke().catch(() => {})
  }
}

async function main() {
  let runtime
  let stage = 'source-audit'
  try {
    const sourceAudit = await auditSources()
    stage = 'scoped-runtime'
    runtime = await mountScopedRuntime()
    const scopedRuntime = await proveScopedRuntime(runtime)
    stage = 'canonical-acp-initialize'
    const canonicalAcp = await initializeCanonicalAcp()

    process.stdout.write(`${JSON.stringify({
      state: 'HELD_WITH_EXACT_FINITE_BLOCKER',
      blocker: BLOCKER,
      finiteResumePredicate: 'ADD_A_CANONICAL_ACP_NO_PERSIST_EPHEMERAL_SESSION_ATTACH_OR_TOOL_CANARY_METHOD_THAT_ACCEPTS_SCOPED_MCP_SERVERS_WITHOUT_CALLING_SESSIONMANAGER_PERSIST',
      proven: {
        sourceAudit,
        scopedRuntime,
        canonicalAcp,
      },
      notClaimed: {
        canonicalPutriReceivedEndpointAtRuntime: false,
        canonicalPutriListedGianaCodeToolsAtRuntime: false,
        canonicalPutriInvokedGianaCodeToolAtRuntime: false,
      },
      reason: 'Both canonical ACP newSession and loadSession persist protected session state before MCP registration; the canary stopped before either call.',
      protectedEffects: {
        personaCopies: 0,
        memoryCopies: 0,
        sessionCopies: 0,
        databaseWrites: 0,
        modelCalls: 0,
        protectedRuntimeMutations: 0,
      },
    }, null, 2)}\n`)
  } catch {
    process.stdout.write(`${JSON.stringify({
      state: 'HELD_WITH_EXACT_FINITE_BLOCKER',
      blocker: `CANARY_STAGE_${stage.toUpperCase().replaceAll('-', '_')}_FAILED`,
      finiteResumePredicate: `RESTORE_${stage.toUpperCase().replaceAll('-', '_')}_PRECONDITIONS_AND_RERUN_CANARY`,
      protectedEffects: {
        personaCopies: 0,
        memoryCopies: 0,
        sessionCopies: 0,
        databaseWrites: 0,
        modelCalls: 0,
        protectedRuntimeMutations: 0,
      },
    }, null, 2)}\n`)
    process.exitCode = 2
  } finally {
    await runtime?.dispose().catch(() => {})
  }
}

await main()
