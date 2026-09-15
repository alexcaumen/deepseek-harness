import { createHash } from 'node:crypto'
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
  disabled?: unknown
  config?: Record<string, unknown>
  insert?: PatchEntry[]
}

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const PATCH_PATH = join(REPO_ROOT, 'configs', 'giana-code-putri.patch.yml')
const BASE_MANIFEST_PATH = join(REPO_ROOT, 'packages', 'bundle', 'base', 'package.json')
const PRDG_QWEN_START_PATH = join(
  REPO_ROOT, 'configs', 'giana-cowork-preview', 'runtime', 'prdg-qwen38-start.sh',
)
const MODEL_REGISTRY_PATH = join(
  REPO_ROOT, 'configs', 'giana-cowork-preview', 'gcp.model-registry.json',
)
const MODEL_ADMISSION_PATH = join(
  REPO_ROOT, 'configs', 'giana-cowork-preview', 'GCP_DUAL_TARGET_LOCAL_MODEL_PREVIEW_ADMISSION_20260915.json',
)
const GCP_PRESET_PATHS = ['standard', 'code', 'cordis'].map(name => ({
  name,
  path: join(REPO_ROOT, 'apps', 'cli', 'config', 'agent-presets', name, 'agent.cordis.yml'),
}))

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
  it.each(GCP_PRESET_PATHS)('enables collision-free model-selectable delegation in $name', ({ path }) => {
    const parsed: unknown = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema })
    expect(Array.isArray(parsed)).toBe(true)
    const delegation = (parsed as PatchEntry[]).find(entry => entry.id === 'delegation')
    const tools = delegation?.config as unknown as PatchEntry[]
    expect(Array.isArray(tools)).toBe(true)
    const byId = (id: string): Record<string, unknown> => {
      const config = tools.find(entry => entry.id === id)?.config
      if (config === undefined) throw new TypeError(`missing ${id} preset config`)
      return config
    }
    const spawn = byId('tool-subagent')
    const fork = byId('tool-subagent-fork')
    const codex = byId('tool-subagent-codex')
    const astra = byId('tool-subagent-codex-astra')
    const spawnPolicy = spawn.modelSelectionPolicy as {
      discoveryToolName: string
      allowedModels: Array<{ provider: string; model: string }>
    }
    const forkPolicy = fork.modelSelectionPolicy as typeof spawnPolicy
    const codexPolicy = codex.modelSelectionPolicy as {
      preflight: string
      discoveryToolName: string
      allowedModels: Array<{ provider: string; model: string }>
    }

    expect(spawnPolicy.discoveryToolName).toBe('list_subagent_models')
    expect(spawnPolicy.allowedModels).toContainEqual({ provider: 'gianaos', model: 'putri' })
    expect(spawnPolicy.allowedModels).toContainEqual({
      provider: 'glm-uncensored-local-r5300', model: 'glm-5.3-flash-uncensored-fp8',
    })
    expect(forkPolicy.discoveryToolName).toBe('list_subagent_fork_models')
    expect(forkPolicy.allowedModels).toEqual(spawnPolicy.allowedModels)
    expect(codexPolicy.preflight).toBe('provider')
    expect(codexPolicy.discoveryToolName).toBe('list_codex_subagent_models')
    expect(codexPolicy.allowedModels.some(route =>
      route.provider === 'codex-native' && route.model === 'gpt-6-astra')).toBe(true)
    expect(codexPolicy.allowedModels.some(route =>
      route.provider === 'codex-native' && route.model === 'gpt-5.6-sol')).toBe(true)
    expect(astra.agentOptions).toEqual({
      provider: 'codex-native',
      model: 'gpt-6-astra',
      reasoningEffort: 'high',
    })
    expect(new Set([
      spawnPolicy.discoveryToolName,
      forkPolicy.discoveryToolName,
      codexPolicy.discoveryToolName,
    ]).size).toBe(3)
  })

  it('pins exact PRDG Qwen artifacts and closes lifecycle lock descriptors before detach', () => {
    const launcher = readFileSync(PRDG_QWEN_START_PATH, 'utf8')
    expect(launcher).toContain('manifest_sha256=961f81d06097db0c87867559913adab5bf6692998b7af423cea859867b30c7b2')
    expect(launcher).toContain('model_commit=1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0')
    expect(launcher).toContain('--model "${model}"')
    expect(launcher).toContain('8>&- 9>&-')
    expect(launcher).toContain('digest.hexdigest() != entry["sha256"]')
  })

  it('binds the exact admitted route set across admission, registry, and runtime patch', () => {
    const launcherDigest = createHash('sha256').update(readFileSync(PRDG_QWEN_START_PATH)).digest('hex')
    const registry = JSON.parse(readFileSync(MODEL_REGISTRY_PATH, 'utf8')) as {
      admissionDigest: string
      targets: Array<{ class: string; currentness_digest: string }>
      routes: Array<{
        id: string
        revisionDigest: string
        target: string
        runtime: { startSha256?: string; launcherSha256?: string; expectedModel: string }
      }>
    }
    const admissionBytes = readFileSync(MODEL_ADMISSION_PATH)
    const admissionDigest = createHash('sha256').update(admissionBytes).digest('hex')
    const admission = JSON.parse(admissionBytes.toString('utf8')) as {
      target_currentness: Array<{ target: string; digest: string }>
      routes: Array<{
        id: string
        provider: string
        model: string
        revision_digest: string
        targets: string[]
        context_window?: number
        max_output_tokens?: number
      }>
    }
    const patch = configById(entriesFromPatch(), 'giana-cowork-model-deployment')
    const patchRoutes = patch.routes as Array<{
      id: string
      provider: string
      model: string
      targets?: string[]
      admissionReceiptDigest?: string
      revisionDigest?: string
    }>
    const expectedRouteIds = [
      'glm53-official-fp8',
      'qwen38-local',
      'glm53-uncensored-fp8',
      'deepseek-v4-flash-vision-regular',
      'deepseek-v4-flash-vision-uncensored',
    ]

    expect(launcherDigest).toBe('fea57d07515d4615b8c851230ae849a18ee17bccde8a93a70aaeb0ae16669ad0')
    expect(registry.admissionDigest).toBe(admissionDigest)
    expect(patch.admissionDigest).toBe(admissionDigest)
    expect(admission.routes.map(route => route.id)).toEqual(expectedRouteIds)
    expect(patchRoutes.map(route => route.id)).toEqual(expectedRouteIds)
    expect([...new Set(registry.routes.map(route => route.id))]).toEqual(expectedRouteIds)
    expect((patch.targets as Array<{ class: string; currentnessDigest: string }>).map(target => ({
      target: target.class, digest: target.currentnessDigest,
    }))).toEqual(admission.target_currentness.map(target => ({ target: target.target, digest: target.digest })))
    expect(registry.targets.map(target => ({ target: target.class, digest: target.currentness_digest })))
      .toEqual(admission.target_currentness.map(target => ({ target: target.target, digest: target.digest })))

    for (const route of admission.routes) {
      expect(patchRoutes.find(candidate => candidate.id === route.id)).toMatchObject({
        provider: route.provider,
        model: route.model,
        targets: route.targets,
        admissionReceiptDigest: `sha256:${admissionDigest}`,
        revisionDigest: `sha256:${route.revision_digest}`,
      })
      for (const target of route.targets) {
        expect(registry.routes.find(candidate => candidate.id === route.id && candidate.target === target)).toMatchObject({
          revisionDigest: route.revision_digest,
          runtime: { expectedModel: route.model },
        })
      }
    }

    expect(registry.routes.find(route => route.id === 'qwen38-local' && route.target === 'prdg')?.runtime.startSha256)
      .toBe(launcherDigest)
    expect(admission.routes.find(route => route.id === 'qwen38-local')).toMatchObject({
      targets: ['r5300', 'prdg'],
      context_window: 32_768,
      max_output_tokens: 4_096,
    })
    expect(registry.routes.find(route => route.id === 'glm53-uncensored-fp8')?.runtime.launcherSha256)
      .toBe('3d047fd20ba2cc9ef7bb1755f9e240a0f471b9abb8537f655400765c656a23e7')
    expect(registry.routes.find(route => route.id === 'deepseek-v4-flash-vision-regular')?.runtime.launcherSha256)
      .toBe('b7e9e7c6953a279c3a418d281629cde087b98dbd360788a47bca0e8c24abdaea')
    expect(registry.routes.find(route => route.id === 'deepseek-v4-flash-vision-uncensored')?.runtime.launcherSha256)
      .toBe('a0964a55414c86e7ec80a817c4296946469be8cede29e4b3c31f20fb4563f959')
    for (const id of expectedRouteIds) {
      expect(patchRoutes.filter(route => route.id === id)).toHaveLength(1)
    }
    expect(patchRoutes.find(route => route.id === 'qwen38-local')).toMatchObject({
      targets: ['r5300', 'prdg'], admissionReceiptDigest: `sha256:${admissionDigest}`,
    })
  })

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
      ['subagent-codex', '@deepseek-ai/dsh-subagent-codex', {
        __jsExpr: '!process.env.GIANA_CODEX_ACTIVE_HOME',
      }],
      ['subagent-codex-astra', '@deepseek-ai/dsh-subagent-codex', {
        __jsExpr: '!process.env.GIANA_CODEX_ACTIVE_HOME',
      }],
      ['subagent-claude-code', '@deepseek-ai/dsh-subagent-claude-code', undefined],
      ['mcp-tool-runtime', '@deepseek-ai/dsh-mcp-server-tool-runtime', undefined],
    ])
    expect(configById(entries, 'tools')).toMatchObject({
      onDemand: {
        providers: [
          'glm-local-r5300',
          'qwen-local-r5300',
          'glm-uncensored-local-r5300',
          'deepseek-vision-local-r5300',
          'deepseek-vision-uncensored-local-r5300',
        ],
        alwaysAvailable: ['read', 'skill', 'skill_search'],
        maxSearchResults: 4,
        maxActiveTools: 16,
      },
    })
    expect(configById(entries, 'model-lifecycle')).toEqual({
      preference: 'automatic',
      idleUnloadMs: 0,
      preserveResidentOnShutdown: true,
    })
    const admissionDigest = createHash('sha256').update(readFileSync(MODEL_ADMISSION_PATH)).digest('hex')
    expect(configById(entries, 'giana-cowork-model-deployment')).toMatchObject({
      principalId: 'alex',
      tenantId: 'giana-cowork-preview',
      admissionDigest,
      runners: [
        { target: 'r5300', kind: 'ssh', host: 'r5300' },
        { target: 'prdg', kind: 'wsl', distribution: 'Ubuntu-22.04' },
      ],
      targets: [
        {
          class: 'r5300',
          identityDigest: '91eda62878736036ed54fa46478df41b8bb3dd8fb6b4103a21cc7357eaa56ffa',
          currentnessDigest: 'f5528cccb65aecbfa4294550ba21864faaa492b735fddc3f855e5f3abf79b5c8',
        },
        {
          class: 'prdg',
          identityDigest: 'bf7a58918d355c553f4852af75b3875e208d140a5060fe62cb4215cfceae64c5',
          currentnessDigest: 'f0be0b93921bce3b37628aad744c22f7559347ab720c0a6878c2cc48d95d7af6',
        },
      ],
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
          targets: ['r5300', 'prdg'],
          supportedReasoningEfforts: ['low', 'medium', 'xhigh'],
        },
        {
          id: 'glm53-uncensored-fp8', provider: 'glm-uncensored-local-r5300',
          model: 'glm-5.3-flash-uncensored-fp8', disposition: 'AVAILABLE',
          allowExactResidentAdoption: true,
          targets: ['r5300'],
        },
        {
          id: 'deepseek-v4-flash-vision-regular', provider: 'deepseek-vision-local-r5300',
          model: 'deepseek-v4-flash-vision-exp-unsloth-ud-q8-k-xl', disposition: 'AVAILABLE',
          allowExactResidentAdoption: true,
          targets: ['r5300'],
        },
        {
          id: 'deepseek-v4-flash-vision-uncensored', provider: 'deepseek-vision-uncensored-local-r5300',
          model: 'deepseek-v4-flash-vision-uncensored-derived-q8-0', disposition: 'AVAILABLE',
          allowExactResidentAdoption: true,
          targets: ['r5300'],
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
      env: {
        CODEX_HOME: { __jsExpr: 'process.env.GIANA_CODEX_ACTIVE_HOME' },
      },
      permissionMode: 'never',
    })
    expect(configById(entries, 'subagent-codex-astra')).toEqual({
      providerName: 'codex-astra',
      model: 'gpt-6-astra',
      env: {
        CODEX_HOME: { __jsExpr: 'process.env.GIANA_CODEX_ACTIVE_HOME' },
      },
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

  it('waits for the entire owned PRDG Qwen process group before removing its PID handle', () => {
    const stop = readFileSync(join(
      REPO_ROOT,
      'configs',
      'giana-cowork-preview',
      'runtime',
      'prdg-qwen38-stop.sh',
    ), 'utf8')

    expect(stop).toContain('test -r "/proc/${pid}/environ"')
    expect(stop).toContain('grep -Fqx -- "GCP_PROCESS_MARKER=${marker}"')
    expect(stop).toContain('pgid=$(ps -o pgid= -p "${pid}" | tr -d \' \')')
    expect(stop).toContain('snapshot=$(ps -eo pgid=,stat=)')
    expect(stop).toContain('$1 == target && $2 !~ /^Z/')
    expect(stop).not.toContain('kill -0 "${pid}"')

    const termIndex = stop.indexOf('kill -TERM -- "-${pgid}"')
    const killIndex = stop.indexOf('kill -KILL -- "-${pgid}"')
    expect(termIndex).toBeGreaterThan(-1)
    expect(killIndex).toBeGreaterThan(termIndex)
    expect(stop.slice(termIndex, killIndex)).toContain('if remove_pid_handle_if_stopped; then')
    expect(stop.slice(killIndex)).toContain('if remove_pid_handle_if_stopped; then')
    expect(stop.match(/rm -f -- "\$\{pid_file\}"/g)).toHaveLength(1)
    const removalFunction = stop.slice(stop.indexOf('remove_pid_handle_if_stopped() {'), termIndex)
    expect(removalFunction).toContain('if pgid_has_live_process; then')
    expect(removalFunction).toContain('return 1')
    expect(removalFunction).toContain('rm -f -- "${pid_file}"')
    expect(stop.trimEnd()).toMatch(/sleep 1\ndone\nexit 76$/)
  })
})
