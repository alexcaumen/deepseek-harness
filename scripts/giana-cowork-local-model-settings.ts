/** Candidate-only N: output from read-only C:/N: settings; never activates a route or edits sessions. */
import { randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// Resolve the existing settings-file dependency without changing root dependencies.
const require = createRequire(new URL('../packages/settings/settings-file/package.json', import.meta.url))
const yaml = require('yaml') as {
  parseDocument(text: string, options: { prettyErrors: boolean; logLevel: 'silent'; stringKeys: boolean }): {
    errors: readonly unknown[]
    warnings: readonly unknown[]
    toJS(options: { maxAliasCount: number }): unknown
  }
  stringify(value: unknown): string
}

const PROVIDER = 'glm-local-r5300'
const MODEL = 'GLM-5.3-Flash-official-fp8-canary'
const DISPLAY = 'GLM 5.3 Flash Official FP8 (Local)'
const QWEN_PROVIDER = 'qwen-local-r5300'
const QWEN_MODEL = 'Qwen/Qwen3.8-27B'
const HELD_PROVIDER_IDS = new Set([
  'glm-uncensored-local-r5300',
  'deepseek-vision-local-r5300',
  'deepseek-vision-uncensored-local-r5300',
])
const ORCASAQ = /(?:^|[^a-z0-9])orca[-_.\s]*saq(?:$|[^a-z0-9])/i
type Mapping = Record<string, unknown>

class PreparationError extends Error {}

function fail(message: string): never {
  throw new PreparationError(message)
}

function mapping(value: unknown): Mapping {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('Expected a settings mapping; nothing was activated.')
  }
  return value as Mapping
}

function section(value: unknown): Mapping {
  return value === undefined ? {} : mapping(value)
}

function checkData(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || ancestors.has(value)) fail('Settings must contain acyclic JSON-compatible data.')
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype
    && Object.getPrototypeOf(value) !== null) fail('Unsupported settings value.')
  ancestors.add(value)
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__') fail('Unsupported settings key.')
    checkData(child, ancestors)
  }
  ancestors.delete(value)
}

/**
 * Parse YAML (including JSON) without including source excerpts in errors.
 * @param text - settings or externally supplied readiness document.
 * @returns detached, acyclic data with a mapping root.
 */
export function parseSettingsDocument(text: string): Mapping {
  try {
    const document = yaml.parseDocument(text, { prettyErrors: false, logLevel: 'silent', stringKeys: true })
    if (document.errors.length || document.warnings.length) fail('Invalid or unsupported YAML document.')
    const data = document.toJS({ maxAliasCount: 100 }) ?? {}
    checkData(data)
    return mapping(data)
  } catch {
    // Parser diagnostics and custom-tag warnings can contain credentials.
    fail('Invalid or unsupported settings/readiness document; details withheld.')
  }
}

function loopbackURL(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    fail('An explicit HTTP(S) loopback base URL is required.')
  }
  if (!/^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/[^\s?#]*)?$/i.test(value)
    || !['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.search || url.hash
    || !(url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\./.test(url.hostname))) {
    fail('Base URL must be loopback HTTP(S), without credentials, query, or fragment.')
  }
  return url.href.replace(/\/$/, '')
}

/** Inputs supplied by the deployment owner, not discovered or admitted by this script. */
export interface MergeOptions {
  baseURL: string
  /** Untrusted record: routeReady false, or the verified record documented beside this script. */
  readiness: unknown
  /** Evaluation time in milliseconds; explicit for deterministic tests. */
  now: number
}

/** An inactive profile archive accompanies ready candidates; pending results contain no settings. */
export type PreparedSettings = {
  status: 'pending'
} | {
  status: 'prepared'
  settings: Mapping
  heldProviders: Mapping
}

function ready(options: MergeOptions, baseURL: string): boolean {
  const record = mapping(options.readiness)
  if (record.routeReady === false) return false
  const checks = section(record.checks)
  const lazyDriver = section(record.lazyDriver)
  const verifiedAt = typeof record.verifiedAt === 'string' ? Date.parse(record.verifiedAt) : NaN
  const expiresAt = typeof record.expiresAt === 'string' ? Date.parse(record.expiresAt) : NaN
  if (record.routeReady !== true || record.verified !== true
    || lazyDriver.verified !== true || lazyDriver.loadAtFirstRequest !== true
    || record.provider !== PROVIDER || record.model !== MODEL
    || typeof record.baseURL !== 'string' || loopbackURL(record.baseURL) !== baseURL
    || !Number.isFinite(options.now) || !Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt)
    || verifiedAt > options.now || expiresAt <= options.now || expiresAt <= verifiedAt
    || !['text', 'image', 'totalContext4096', 'maxTokens1024', 'reasoningHigh']
      .every(key => checks[key] === true)) {
    fail('Readiness must include an externally verified first-request lazy driver and be current and bound to this exact endpoint, model, and policy.')
  }
  return true
}

function models(value: unknown): Mapping[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) fail('Provider models must be an explicit list.')
  const result = value.map(mapping)
  const ids = result.map(model => model.id)
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    fail('Provider model IDs must be nonempty and unique.')
  }
  return result
}

function isOrcaSAQ(...identities: unknown[]): boolean {
  return identities.some(value => typeof value === 'string' && ORCASAQ.test(value))
}

/**
 * Merge only the provider catalog and future-chat default, preserving all other data.
 * @param source - raw settings; never mutated, including nested session selections.
 * @param options - endpoint, external readiness record, and evaluation time.
 * @returns no settings while pending; otherwise idempotent settings plus original excluded profiles.
 */
export function mergeLocalModelSettings(source: Mapping, options: MergeOptions): PreparedSettings {
  checkData(source)
  mapping(source)
  const baseURL = loopbackURL(options.baseURL)
  if (!ready(options, baseURL)) return { status: 'pending' }
  // Expand YAML aliases so catalog edits cannot also change aliased preferences or sessions.
  const settings = JSON.parse(JSON.stringify(source)) as Mapping
  const llm = section(settings['llm-pi-ai'])
  const configured = section(llm.providers)
  const providers: Mapping = {}
  const heldProviders: Mapping = {}

  for (const [id, raw] of Object.entries(configured)) {
    const profile = mapping(raw)
    const listed = models(profile.models)
    const overrides = section(profile.modelOverrides)
    const retained = listed?.filter(model => !isOrcaSAQ(model.id, model.name))
    const excludedOverride = Object.entries(overrides)
      .some(([modelId, model]) => isOrcaSAQ(modelId, mapping(model).name))
    if (HELD_PROVIDER_IDS.has(id) || isOrcaSAQ(id, profile.displayName) || excludedOverride
      || (listed && retained && listed.length > 0 && retained.length === 0)) {
      // Empty catalogs can fall back to installed models; hold the entire route instead.
      heldProviders[id] = structuredClone(profile)
    } else {
      if (listed && retained && retained.length !== listed.length) {
        heldProviders[id] = structuredClone(profile)
        profile.models = retained
      }
      providers[id] = profile
    }
  }

  const previous = section(providers[PROVIDER])
  if (previous.modelOverrides !== undefined && Object.keys(mapping(previous.modelOverrides)).length) {
    fail('The target provider has modelOverrides; resolve that conflict before preparing a candidate.')
  }
  const listed = models(previous.models) ?? []
  const oldModel = listed.find(model => model.id === MODEL) ?? {}
  const model = {
    ...oldModel,
    id: MODEL,
    name: DISPLAY,
    contextWindow: 4096,
    maxTokens: 1024,
    reasoningEfforts: { high: 'high' },
    input: ['text', 'image'],
  }
  providers[PROVIDER] = {
    ...previous,
    displayName: DISPLAY,
    api: 'openai-completions',
    baseURL,
    reasoning: 'high',
    availabilityProbe: { model: MODEL, timeoutMs: 10_000, phase: 'dispatch' },
    models: [model],
  }
  if (providers[QWEN_PROVIDER] !== undefined) {
    const qwen = mapping(providers[QWEN_PROVIDER])
    providers[QWEN_PROVIDER] = {
      ...qwen,
      availabilityProbe: { model: QWEN_MODEL, timeoutMs: 10_000, phase: 'dispatch' },
    }
  }
  settings['llm-pi-ai'] = { ...llm, providers }
  settings['agent-default-model'] = {
    ...section(settings['agent-default-model']),
    provider: PROVIDER,
    model: MODEL,
    reasoningEffort: 'high',
  }
  return { status: 'prepared', settings, heldProviders }
}

function normalWindowsPath(input: string): string {
  const parts = input.slice(3).split(/[\\/]/)
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..'
    || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    fail('Paths must not contain traversal, device names, streams, or ambiguous components.')
  }
  return win32.normalize(input)
}

/**
 * Validate readiness/output paths without allowing another drive or ambiguous Windows names.
 * @param input - an explicit absolute path on N:.
 * @returns normalized Windows path without changing its drive.
 */
export function validateNPath(input: string): string {
  if (!/^N:[\\/]/i.test(input)) fail('Readiness and output paths must be absolute on N:.')
  return normalWindowsPath(input)
}

/**
 * Validate the read-only source without requiring a preliminary settings/secret copy.
 * @param input - an explicit normal absolute source path on C: or N:.
 * @returns normalized source path; this never grants permission to write beside it.
 */
export function validateSourceSettingsPath(input: string): string {
  if (!/^[CN]:[\\/]/i.test(input)) fail('Source settings must be absolute on C: or N: and are read-only.')
  return normalWindowsPath(input)
}

function contains(parent: string, child: string): boolean {
  const relative = win32.relative(parent.toLowerCase(), child.toLowerCase())
  return relative === '' || (!relative.startsWith('..\\') && relative !== '..' && !win32.isAbsolute(relative))
}

function checkedExisting(path: string, directory: boolean): void {
  let current = win32.parse(path).root
  const parts = path.slice(current.length).split('\\')
  for (const part of ['', ...parts]) {
    if (part) current = win32.join(current, part)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()
      || realpathSync(current).toLowerCase() !== current.toLowerCase()) {
      fail('Symlinks, junctions, and redirected paths are not allowed.')
    }
    if (current !== path && !stat.isDirectory()) fail('A path ancestor is not a directory.')
  }
  const stat = lstatSync(path)
  if (directory ? !stat.isDirectory() : !stat.isFile()) fail('Input/output path has the wrong file type.')
}

function outsideRepositories(directory: string): void {
  const ownRepo = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
  if (contains(ownRepo, directory)) fail('Candidate output cannot be inside the repository.')
  let current = directory
  while (true) {
    if (existsSync(win32.join(current, '.git'))) fail('Candidate output cannot be inside a repository.')
    const parent = win32.dirname(current)
    if (parent === current) return
    current = parent
  }
}

function writeExclusive(directory: string, name: string, text: string): void {
  checkedExisting(directory, true)
  const temporary = win32.join(directory, `.candidate-${randomUUID()}.tmp`)
  const target = win32.join(directory, name)
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    try {
      writeFileSync(fd, text, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    checkedExisting(directory, true)
    // Hard-link publication is atomic and fails if target exists; rename may overwrite.
    linkSync(temporary, target)
  } finally {
    checkedExisting(directory, true)
    unlinkSync(temporary)
  }
}

/** File preparation parameters; the output directory must not already exist. */
export interface StageOptions {
  /** Read-only source on C: or N:; no implicit source location or preliminary copy. */
  sourceSettingsPath: string
  /** Fresh candidate output on N: only. */
  outputDir: string
  /** Externally verified lazy-route readiness input on N: only. */
  readinessPath: string
  baseURL: string
  now?: number
}

/**
 * Prepare candidate files in a fresh directory; source/session files are only ever read or ignored.
 * @param options - read-only C:/N: source, N: readiness/output, and an explicit loopback endpoint.
 * @returns a secret-free status, with no route admission or live activation implied.
 */
export function stageLocalModelSettings(options: StageOptions): { status: 'pending' | 'prepared' } {
  try {
    const source = validateSourceSettingsPath(options.sourceSettingsPath)
    const output = validateNPath(options.outputDir)
    const readiness = validateNPath(options.readinessPath)
    if (process.platform !== 'win32') fail('File preparation requires Windows with an N: drive.')
    if (!/\.(yaml|yml|json)$/i.test(source) || !/\.(yaml|yml|json)$/i.test(readiness)) {
      fail('Inputs must be YAML or JSON documents, not session logs.')
    }
    if (contains(win32.dirname(source), output) || contains(output, source)
      || contains(output, readiness)) fail('Output must be separate from source settings and readiness inputs.')
    checkedExisting(source, false)
    checkedExisting(readiness, false)
    checkedExisting(win32.dirname(output), true)
    outsideRepositories(win32.dirname(output))
    if (existsSync(output)) fail('Output directory already exists; choose a fresh directory.')
    const prepared = mergeLocalModelSettings(parseSettingsDocument(readFileSync(source, 'utf8')), {
      baseURL: options.baseURL,
      readiness: parseSettingsDocument(readFileSync(readiness, 'utf8')),
      now: options.now ?? Date.now(),
    })
    checkedExisting(win32.dirname(output), true)
    mkdirSync(output, { mode: 0o700 })
    if (prepared.status === 'prepared') {
      writeExclusive(output, 'held-providers.yaml', yaml.stringify(prepared.heldProviders))
      writeExclusive(output, 'settings.candidate.yaml', yaml.stringify(prepared.settings))
    }
    writeExclusive(output, 'status.json', `${JSON.stringify({
      status: prepared.status,
      candidateOnly: true,
      activated: false,
      message: prepared.status === 'pending'
        ? 'Pending externally verified routeReady; no settings candidate or selectable route was created.'
        : 'Candidate prepared from supplied verification; not a live probe, route admission, or activation.',
    }, null, 2)}\n`)
    return { status: prepared.status }
  } catch (error) {
    if (error instanceof PreparationError) throw error
    // OS errors may contain sensitive path components; never expose their messages.
    fail('Preparation failed; nothing was activated. Use a fresh private N: directory; incomplete output is not reusable.')
  }
}

function main(): void {
  try {
    const { values } = parseArgs({ options: {
      'source-settings': { type: 'string' },
      'output-dir': { type: 'string' },
      'base-url': { type: 'string' },
      'readiness': { type: 'string' },
      'help': { type: 'boolean' },
    }, allowPositionals: false })
    if (values.help) {
      console.log('Usage: node --import tsx/esm scripts/giana-cowork-local-model-settings.ts --source-settings <absolute-C:-or-N:-settings-path> --output-dir N:/.../fresh-directory --base-url <verified-loopback-URL> --readiness N:/.../readiness.json')
      return
    }
    if (!values['source-settings'] || !values['output-dir'] || !values['base-url'] || !values.readiness) {
      fail('Required: --source-settings, --output-dir, --base-url, --readiness. See --help.')
    }
    const result = stageLocalModelSettings({
      sourceSettingsPath: values['source-settings'], outputDir: values['output-dir'],
      baseURL: values['base-url'], readinessPath: values.readiness,
    })
    console.log(result.status === 'pending'
      ? 'PENDING: routeReady is false; no settings candidate, selectable route, or activation.'
      : 'PREPARED: candidate settings only; no live probe, route admission, or activation.')
    process.exitCode = result.status === 'pending' ? 2 : 0
  } catch (error) {
    console.error(error instanceof PreparationError ? error.message : 'Invalid preparation arguments; details withheld. See --help.')
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
