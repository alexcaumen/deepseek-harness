import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'

interface PatchEntry {
  id?: string
  name?: string
  disabled?: boolean
  config?: Record<string, unknown>
  insert?: PatchEntry[]
}

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const PATCH_PATH = join(REPO_ROOT, 'configs', 'giana-code-putri.patch.yml')
const BASE_MANIFEST_PATH = join(REPO_ROOT, 'packages', 'bundle', 'base', 'package.json')

function entriesFromPatch(): PatchEntry[] {
  const parsed: unknown = yaml.load(readFileSync(PATCH_PATH, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError('the Giana CoWork patch must parse to an entry array')
  return (parsed as PatchEntry[]).flatMap(entry => Array.isArray(entry.insert) ? entry.insert : [entry])
}

function entryById(entries: PatchEntry[], id: string): PatchEntry {
  const matches = entries.filter(entry => entry.id === id)
  if (matches.length !== 1) throw new TypeError(`expected exactly one ${id} patch entry, found ${String(matches.length)}`)
  return matches[0] as PatchEntry
}

function configById(entries: PatchEntry[], id: string): Record<string, unknown> {
  const config = entryById(entries, id).config
  if (config === undefined) throw new TypeError(`the ${id} patch entry must have config`)
  return config
}

function evaluatedString(value: unknown, env: Record<string, string>): string {
  const evaluated: unknown = value !== null && typeof value === 'object' && '__jsExpr' in value
    ? evaluate({ process: { env } }, (value as { __jsExpr: string }).__jsExpr) as unknown
    : value
  if (typeof evaluated !== 'string') throw new TypeError('the runtime path must evaluate to a string')
  return evaluated
}

function evaluatedBoolean(value: unknown, env: Record<string, string>): boolean {
  const evaluated: unknown = value !== null && typeof value === 'object' && '__jsExpr' in value
    ? evaluate({ process: { env } }, (value as { __jsExpr: string }).__jsExpr) as unknown
    : value
  if (typeof evaluated !== 'boolean') throw new TypeError('the runtime switch must evaluate to a boolean')
  return evaluated
}

describe('Giana CoWork runtime binding', () => {
  it('adds model lifecycle without replacing the established plugin composition', () => {
    const entries = entriesFromPatch()

    expect(entries.map(entry => [entry.id, entry.name, entry.disabled])).toEqual([
      ['tools', undefined, undefined],
      ['model-lifecycle', '@deepseek-ai/dsh-model-lifecycle', undefined],
      ['giana-cowork-model-deployment', '@deepseek-ai/dsh-giana-cowork-model-deployment', undefined],
      ['llm-gianaos-acp', '@grinviro/dsh-llm-gianaos-acp', undefined],
      ['llm-princess-os', '@grinviro/dsh-llm-princess-os', undefined],
      ['web-runtime', undefined, undefined],
      ['approval', undefined, undefined],
      ['permission', undefined, undefined],
      ['client-hmr', undefined, true],
      ['dsh-office', '@huiliyi37/dsh-office', undefined],
      ['mcp-markitdown', '@deepseek-ai/dsh-mcp-client', undefined],
      ['mcp-playwright', '@deepseek-ai/dsh-mcp-client', undefined],
      ['mcp-connectors', '@deepseek-ai/dsh-mcp-client', undefined],
      ['mcp-windows-desktop', '@deepseek-ai/dsh-mcp-client', undefined],
      ['tool-access-policy', '@grinviro/dsh-tool-access-policy', undefined],
      ['subagent-codex', '@deepseek-ai/dsh-subagent-codex', undefined],
      ['subagent-claude-code', '@deepseek-ai/dsh-subagent-claude-code', undefined],
      ['mcp-tool-runtime', '@deepseek-ai/dsh-mcp-server-tool-runtime', undefined],
    ])
    expect(configById(entries, 'model-lifecycle')).toEqual({ preference: 'automatic' })
    expect(configById(entries, 'giana-cowork-model-deployment')).toMatchObject({
      sshHost: 'r5300',
      principalId: 'alex',
      tenantId: 'giana-cowork-preview',
      admissionDigest: '4978787ea7d990e513c7737cf911a2469b40ff17e28ee4b20db73c6cb24b0bbd',
      targets: [{
        class: 'r5300',
        identityDigest: '49426230ec7354353db3c1f8ea8880803701b00ce8cdd8c15dfbaccb087bd2c7',
        currentnessDigest: '40ba00bc258fee097427502c53a317b791fc001cf8462e41c6ce042fa9507ec7',
      }],
      routes: [
        {
          id: 'glm53-official-fp8', provider: 'glm-local-r5300',
          model: 'GLM-5.3-Flash-official-fp8-canary', disposition: 'AVAILABLE',
          allowExactResidentAdoption: true,
        },
        {
          id: 'qwen38-local', provider: 'qwen-local-r5300',
          model: 'Qwen/Qwen3.8-27B', disposition: 'AVAILABLE',
          allowExactResidentAdoption: true,
        },
      ],
    })
    expect(entries.some(entry => entry.id === 'system-prompt')).toBe(false)
  })

  it('enables desktop shutdown only for a wrapper-owned launch', () => {
    const webRuntime = configById(entriesFromPatch(), 'web-runtime')

    expect(evaluatedBoolean(webRuntime.desktopShutdown, {})).toBe(false)
    expect(evaluatedBoolean(webRuntime.desktopShutdown, {
      GIANA_COWORK_DESKTOP_SHUTDOWN_TOKEN: 'a'.repeat(64),
    })).toBe(true)
  })

  it('keeps lifecycle, terminal, browser, and subagent tools in the packaged base dependency closure', () => {
    const manifest = JSON.parse(readFileSync(BASE_MANIFEST_PATH, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const dependencies = manifest.dependencies ?? {}
    for (const dependency of [
      '@deepseek-ai/dsh-model-lifecycle',
      '@deepseek-ai/dsh-mcp-server-tool-runtime',
      '@deepseek-ai/dsh-subagent',
      '@deepseek-ai/dsh-subagent-claude-code',
      '@deepseek-ai/dsh-subagent-codex',
      '@deepseek-ai/dsh-subagent-fork-in-process',
      '@deepseek-ai/dsh-subagent-spawn-in-process',
      '@deepseek-ai/dsh-tool-bash',
      '@deepseek-ai/dsh-tool-pwsh',
      '@deepseek-ai/dsh-tool-subagent',
      '@deepseek-ai/dsh-tool-subagent-control',
      '@deepseek-ai/dsh-tool-subagent-report',
    ]) expect(dependencies[dependency]).toBe('workspace:^')
  })

  it('preserves history-stable model identity, profiles, and tool bindings', () => {
    const entries = entriesFromPatch()
    const gianaOs = configById(entries, 'llm-gianaos-acp')
    const princessOs = configById(entries, 'llm-princess-os')

    expect(gianaOs).toMatchObject({
      providerId: 'gianaos',
      providerName: 'GianaOS',
      modelId: 'putri',
      modelName: 'Putri',
      principalId: 'giana.putri',
      routeRevision: 'giana-code-acp-native-v1',
      remoteWorkspace: '/srv/gianaos-data/objects/putri',
      remoteToolRuntimeUrl: 'http://127.0.0.1:18644/mcp/tool-runtime',
      permission: 'allow',
      contextWindow: 1_000_000,
      maxTokens: 131_072,
    })
    expect(princessOs).toMatchObject({
      providerId: 'princess-os',
      providerName: 'Princess OS',
      credentialEnv: 'DEEPSEEK_API_KEY',
      permission: 'allow',
      agents: [{
        id: 'lara',
        name: 'Lara',
        hermesHome: 'N:\\PrincessOS\\agents\\lara\\home',
        ownerPrivateWindowsBindingSha256: '',
      }],
    })
    expect(configById(entries, 'approval')).toEqual({ policy: 'ask' })
    expect(configById(entries, 'permission')).toEqual({
      reconcileExistingPresets: ['danger-full-access'],
      presets: {
        'read-only': { sandbox: 'read-only', approval: 'ask' },
        'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
        'danger-full-access': { sandbox: 'danger-full-access', approval: 'ask' },
      },
    })
    expect(configById(entries, 'dsh-office')).toEqual({
      enable: { xlsx: true, pdf: true, ppt: true, docx: true },
    })
    expect(configById(entries, 'mcp-markitdown')).toEqual({
      serverName: 'markitdown',
      transport: 'stdio',
      command: 'N:\\PrincessOS\\workbench\\third-party\\markitdown-mcp-venv-20260822\\Scripts\\markitdown-mcp.exe',
      cwd: 'N:\\PrincessOS\\workbench\\third-party\\markitdown-mcp-venv-20260822',
    })
    expect(configById(entries, 'mcp-connectors')).toEqual({
      serverName: 'connectors',
      transport: 'streamable-http',
      url: 'http://127.0.0.1:17301/mcp',
      headersFromEnv: { Authorization: 'OOMOL_CONNECT_RUNTIME_AUTHORIZATION' },
      toolCallTimeoutMs: 120_000,
      failOnStartupError: false,
      reconnect: {
        enabled: true,
        initialDelayMs: 500,
        maxDelayMs: 5_000,
        maxAttempts: 30,
      },
    })
    expect(configById(entries, 'mcp-windows-desktop')).toEqual({
      serverName: 'windows_desktop',
      transport: 'stdio',
      command: 'N:\\PrincessOS\\workbench\\third-party\\windows-computer-use-mcp-20260822\\.venv\\Scripts\\windows-computer-use-mcp.exe',
      cwd: 'N:\\PrincessOS\\workbench\\third-party\\windows-computer-use-mcp-20260822',
      env: {
        WINDOWS_COMPUTER_USE_MCP_BYPASS_HITL: '0',
        WINDOWS_COMPUTER_USE_MCP_KILL_SWITCH: '0',
        WINDOWS_COMPUTER_USE_MCP_DRY_RUN: '1',
        WINDOWS_COMPUTER_USE_MCP_ENABLE_FACE: '0',
        WINDOWS_COMPUTER_USE_MCP_ENABLE_KEYLOGGER: '0',
        WINDOWS_COMPUTER_USE_MCP_MAX_ACTIONS_PER_MINUTE: '240',
      },
      toolCallTimeoutMs: 120_000,
      failOnStartupError: true,
      reconnect: {
        enabled: true,
        initialDelayMs: 500,
        maxDelayMs: 5_000,
        maxAttempts: 3,
      },
    })
    expect(configById(entries, 'tool-access-policy')).toEqual({
      denyPatterns: [
        'mcp__windows_desktop__automation_face',
        'mcp__windows_desktop__global_keylogger',
      ],
      askPatterns: ['mcp__windows_desktop__*'],
    })
    expect(configById(entries, 'subagent-codex')).toEqual({
      providerName: 'codex',
      permissionMode: 'never',
    })
    expect(configById(entries, 'subagent-claude-code')).toEqual({
      providerName: 'claude-code',
      permissionMode: 'dontAsk',
    })
    expect(configById(entries, 'mcp-tool-runtime')).toEqual({
      host: '127.0.0.1',
      port: 18_644,
      path: '/mcp/tool-runtime',
    })
  })

  it('derives ACP and browser paths from the selected source and isolated home', () => {
    const isolatedHome = join(REPO_ROOT, '.test-giana-code-putri-home')
    const env = { DSH_SOURCE_ROOT: REPO_ROOT, DSH_HOME: isolatedHome }
    const entries = entriesFromPatch()
    const deployment = configById(entries, 'giana-cowork-model-deployment')
    const gianaOs = configById(entries, 'llm-gianaos-acp')
    const princessOs = configById(entries, 'llm-princess-os')
    const playwright = configById(entries, 'mcp-playwright')
    const managerScript = evaluatedString(deployment?.managerScript, env)
    const launchScript = evaluatedString(gianaOs?.launchScript, env)
    const playwrightArgs = playwright?.args

    expect(resolve(evaluatedString(gianaOs?.localWorkspace, env))).toBe(REPO_ROOT)
    expect(resolve(managerScript)).toBe(join(
      isolatedHome,
      'profiles',
      'web',
      'node_modules',
      '@deepseek-ai',
      'dsh-giana-cowork-model-deployment',
      'lib',
      'manager.js',
    ))
    expect(resolve(launchScript)).toBe(join(REPO_ROOT, 'scripts', 'princess-os', 'Start-GianaOsPutriAcp.mjs'))
    expect(existsSync(launchScript)).toBe(true)
    expect(resolve(evaluatedString(princessOs?.workspace, env))).toBe(REPO_ROOT)
    expect(Array.isArray(playwrightArgs)).toBe(true)
    const evaluatedArgs = (playwrightArgs as unknown[]).map(value => evaluatedString(value, env))
    expect(resolve(evaluatedArgs[0]!))
      .toBe(join(isolatedHome, 'profiles', 'web', 'node_modules', '@playwright', 'mcp', 'cli.js'))
    expect(resolve(evaluatedArgs[11]!)).toBe(join(REPO_ROOT, '.artifacts', 'playwright-mcp', 'output'))
    const pinnedArgs = [...evaluatedArgs]
    pinnedArgs[0] = '<isolated-playwright-cli>'
    pinnedArgs[11] = '<staging-output-directory>'
    expect(pinnedArgs).toEqual([
      '<isolated-playwright-cli>',
      '--isolated',
      '--headless',
      '--sandbox',
      '--browser',
      'chrome',
      '--caps',
      'vision,testing,devtools',
      '--image-responses',
      'allow',
      '--output-dir',
      '<staging-output-directory>',
      '--output-max-size',
      '104857600',
      '--block-service-workers',
      '--codegen',
      'typescript',
      '--snapshot-mode',
      'full',
      '--timeout-action',
      '10000',
      '--timeout-navigation',
      '60000',
    ])
    expect({ ...playwright, args: undefined }).toEqual({
      serverName: 'playwright',
      transport: 'stdio',
      command: 'C:\\Program Files\\nodejs\\node.exe',
      cwd: 'N:\\PrincessOS\\workbench\\ui-test-workspace',
      args: undefined,
      toolCallTimeoutMs: 120_000,
      failOnStartupError: true,
      reconnect: {
        enabled: true,
        initialDelayMs: 500,
        maxDelayMs: 5_000,
        maxAttempts: 3,
      },
    })
    expect(gianaOs?.description).toContain('Giana CoWork')
    expect(princessOs?.systemInstruction).toContain('Giana CoWork')
  })
})
