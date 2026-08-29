/** Human-facing capability categories in their display order. */
export const CAPABILITY_CATEGORIES = [
  'connectors-productivity',
  'developer-design',
  'data-analytics',
  'engineering',
  'finance-business',
  'creative-media',
  'browser-automation',
  'windows-desktop-automation',
  'documents-office',
  'voice-dictation',
  'models-compute',
  'security-governance',
  'system-internals',
] as const

/** Stable identifier for one human-facing capability category. */
export type CapabilityCategory = typeof CAPABILITY_CATEGORIES[number]

/** Literal projection of the live Loader inventory schema. */
export type LoaderStatus =
  | 'disabled'
  | 'enabled-unmounted'
  | 'pending'
  | 'loading'
  | 'mounted'
  | 'mount-failed'
  | 'unloading'

type FiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null

const SYSTEM_TERMS = [
  'hmr',
  'session',
  'cordis',
  'loader',
  'runtime',
  'locale',
  'ui-',
  'app-boot',
  'webserver',
  'frontend-static',
  'plugin-inventory',
  'api-remotes',
  'gateway',
  'protocol',
  'registry',
  'telemetry',
  'projection',
  'storage',
  'persistence',
  'invariant',
  'directory-picker',
] as const

const CATEGORY_TERMS: ReadonlyArray<readonly [CapabilityCategory, readonly string[]]> = [
  ['connectors-productivity', [
    'connector', 'productivity', 'slack', 'notion', 'calendar', 'google-drive', 'gdrive',
    'sharepoint', 'outlook', 'teams', 'atlassian', 'jira', 'confluence', 'dropbox', 'gmail',
    'email', 'mcp', 'schedule', 'todo', 'goal', 'plan', 'workflow', 'jobs',
  ]],
  ['browser-automation', [
    'browser', 'playwright', 'puppeteer', 'selenium', 'chromium', 'web-search', 'web-fetch',
    'tool-web',
  ]],
  ['windows-desktop-automation', [
    'windows-desktop', 'desktop-automation', 'computer-use', 'ui-automation', 'win32',
    'uiautomation',
  ]],
  ['documents-office', [
    'document', 'office', 'spreadsheet', 'excel', 'powerpoint', 'word', 'pdf', 'docx', 'pptx',
    'xlsx', 'attachment', 'file-reference',
  ]],
  ['voice-dictation', [
    'voice', 'dictat', 'speech', 'transcri', 'microphone', 'telephone', 'audio', 'tts', 'stt',
  ]],
  ['creative-media', [
    'creative', 'image', 'video', 'media', 'avatar', 'blender', 'three', 'remotion', 'heygen',
    'ideogram', 'krea',
  ]],
  ['engineering', [
    'engineering', 'cad', 'cfd', 'openfoam', 'civil', 'structural', 'electrical', 'instrument',
    'process-model', 'simulation', 'geospatial', 'construction', 'commissioning', 'industrial',
  ]],
  ['finance-business', [
    'finance', 'financial', 'accounting', 'crm', 'sales', 'business', 'commercial', 'contract',
    'erp', 'payroll', 'marketing', 'valuation', 'forecast',
  ]],
  ['data-analytics', [
    'data', 'analytics', 'database', 'sql', 'query', 'metric', 'chart', 'report', 'tableau',
    'powerbi', 'snowflake', 'bigquery', 'databricks', 'historian',
  ]],
  ['security-governance', [
    'security', 'governance', 'guard', 'permission', 'credential', 'authorization', 'access-policy',
    'sandbox', 'acl', 'privacy', 'identity', 'audit', 'policy', 'hse',
  ]],
  ['models-compute', [
    'llm', 'model', 'compute', 'inference', 'provider', 'openai', 'anthropic', 'hugging-face',
    'nvidia', 'deepseek', 'token-meter', 'e2b',
  ]],
  ['developer-design', [
    'developer', 'design', 'figma', 'canva', 'github', 'gitlab', 'repository', 'code', 'lsp',
    'shell', 'terminal', 'bash', 'pwsh', 'powershell', 'subprocess', 'filesystem', 'tool-fs',
    'workspace', 'skill', 'subagent', 'command', 'git', 'acp', 'cloudflare', 'convex', 'expo',
    'netlify', 'circleci',
  ]],
]

const DISPLAY_WORDS: Readonly<Record<string, string>> = {
  acp: 'ACP',
  ai: 'AI',
  api: 'API',
  cad: 'CAD',
  canva: 'Canva',
  cfd: 'CFD',
  cli: 'CLI',
  crm: 'CRM',
  csv: 'CSV',
  deepseek: 'DeepSeek',
  erp: 'ERP',
  figma: 'Figma',
  fs: 'Filesystem',
  gianaos: 'GianaOS',
  github: 'GitHub',
  gitlab: 'GitLab',
  hmr: 'HMR',
  hmi: 'HMI',
  hse: 'HSE',
  html: 'HTML',
  http: 'HTTP',
  json: 'JSON',
  llm: 'LLM',
  lsp: 'LSP',
  mcp: 'MCP',
  openfoam: 'OpenFOAM',
  pdf: 'PDF',
  powerpoint: 'PowerPoint',
  sdk: 'SDK',
  sharepoint: 'SharePoint',
  sql: 'SQL',
  ssh: 'SSH',
  stt: 'STT',
  tts: 'TTS',
  ui: 'UI',
  url: 'URL',
  webgl: 'WebGL',
  xlsx: 'XLSX',
}

function normalizedIdentifier(value: string): string {
  const unscoped = value.startsWith('@') ? value.slice(value.indexOf('/') + 1) : value
  return unscoped
    .toLocaleLowerCase()
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^dsh-(?:host-|client-)?/, '')
}

function includesTerm(value: string, terms: readonly string[]): boolean {
  return terms.some(term => value.includes(term))
}

/** Infer a stable category from the only two descriptive inventory fields. */
export function inferCapabilityCategory(moduleName: string, entryId: string): CapabilityCategory {
  const moduleId = normalizedIdentifier(moduleName)
  const combined = `${moduleId} ${normalizedIdentifier(entryId)}`
  if (includesTerm(moduleId, SYSTEM_TERMS)) return 'system-internals'

  for (const [category, terms] of CATEGORY_TERMS) {
    if (includesTerm(combined, terms)) return category
  }
  return 'system-internals'
}

/**
 * Project only facts carried by the current Loader snapshot. In particular,
 * mounted does not imply connection, callability, or end-to-end behavior.
 */
export function loaderStatus(
  entry: Readonly<{ enabled: boolean; fiberPhase: FiberPhase }>,
): LoaderStatus {
  if (!entry.enabled) return 'disabled'
  switch (entry.fiberPhase) {
    case null: return 'enabled-unmounted'
    case 'pending': return 'pending'
    case 'loading': return 'loading'
    case 'active': return 'mounted'
    case 'failed': return 'mount-failed'
    case 'unloading': return 'unloading'
  }
}

/** Turn a module specifier into a compact title while keeping the raw value in details. */
export function capabilityTitle(moduleName: string): string {
  const words = normalizedIdentifier(moduleName)
    .split(/[-_:/]+/)
    .filter((word, index) => index > 0 || (word !== 'tool' && word !== 'command' && word !== 'plugin'))
  return words.map(word => DISPLAY_WORDS[word] ?? `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`).join(' ')
}
