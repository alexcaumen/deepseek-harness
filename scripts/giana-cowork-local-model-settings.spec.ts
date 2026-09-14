import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveProfiles, type PiAiProviderProfile } from '../packages/llm/llm-pi-ai/src/config.ts'
import {
  mergeLocalModelSettings, parseSettingsDocument, stageLocalModelSettings, validateNPath, validateSourceSettingsPath,
  type MergeOptions, type StageOptions,
} from './giana-cowork-local-model-settings.ts'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'

const PROVIDER = 'glm-local-r5300'
const MODEL = 'GLM-5.3-Flash-official-fp8-canary'
const BASE_URL = 'http://127.0.0.1:49177/v1'
const NOW = Date.parse('2026-09-05T10:00:00Z')
const FAKE_SECRET = 'TEST_ONLY_NOT_A_REAL_CREDENTIAL'
const script = fileURLToPath(new URL('./giana-cowork-local-model-settings.ts', import.meta.url))
const repo = fileURLToPath(new URL('..', import.meta.url))

function evidence() {
  return {
    routeReady: true,
    verified: true,
    lazyDriver: { verified: true, loadAtFirstRequest: true },
    provider: PROVIDER,
    model: MODEL,
    baseURL: BASE_URL,
    verifiedAt: '2026-09-05T09:55:00Z',
    expiresAt: '2026-09-05T10:05:00Z',
    checks: { text: true, image: true, totalContext65536: true, maxTokens1024: true, reasoningHigh: true },
  }
}

function options(patch: Partial<MergeOptions> = {}): MergeOptions {
  return { baseURL: BASE_URL, readiness: evidence(), now: NOW, ...patch }
}

function sourceSettings() {
  return {
    'llm-pi-ai': {
      preference: { keep: true },
      providers: {
        openai: { apiKeyEnv: 'TEST_ONLY_KEY_REF', headers: { 'x-test': FAKE_SECRET } },
        qwen: { models: [{ id: 'qwen-general', name: 'Local General Model' }], reasoning: 'medium' },
      },
    },
    'agent-default-model': { provider: 'qwen', model: 'qwen-general', reasoningEffort: 'medium', custom: 17 },
    'ui-theme': { preference: 'dark' },
    'permissions': { preset: 'custom', rules: ['keep'] },
    'sessions': { old: { provider: 'qwen', model: 'qwen-general', reasoningEffort: 'max', maxTokens: 8192 } },
  }
}

function prepared(source: Record<string, unknown> = sourceSettings(), patch: Partial<MergeOptions> = {}) {
  const result = mergeLocalModelSettings(source, options(patch))
  if (result.status !== 'prepared') throw new Error('Expected a prepared test candidate')
  return result
}

function providers(settings: Record<string, unknown>): Record<string, PiAiProviderProfile> {
  return (settings['llm-pi-ai'] as { providers: Record<string, PiAiProviderProfile> }).providers
}

function freeze(value: object): void {
  Object.freeze(value)
  for (const item of Object.values(value) as unknown[]) if (item && typeof item === 'object') freeze(item)
}

describe('local-model candidate merge', () => {
  it('accepts an empty settings file as an empty namespace map', () => {
    expect(parseSettingsDocument('')).toEqual({})
    expect(parseSettingsDocument('# no user preferences yet\n')).toEqual({})
    expect(prepared(parseSettingsDocument('')).settings['agent-default-model']).toMatchObject({ provider: PROVIDER, model: MODEL })
  })

  it('preserves profiles, preferences, and old selections without mutating frozen input', () => {
    const source = sourceSettings()
    const before = structuredClone(source)
    freeze(source)
    const result = prepared(source)
    expect(source).toEqual(before)
    for (const key of ['ui-theme', 'permissions', 'sessions']) {
      expect(result.settings[key]).toEqual(before[key as keyof typeof before])
    }
    expect(providers(result.settings).openai).toEqual(before['llm-pi-ai'].providers.openai)
    expect(providers(result.settings).qwen).toEqual(before['llm-pi-ai'].providers.qwen)
    expect(result.settings['agent-default-model']).toEqual({
      provider: PROVIDER, model: MODEL, reasoningEffort: 'high', custom: 17,
    })
    expect(result.heldProviders).toEqual({})
  })

  it('declares the exact canary and resolves a real adapter request cap without a server', () => {
    const profile = providers(prepared({}).settings)[PROVIDER]!
    expect(profile).toMatchObject({
      displayName: 'GLM 5.3 Flash Official FP8 (Local)',
      api: 'openai-completions', baseURL: BASE_URL, reasoning: 'high',
      availabilityProbe: { model: MODEL, timeoutMs: 10_000, phase: 'dispatch' },
      models: [{
        id: MODEL, name: 'GLM 5.3 Flash Official FP8 (Local)',
        contextWindow: 65_536, maxTokens: 1024,
        input: ['text', 'image'], reasoningEfforts: { high: 'high' },
      }],
    })
    const resolved = resolveProfiles({ [PROVIDER]: profile }).get(PROVIDER)!
    expect(resolved.configuredMaxTokens.get(MODEL)).toBe(1024)
    expect(resolved.reasoning).toBe('high')
    expect(resolved.piProvider.getModels()[0]).toMatchObject({ contextWindow: 65_536, maxTokens: 1024, input: ['text', 'image'] })
    expect(profile.apiKeyEnv).toBeUndefined()
    expect(profile.compat).toBeUndefined()
    expect(profile.models?.[0]?.compat).toBeUndefined()
  })

  it('replaces a prior target catalog with the one admitted model while preserving profile preferences', () => {
    const source = { 'llm-pi-ai': { providers: { [PROVIDER]: {
      apiKeyEnv: 'TEST_ONLY_GLM_KEY_REF', timeoutMs: 1234, reasoning: 'max',
      models: [{ id: 'retained' }, { id: MODEL, maxTokens: 9999, reasoningEfforts: { max: 'max' }, note: 'keep' }],
    } } } }
    const first = prepared(source)
    const profile = providers(first.settings)[PROVIDER]!
    expect(profile).toMatchObject({ timeoutMs: 1234, apiKeyEnv: 'TEST_ONLY_GLM_KEY_REF', reasoning: 'high' })
    expect(profile.models).toEqual([expect.objectContaining({ id: MODEL, note: 'keep', maxTokens: 1024 })])
    expect(prepared(first.settings).settings).toEqual(first.settings)
    expect(profile.models?.filter(model => model.id === MODEL)).toHaveLength(1)
  })

  it('keeps an admitted Qwen route selectable but probes it only after lifecycle dispatch', () => {
    const qwen = {
      displayName: 'Qwen3.8-27B', api: 'openai-completions', baseURL: 'http://127.0.0.1:49178/v1',
      models: [{ id: 'Qwen/Qwen3.8-27B', contextWindow: 1_000_000, maxTokens: 131_072 }],
    }
    const result = prepared({ 'llm-pi-ai': { providers: { 'qwen-local-r5300': qwen } } })
    expect(providers(result.settings)['qwen-local-r5300']).toEqual({
      ...qwen,
      availabilityProbe: { model: 'Qwen/Qwen3.8-27B', timeoutMs: 10_000, phase: 'dispatch' },
      models: [{
        id: 'Qwen/Qwen3.8-27B', name: 'Qwen3.8-27B', contextWindow: 32_768, maxTokens: 4_096,
      }],
    })
    const resolved = resolveProfiles({
      'qwen-local-r5300': providers(result.settings)['qwen-local-r5300']!,
    }).get('qwen-local-r5300')!
    expect(resolved.configuredMaxTokens.get('Qwen/Qwen3.8-27B')).toBe(4_096)
    expect(resolved.piProvider.getModels()[0]).toMatchObject({ contextWindow: 32_768, maxTokens: 4_096 })
    expect(prepared(result.settings).settings).toEqual(result.settings)
  })

  it.each(['glm-uncensored-local-r5300', 'deepseek-vision-local-r5300', 'deepseek-vision-uncensored-local-r5300'])(
    'removes held route %s from the active selector', (id) => {
      const profile = { displayName: 'Held local model', models: [{ id: 'held-model' }] }
      const result = prepared({ 'llm-pi-ai': { providers: { [id]: profile } } })
      expect(providers(result.settings)[id]).toBeUndefined()
      expect(result.heldProviders[id]).toEqual(profile)
    },
  )

  it.each(['model.glm53.flash.orcasaq.mlx.mixed456.local', 'OrcaSAQ-local', 'glm-orca-saq-mlx', 'Orca_SAQ'])('holds explicit OrcaSAQ route %s', (id) => {
    const profile = { models: [{ id: 'something' }], apiKeyEnv: 'TEST_ONLY_REF' }
    const result = prepared({ 'llm-pi-ai': { providers: { [id]: profile } } })
    expect(providers(result.settings)[id]).toBeUndefined()
    expect(result.heldProviders[id]).toEqual(profile)
  })

  it('holds explicitly named profiles and models but never matches generic descriptions or URLs', () => {
    const source = { 'llm-pi-ai': { providers: {
      named: { displayName: 'GLM 5.3 Flash OrcaSAQ MLX Mixed 4/5/6-bit' },
      mixed: { apiKeyEnv: 'KEEP', models: [{ id: 'safe' }, { id: 'glm', name: 'OrcaSAQ local' }] },
      only: { models: [{ id: 'glm-orcasaq' }] },
      inherited: { modelOverrides: { 'glm-orcasaq': { maxTokens: 100 } } },
      'glm-local': { displayName: 'General GLM Local FP8 MLX', description: 'OrcaSAQ', baseURL: 'https://example.invalid/orcasaq' },
      'orcarouter-local': { displayName: 'OrcaRouter' },
      'myorcasaqnotes': { displayName: 'General Notes' },
    } } }
    const result = prepared(source)
    expect(Object.keys(result.heldProviders)).toEqual(['named', 'mixed', 'only', 'inherited'])
    expect(providers(result.settings).mixed?.models).toEqual([{ id: 'safe' }])
    for (const id of ['glm-local', 'orcarouter-local', 'myorcasaqnotes']) {
      expect(providers(result.settings)[id]).toEqual(source['llm-pi-ai'].providers[id as keyof typeof source['llm-pi-ai']['providers']])
    }
    expect(result.heldProviders.mixed).toEqual(source['llm-pi-ai'].providers.mixed)
    expect(prepared(result.settings).settings).toEqual(result.settings)
  })

  it('expands aliases before editing catalogs so aliased preferences stay unchanged', () => {
    const source = parseSettingsDocument('llm-pi-ai:\n  providers:\n    mixed: &profile\n      models:\n        - id: safe\n        - id: glm-orcasaq\nsessions:\n  old: *profile\n')
    const before = structuredClone(source.sessions)
    const result = prepared(source)
    expect(result.settings.sessions).toEqual(before)
    expect(source.sessions).toEqual(before)
    expect(providers(result.settings).mixed?.models).toEqual([{ id: 'safe' }])
  })

  it('returns no settings while pending, even if the source already selected the target or OrcaSAQ', () => {
    const source = prepared().settings
    const before = structuredClone(source)
    expect(mergeLocalModelSettings(source, options({ readiness: { routeReady: false } }))).toEqual({ status: 'pending' })
    expect(source).toEqual(before)
  })

  it('prepares the new-chat default for a verified lazy driver with no resident model or listener', () => {
    const source = sourceSettings()
    const before = structuredClone(source)
    freeze(source)
    const result = prepared(source, { readiness: { ...evidence(), residentModel: false, listenerRunning: false } })
    expect(result.settings['agent-default-model']).toEqual({ provider: PROVIDER, model: MODEL, reasoningEffort: 'high', custom: 17 })
    expect(result.settings.sessions).toEqual(before.sessions)
    expect(providers(result.settings).openai).toEqual(before['llm-pi-ai'].providers.openai)
    expect(providers(result.settings).qwen).toEqual(before['llm-pi-ai'].providers.qwen)
    expect(source).toEqual(before)
    expect(prepared(result.settings).settings).toEqual(result.settings)
  })

  it('keeps current no-driver readiness pending without deriving readiness from residency', () => {
    const source = sourceSettings()
    const before = structuredClone(source)
    expect(mergeLocalModelSettings(source, options({ readiness: {
      routeReady: false, residentModel: false, listenerRunning: false,
    } }))).toEqual({ status: 'pending' })
    expect(source).toEqual(before)
  })

  it.each([undefined, {}, { verified: false, loadAtFirstRequest: true },
    { verified: true, loadAtFirstRequest: false }, { verified: true, loadAtFirstRequest: 'true' }])(
    'refuses readiness without verified lazy execution even if a model is resident %#', (lazyDriver) => {
      expect(() => prepared({}, { readiness: { ...evidence(), lazyDriver, residentModel: true, listenerRunning: true } }))
        .toThrow('externally verified first-request lazy driver')
    },
  )

  it.each([
    undefined, true, { routeReady: 'true' }, { routeReady: true },
    { ...evidence(), verified: false }, { ...evidence(), provider: 'other' },
    { ...evidence(), model: 'GLM-5.3-Flash-orcasaq' },
    { ...evidence(), baseURL: 'http://127.0.0.1:49178/v1' },
    { ...evidence(), verifiedAt: '2026-09-05T10:01:00Z' },
    { ...evidence(), expiresAt: '2026-09-05T10:00:00Z' },
    { ...evidence(), verifiedAt: 'invalid' },
    ...Object.keys(evidence().checks).map(key => ({ ...evidence(), checks: { ...evidence().checks, [key]: false } })),
  ])('refuses incomplete, expired, mismatched, or unverified readiness %#', (readiness) => {
    expect(() => prepared({}, { readiness })).toThrow()
  })

  it.each(['', 'https://example.com/v1', 'http://localhost.example.com/v1', 'http://127.0.0.1@evil.example/v1',
    'http://user:secret@localhost/v1', 'http://localhost/v1?key=secret', 'http://localhost/v1#secret',
    'file:///N:/model', 'http://2130706433/v1', 'http://127.0.0.1\\@evil.example/v1'])('refuses unsafe endpoint %s', (baseURL) => {
    expect(() => prepared({}, { baseURL })).toThrow()
  })

  it.each(['http://localhost:49201/v1/', 'https://127.2.3.4:49202/api', 'http://[::1]:49203/v1'])('uses the supplied loopback URL %s', (baseURL) => {
    const result = prepared({}, { baseURL, readiness: { ...evidence(), baseURL } })
    expect(providers(result.settings)[PROVIDER]?.baseURL).toBe(baseURL.replace(/\/$/, ''))
  })

  it.each(['a: [', `a: 1\na: ${FAKE_SECRET}`, `? [${FAKE_SECRET}]\n: value`, 'a: !unknown value', '- settings', 'a: &cycle [*cycle]', '__proto__: {polluted: true}'])('rejects unsupported YAML without source diagnostics %#', (text) => {
    expect(() => parseSettingsDocument(text)).toThrow('details withheld')
    try { parseSettingsDocument(text) } catch (error) { expect(String(error)).not.toContain(FAKE_SECRET) }
  })

  it('rejects incompatible provider structures instead of silently discarding them', () => {
    for (const value of [[], null, { p: { models: {} } }, { p: { models: [{ id: 'x' }, { id: 'x' }] } },
      { [PROVIDER]: { modelOverrides: { retained: {} } } }]) {
      expect(() => prepared({ 'llm-pi-ai': { providers: value } })).toThrow()
    }
  })
})

describe('N: path validation', () => {
  it.each(['F:/settings.yaml', 'C:/settings.yaml', 'N:settings.yaml', './settings.yaml', '\\\\host\\N$\\settings.yaml',
    '\\\\?\\N:\\settings.yaml', 'N:/a/../settings.yaml', 'N:/a/./settings.yaml', 'N:/a/file:stream',
    'N:/a./settings.yaml', 'N:/a /settings.yaml', 'N:/CON.yaml', 'N:/a//b', 'N:/'])('rejects %s', (path) => {
    expect(() => validateNPath(path)).toThrow()
  })
  it('accepts explicit N: paths with ordinary spaces and both separators', () => {
    expect(validateNPath('n:/private staging/settings.yaml')).toBe('n:\\private staging\\settings.yaml')
    expect(validateNPath('N:\\private\\settings.yaml')).toBe('N:\\private\\settings.yaml')
  })
})

describe('read-only source path validation', () => {
  it.each(['C:/Users/grinv/.dsh-giana-code-putri-candidate-20260902/settings.yaml',
    'c:\\private settings\\settings.yaml', 'N:/private/settings.yaml'])('accepts the source directly on its original drive: %s', (path) => {
    expect(validateSourceSettingsPath(path)).toBe(win32.normalize(path))
  })

  it.each(['F:/settings.yaml', 'D:/settings.yaml', 'C:settings.yaml', './settings.yaml',
    '\\\\host\\share\\settings.yaml', '\\\\?\\C:\\settings.yaml', 'C:/a/../settings.yaml',
    'C:/a/./settings.yaml', 'C:/a/file:stream', 'C:/a./settings.yaml', 'C:/CON.yaml', 'C:/a//b', 'C:/'])('rejects unsafe source %s', (path) => {
    expect(() => validateSourceSettingsPath(path)).toThrow()
  })
})

const fixtures: string[] = []
const TEST_PARENT = 'N:\\codex-test-temp'
const childEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    const actual = realpathSync(fixture)
    expect(lstatSync(fixture).isSymbolicLink()).toBe(false)
    expect(win32.dirname(actual).toLowerCase()).toBe(TEST_PARENT.toLowerCase())
    expect(win32.basename(actual)).toMatch(/^giana-cowork-settings-test-/)
    removeFixtureSafely(actual)
  }
})

function fixture() {
  const root = mkdtempSync(win32.join(TEST_PARENT, 'giana-cowork-settings-test-'))
  fixtures.push(root)
  mkdirSync(win32.join(root, 'source'))
  const source = win32.join(root, 'source', 'settings.yaml')
  const session = win32.join(root, 'source', 'session.jsonl')
  const readiness = win32.join(root, 'readiness.json')
  writeFileSync(source, JSON.stringify(sourceSettings()), { flag: 'wx' })
  writeFileSync(session, JSON.stringify({ model: 'old-model', text: FAKE_SECRET }), { flag: 'wx' })
  writeFileSync(readiness, JSON.stringify(evidence()), { flag: 'wx' })
  const args: StageOptions = { sourceSettingsPath: source, readinessPath: readiness,
    outputDir: win32.join(root, 'candidate'), baseURL: BASE_URL, now: NOW }
  return { root, source, session, readiness, args }
}

describe.skipIf(process.platform !== 'win32' || !existsSync(TEST_PARENT))('exclusive N: filesystem preparation', () => {
  it('writes candidates only, keeps source/session bytes, and logs no settings or credentials', () => {
    const f = fixture()
    const original = readFileSync(f.source)
    const session = readFileSync(f.session)
    expect(stageLocalModelSettings(f.args)).toEqual({ status: 'prepared' })
    expect(readFileSync(f.source)).toEqual(original)
    expect(readFileSync(f.session)).toEqual(session)
    expect(readdirSync(f.args.outputDir).sort()).toEqual(['held-providers.yaml', 'settings.candidate.yaml', 'status.json'])
    const candidate = parseSettingsDocument(readFileSync(win32.join(f.args.outputDir, 'settings.candidate.yaml'), 'utf8'))
    expect(providers(candidate).openai?.headers?.['x-test']).toBe(FAKE_SECRET)
    const status = readFileSync(win32.join(f.args.outputDir, 'status.json'), 'utf8')
    expect(status).not.toContain(FAKE_SECRET)
    expect(status).not.toContain(BASE_URL)
    expect(JSON.parse(status)).toMatchObject({ status: 'prepared', activated: false, candidateOnly: true })
    expect(() => stageLocalModelSettings(f.args)).toThrow('already exists')
    expect(readFileSync(f.source)).toEqual(original)
  })

  it('writes only a pending status without a selectable candidate', () => {
    const f = fixture()
    writeFileSync(f.readiness, JSON.stringify({ routeReady: false }))
    expect(stageLocalModelSettings(f.args)).toEqual({ status: 'pending' })
    expect(readdirSync(f.args.outputDir)).toEqual(['status.json'])
  })

  it('refuses invalid readiness before creating any output', () => {
    const f = fixture()
    writeFileSync(f.readiness, JSON.stringify({ routeReady: true, token: FAKE_SECRET }))
    expect(() => stageLocalModelSettings(f.args)).toThrow('externally verified')
    expect(existsSync(f.args.outputDir)).toBe(false)
  })

  it('redacts malformed-source and filesystem errors before creating output', () => {
    const f = fixture()
    writeFileSync(f.source, `secret: [${FAKE_SECRET}`)
    expect(() => stageLocalModelSettings(f.args)).toThrow('details withheld')
    expect(existsSync(f.args.outputDir)).toBe(false)
    expect(() => stageLocalModelSettings({ ...f.args, sourceSettingsPath: win32.join(f.root, 'source', `${FAKE_SECRET}.yaml`) }))
      .toThrow('Preparation failed; nothing was activated.')
    expect(existsSync(f.args.outputDir)).toBe(false)
  })

  it('refuses source containment, existing files, and repository output without overwriting', () => {
    const f = fixture()
    for (const outputDir of [f.source, win32.join(f.root, 'source', 'nested'), f.root,
      win32.join(repo, 'never-created-candidate')]) {
      expect(() => stageLocalModelSettings({ ...f.args, outputDir })).toThrow()
    }
    writeFileSync(f.args.outputDir, 'sentinel', { flag: 'wx' })
    expect(() => stageLocalModelSettings(f.args)).toThrow('already exists')
    expect(readFileSync(f.args.outputDir, 'utf8')).toBe('sentinel')
  })

  it('rejects nested repositories and worktree .git files outside this repository', () => {
    const f = fixture()
    const directory = win32.join(f.root, 'other-repo')
    mkdirSync(directory)
    writeFileSync(win32.join(directory, '.git'), 'gitdir: test-only')
    expect(() => stageLocalModelSettings({ ...f.args, outputDir: win32.join(directory, 'candidate') })).toThrow('repository')
  })

  it('rejects junction ancestors for reads and writes', () => {
    const f = fixture()
    const alias = win32.join(f.root, 'alias')
    symlinkSync(win32.join(f.root, 'source'), alias, 'junction')
    expect(() => stageLocalModelSettings({ ...f.args, outputDir: win32.join(alias, 'candidate') })).toThrow('junction')
    expect(() => stageLocalModelSettings({ ...f.args, sourceSettingsPath: win32.join(alias, 'settings.yaml') })).toThrow('junction')
    expect(existsSync(win32.join(f.root, 'source', 'candidate'))).toBe(false)
  })

  it('does not overwrite pre-existing candidate hardlinks to source or session data', () => {
    const f = fixture()
    mkdirSync(f.args.outputDir)
    const sourceBytes = readFileSync(f.source)
    const sessionBytes = readFileSync(f.session)
    linkSync(f.source, win32.join(f.args.outputDir, 'settings.candidate.yaml'))
    linkSync(f.session, win32.join(f.args.outputDir, 'status.json'))
    expect(() => stageLocalModelSettings(f.args)).toThrow('already exists')
    expect(readFileSync(f.source)).toEqual(sourceBytes)
    expect(readFileSync(f.session)).toEqual(sessionBytes)
  })

  it('rejects F: in every path position without accessing it', () => {
    const f = fixture()
    for (const key of ['sourceSettingsPath', 'outputDir', 'readinessPath']) {
      expect(() => stageLocalModelSettings({ ...f.args, [key]: 'F:/never-touch/settings.yaml' })).toThrow('must be absolute')
    }
    expect(existsSync(f.args.outputDir)).toBe(false)
  })

  it('continues to reject C: readiness and output even though C: source reads are allowed', () => {
    const f = fixture()
    const before = readFileSync(f.source)
    const session = readFileSync(f.session)
    for (const key of ['outputDir', 'readinessPath']) {
      expect(() => stageLocalModelSettings({ ...f.args, [key]: 'C:/never-touch/settings.yaml' })).toThrow('absolute on N:')
    }
    expect(readFileSync(f.source)).toEqual(before)
    expect(readFileSync(f.session)).toEqual(session)
    expect(existsSync(f.args.outputDir)).toBe(false)
  })

  it('runs the real CLI pending/error paths without echoing records or argument secrets', () => {
    const f = fixture()
    writeFileSync(f.readiness, JSON.stringify({ routeReady: false, private: FAKE_SECRET }))
    const args = ['--import', 'tsx/esm', script, '--source-settings', f.source,
      '--output-dir', f.args.outputDir, '--base-url', BASE_URL, '--readiness', f.readiness]
    const pending = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8', env: childEnvironment })
    expect(pending.status).toBe(2)
    expect(pending.stdout).toContain('PENDING')
    expect(pending.stdout + pending.stderr).not.toContain(FAKE_SECRET)
    const invalid = spawnSync(process.execPath, ['--import', 'tsx/esm', script, `--${FAKE_SECRET}`], { cwd: repo, encoding: 'utf8', env: childEnvironment })
    expect(invalid.status).toBe(1)
    expect(invalid.stdout + invalid.stderr).not.toContain(FAKE_SECRET)
  })

  it('allows only one competing CLI writer and publishes complete parseable files', async () => {
    const f = fixture()
    const sourceBytes = readFileSync(f.source)
    const sessionBytes = readFileSync(f.session)
    writeFileSync(f.readiness, JSON.stringify({
      ...evidence(),
      verifiedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }))
    const run = () => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx/esm', script,
        '--source-settings', f.source, '--output-dir', f.args.outputDir,
        '--base-url', BASE_URL, '--readiness', f.readiness], { cwd: repo, env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', (data: Buffer) => { output += data.toString() })
      child.stderr.on('data', (data: Buffer) => { output += data.toString() })
      child.on('error', reject)
      child.on('close', (code) => { resolve({ code, output }) })
    })
    const results = await Promise.all([run(), run()])
    expect(results.map(result => result.code).sort()).toEqual([0, 1])
    expect(results.map(result => result.output).join('')).not.toContain(FAKE_SECRET)
    expect(readdirSync(f.args.outputDir).sort()).toEqual(['held-providers.yaml', 'settings.candidate.yaml', 'status.json'])
    expect(parseSettingsDocument(readFileSync(win32.join(f.args.outputDir, 'settings.candidate.yaml'), 'utf8')))
      .toEqual(prepared(sourceSettings()).settings)
    expect(JSON.parse(readFileSync(win32.join(f.args.outputDir, 'status.json'), 'utf8'))).toMatchObject({ status: 'prepared', activated: false })
    expect(readFileSync(f.source)).toEqual(sourceBytes)
    expect(readFileSync(f.session)).toEqual(sessionBytes)
  }, 15_000)
})
