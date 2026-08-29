import { lstat, mkdir, readFile, readdir, rename, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, normalize, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import process from 'node:process'

const require = createRequire(new URL('../../packages/skill/skill-filesystem/package.json', import.meta.url))
const { parse: parseYaml } = require('yaml')

const DEFAULT_OUTPUT_ROOT = 'N:\\PrincessOS\\workbench\\dsh-capability-parity'
const DEFAULT_SOURCE_ROOTS = [
  'N:\\PrincessOS\\workbench\\dsh-capability-parity\\managed-skills',
  'N:\\CODEX_HOME\\skills',
  'C:\\Users\\grinv\\.claude\\skills',
  'C:\\Users\\grinv\\.claude\\plugins',
  'C:\\Users\\grinv\\.agents\\skills',
  'N:\\CODEX_HOME\\plugins\\cache',
  'C:\\Users\\grinv\\.dsh-0.1.1-rc.2-20260822\\profiles\\web\\node_modules\\@huiliyi37\\dsh-office\\skills',
  'N:\\PrincessOS\\workbench\\third-party\\j-space-cognition-suite-v3.6.1',
]

const PORTABLE_PLUGIN_SEGMENTS = [
  `${sep}build-web-apps${sep}`,
  `${sep}codex-security${sep}`,
  `${sep}data-analytics${sep}`,
  `${sep}game-studio${sep}`,
  `${sep}cloudflare${sep}`,
  `${sep}circleci${sep}`,
  `${sep}convex${sep}`,
  `${sep}product-design${sep}`,
  `${sep}superpowers${sep}`,
  `${sep}vercel${sep}`,
  `${sep}hugging-face${sep}`,
  `${sep}nvidia${sep}`,
  `${sep}openai-developers${sep}`,
  `${sep}plugin-eval${sep}`,
  `${sep}openai-primary-runtime${sep}`,
]

const OUTPUT_FLAG = '--output'
const outputArg = process.argv.indexOf(OUTPUT_FLAG)
const outputRoot = resolve(outputArg >= 0 ? process.argv[outputArg + 1] : DEFAULT_OUTPUT_ROOT)
const expectedRoot = resolve(DEFAULT_OUTPUT_ROOT)
if (outputRoot !== expectedRoot) {
  throw new Error(`Refusing unexpected parity output root: ${outputRoot}`)
}

const sourceRoots = process.env.DSH_PARITY_SOURCE_ROOTS
  ?.split(';')
  .map(value => value.trim())
  .filter(Boolean)
  ?? DEFAULT_SOURCE_ROOTS

const activeRoot = join(outputRoot, 'active-skills')
const stagingRoot = join(outputRoot, `.active-skills-staging-${process.pid}`)
const previousRoot = join(outputRoot, '.active-skills-previous')

await mkdir(outputRoot, { recursive: true })
await removeProjectionRoot(stagingRoot)
await removeProjectionRoot(previousRoot)
await mkdir(stagingRoot, { recursive: true })

const candidates = []
for (const sourceRoot of sourceRoots) {
  await collectSkills(resolve(sourceRoot), sourceRoot, candidates)
}

const selectedByName = new Map()
for (const candidate of candidates.sort(compareCandidates)) {
  if (!selectedByName.has(candidate.name)) selectedByName.set(candidate.name, candidate)
}

const selected = [...selectedByName.values()].sort((left, right) => left.name.localeCompare(right.name))
// Every syntactically valid skill is searchable/selectable. Runtime readiness
// remains a separate fact: a skill may still need its external connector when
// invoked, but it is no longer hidden from the operator.
const active = selected
const runtimeReady = selected.filter(candidate => candidate.runtimeReady)
const runtimePending = selected.filter(candidate => !candidate.runtimeReady)
const held = []

for (const candidate of active) {
  await symlink(candidate.directory, join(stagingRoot, candidate.name), 'junction')
}

try {
  await lstat(activeRoot)
  await rename(activeRoot, previousRoot)
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
await rename(stagingRoot, activeRoot)
await removeProjectionRoot(previousRoot)

const generatedAt = new Date().toISOString()
const manifest = {
  schemaVersion: 1,
  generatedAt,
  sourceRoots,
  counts: {
    discoveredRows: candidates.length,
    uniqueValidSkills: selected.length,
    activeProjectedSkills: active.length,
    runtimeReadySkills: runtimeReady.length,
    runtimePendingSkills: runtimePending.length,
    heldSkills: held.length,
  },
  activeProjection: activeRoot,
  skills: selected.map(candidate => ({
    name: candidate.name,
    description: candidate.description,
    category: classifyCategory(candidate),
    sourceFamily: candidate.sourceFamily,
    sourcePath: candidate.skillFile,
    activation: candidate.activation,
    reason: candidate.reason,
    runtimeReady: candidate.runtimeReady,
    runtimeReason: candidate.runtimeReason,
  })),
}

const categoryRows = new Map()
for (const skill of manifest.skills) {
  const row = categoryRows.get(skill.category) ?? { total: 0, ready: 0, needsRuntime: 0, skills: [] }
  row.total += 1
  if (skill.runtimeReady) row.ready += 1
  else row.needsRuntime += 1
  row.skills.push({
    name: skill.name,
    description: skill.description,
    status: skill.runtimeReady ? 'ready' : 'needs-runtime-or-connector',
    sourceFamily: skill.sourceFamily,
  })
  categoryRows.set(skill.category, row)
}
manifest.categories = Object.fromEntries([...categoryRows.entries()].sort(([left], [right]) => left.localeCompare(right)))

await writeJson(join(outputRoot, 'skill-parity-manifest.json'), manifest)
await writeJson(join(outputRoot, 'capability-catalog.json'), {
  schemaVersion: 1,
  generatedAt,
  totalSkills: manifest.counts.uniqueValidSkills,
  categories: manifest.categories,
})
await writeJson(join(outputRoot, 'active-skills.json'), active.map(projectedRecord))
await writeJson(join(outputRoot, 'runtime-pending-skills.json'), runtimePending.map(projectedRecord))
await writeJson(join(outputRoot, 'held-skills.json'), held.map(projectedRecord))
await writeFile(join(outputRoot, 'README.md'), renderReadme(manifest), 'utf8')
process.stdout.write(`${JSON.stringify(manifest.counts)}\n`)

async function collectSkills(root, declaredRoot, output) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await collectSkills(path, declaredRoot, output)
      continue
    }
    if (!entry.isFile() || entry.name !== 'SKILL.md') continue
    const parsed = await parseSkill(path, declaredRoot)
    if (parsed !== undefined) output.push(parsed)
  }
}

async function parseSkill(skillFile, declaredRoot) {
  const source = await readFile(skillFile, 'utf8')
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(source)
  if (match === null) return undefined
  let frontmatter
  try {
    frontmatter = parseYaml(match[1])
  } catch {
    return undefined
  }
  const name = typeof frontmatter?.name === 'string' ? frontmatter.name.trim() : ''
  const description = typeof frontmatter?.description === 'string' ? frontmatter.description.replaceAll(/\s+/g, ' ').trim() : ''
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || description === '') return undefined
  const sourceFamily = classifySource(skillFile, declaredRoot)
  const { activation, reason, runtimeReady, runtimeReason } = classifyActivation(skillFile, sourceFamily)
  return {
    name,
    description,
    skillFile,
    directory: dirname(skillFile),
    sourceFamily,
    activation,
    reason,
    runtimeReady,
    runtimeReason,
    priority: sourcePriority(sourceFamily, skillFile),
  }
}

function classifySource(skillFile) {
  const lowered = normalize(skillFile).toLowerCase()
  if (lowered.includes(`${sep}dsh-capability-parity${sep}managed-skills${sep}`)) return 'princess-managed'
  if (lowered.includes(`${sep}@huiliyi37${sep}dsh-office${sep}skills${sep}`)) return 'dsh-profile-plugin'
  if (lowered.includes(`${sep}j-space-cognition-suite-v3.6.1${sep}`)) return 'j-space-local'
  if (lowered.startsWith(normalize('N:\\CODEX_HOME\\skills').toLowerCase())) return 'giana-codex-local'
  if (lowered.startsWith(normalize('C:\\Users\\grinv\\.claude\\skills').toLowerCase())) return 'claude-local'
  if (lowered.startsWith(normalize('C:\\Users\\grinv\\.claude\\plugins').toLowerCase())) return 'claude-plugin-local'
  if (lowered.startsWith(normalize('C:\\Users\\grinv\\.agents\\skills').toLowerCase())) return 'agents-local'
  if (lowered.includes(`${sep}openai-primary-runtime${sep}`)) return 'openai-primary-runtime'
  if (lowered.includes(`${sep}openai-curated-remote${sep}`)) return 'openai-curated-remote'
  if (lowered.includes(`${sep}openai-bundled${sep}`)) return 'openai-bundled'
  if (lowered.includes(`${sep}openai-curated${sep}`)) return 'openai-curated-cache'
  return 'plugin-cache-other'
}

function classifyActivation(skillFile, sourceFamily) {
  if (['princess-managed', 'dsh-profile-plugin', 'j-space-local', 'giana-codex-local', 'claude-local', 'claude-plugin-local', 'agents-local'].includes(sourceFamily)) {
    return {
      activation: 'active',
      reason: 'valid-skill-indexed',
      runtimeReady: true,
      runtimeReason: 'local-governed-runtime-ready',
    }
  }
  const normalizedPath = normalize(skillFile).toLowerCase()
  if (PORTABLE_PLUGIN_SEGMENTS.some(segment => normalizedPath.includes(segment))) {
    return {
      activation: 'active',
      reason: 'valid-skill-indexed',
      runtimeReady: true,
      runtimeReason: 'portable-reviewed-runtime-ready',
    }
  }
  return {
    activation: 'active',
    reason: 'valid-skill-indexed',
    runtimeReady: false,
    runtimeReason: 'selectable-but-external-connector-or-runtime-required',
  }
}

function classifyCategory(candidate) {
  const value = `${candidate.name} ${candidate.description}`.toLowerCase()
  const categories = [
    ['engineering', /cad|dwg|dxf|ifc|step|pid|p&id|cfd|openfoam|electrical|vfd|instrument|process|simulation|structural|construction|commissioning|industrial|geospatial|hmi|scada|plant/],
    ['data-analytics', /data|analytics|visualiz|dashboard|kpi|metric|forecast|monte-carlo|science|jupyter|notebook|report|chart/],
    ['finance', /finance|financial|accounting|payroll|valuation|pricing|invoice|billing|budget|commercial|contract|claims/],
    ['business-operations', /business|operations|crm|sales|marketing|lead|account|erp|supply|procurement|project|executive|secretary|customer/],
    ['productivity', /document|office|spreadsheet|xlsx|docx|ppt|pdf|calendar|email|gmail|drive|meeting|transcript|notion|slack|teams|outlook/],
    ['build-design', /frontend|web-app|react|three|webgl|figma|design|product|ios|android|expo|game|ui|ux|swift|code|developer|api|database|postgres|supabase|deploy|vercel|cloudflare|netlify|ci|circleci/],
    ['creative-media', /image|video|audio|voice|tts|stt|avatar|canva|heygen|remotion|creative|animation|blender|sprite|media/],
    ['security-governance', /security|cyber|threat|vulnerab|audit|policy|credential|identity|privacy|approval|governance|forensic/],
    ['research-knowledge', /research|search|knowledge|context|memory|deepnote|hugging|model|llm|ai-/],
    ['automation-agents', /agent|automation|workflow|orchestrat|computer-use|mcp|tool|skill|goal|coordination|convergence/],
  ]
  return categories.find(([, pattern]) => pattern.test(value))?.[0] ?? 'general'
}

function sourcePriority(sourceFamily, skillFile) {
  const family = {
    'princess-managed': 0,
    'dsh-profile-plugin': 5,
    'j-space-local': 7,
    'giana-codex-local': 10,
    'claude-local': 20,
    'claude-plugin-local': 25,
    'agents-local': 30,
    'openai-primary-runtime': 40,
    'openai-curated-remote': 50,
    'openai-bundled': 60,
    'openai-curated-cache': 70,
    'plugin-cache-other': 80,
  }[sourceFamily] ?? 90
  const remotePenalty = normalize(skillFile).toLowerCase().includes(`${sep}openai-curated-remote${sep}`) ? 0 : 1
  return family * 10 + remotePenalty
}

function compareCandidates(left, right) {
  return left.priority - right.priority
    || left.name.localeCompare(right.name)
    || left.skillFile.localeCompare(right.skillFile)
}

function projectedRecord(candidate) {
  return {
    name: candidate.name,
    sourceFamily: candidate.sourceFamily,
    sourcePath: candidate.skillFile,
    reason: candidate.reason,
    runtimeReady: candidate.runtimeReady,
    runtimeReason: candidate.runtimeReason,
  }
}

async function removeProjectionRoot(root) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    const stat = await lstat(path)
    if (!stat.isSymbolicLink()) {
      throw new Error(`Refusing to remove non-junction projection member: ${path}`)
    }
    await unlink(path)
  }
  await rmdir(root)
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function renderReadme(manifest) {
  return [
    '# DSH Capability Parity Projection',
    '',
    `Generated: ${manifest.generatedAt}`,
    '',
    `- Discovered rows: ${manifest.counts.discoveredRows}`,
    `- Unique valid skills: ${manifest.counts.uniqueValidSkills}`,
    `- Active projected skills: ${manifest.counts.activeProjectedSkills}`,
    `- Runtime-ready skills: ${manifest.counts.runtimeReadySkills}`,
    `- Runtime-pending skills: ${manifest.counts.runtimePendingSkills}`,
    `- Held skills: ${manifest.counts.heldSkills}`,
    '',
    'All valid candidates remain recorded in `skill-parity-manifest.json`.',
    'All valid skills are projected into DSH and available through `skill_search`.',
    'Runtime-pending skills stay clearly labelled and fail at their missing connector instead of being hidden.',
    '',
  ].join('\n')
}
