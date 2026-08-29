import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptRoot, '..', '..')

const defaults = {
  skills: String.raw`N:\PrincessOS\workbench\dsh-capability-parity\planning-20260823\GIANA_WINDOWS_SKILL_FEATURE_INVENTORY_20260823.json`,
  connectors: String.raw`N:\PrincessOS\workbench\dsh-capability-parity\planning-20260823\GIANA_WINDOWS_OPENCONNECTOR_PROVIDER_INVENTORY_20260823.json`,
  marketplace: String.raw`N:\PrincessOS\workbench\dsh-capability-parity\planning-20260823\GIANA_WINDOWS_MARKETPLACE_CATALOG_20260823.jsonl`,
  output: join(repositoryRoot, 'apps', 'web', 'public', 'giana-catalogs'),
}

const FORBIDDEN_PUBLIC_KEYS = new Set([
  'sourcePath',
  'sourceRoot',
  'sourceManifest',
  'path',
  'locator',
  'privateLocator',
])

function parseArguments(argv) {
  const options = { ...defaults }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!value || !['--skills', '--connectors', '--marketplace', '--output'].includes(flag)) {
      throw new Error('Usage: generate-runtime-catalogs.mjs [--skills file] [--connectors file] [--marketplace file] [--output directory]')
    }
    options[flag.slice(2)] = resolve(value)
  }
  return options
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function expectObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function expectArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function expectString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function optionalString(value, label) {
  if (value === null || value === undefined || value === '') return null
  return expectString(value, label)
}

function expectNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

function expectBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a Boolean`)
  return value
}

function splitList(value, label) {
  return expectString(value, label).split(';').map(item => item.trim()).filter(Boolean)
}

function stringList(value, label) {
  return expectArray(value, label).map((item, index) => expectString(item, `${label}[${index}]`))
}

function publicUrl(value, label) {
  const text = optionalString(value, label)
  if (text === null) return null
  try {
    const url = new URL(text)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

function assertUnique(entries, key, label) {
  const values = entries.map(entry => entry[key])
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate ${key} values`)
}

function assertPublicProjection(value, label) {
  const visit = (item) => {
    if (Array.isArray(item)) {
      item.forEach(visit)
      return
    }
    if (item === null || typeof item !== 'object') return
    for (const [key, child] of Object.entries(item)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(key)) throw new Error(`${label} contains forbidden field ${key}`)
      visit(child)
    }
  }
  visit(value)
}

function sourceProvenance({ name, schema, generatedAt, mode, raw }) {
  return {
    name,
    schema,
    generatedAt,
    mode,
    sha256: sha256(raw),
  }
}

async function loadJson(path, label) {
  const raw = await readFile(path, 'utf8')
  return { raw, value: expectObject(JSON.parse(raw), label) }
}

async function loadJsonLines(path, label) {
  const raw = await readFile(path, 'utf8')
  const lines = raw.split(/\r?\n/u).filter(line => line.trim().length > 0)
  const value = lines.map((line, index) => expectObject(JSON.parse(line), `${label} line ${index + 1}`))
  return { raw, value }
}

function projectSkills(source, raw, generatedAt) {
  const rows = expectArray(source.rows, 'skills.rows')
  const counts = expectObject(source.counts, 'skills.counts')
  const entries = rows.map((rowValue, index) => {
    const row = expectObject(rowValue, `skills.rows[${index}]`)
    const status = expectString(row.runtimeStatus, `skills.rows[${index}].runtimeStatus`)
    if (!['READY_HISTORICAL_INVENTORY', 'PENDING_RUNTIME_OR_CONNECTOR'].includes(status)) {
      throw new Error(`skills.rows[${index}].runtimeStatus is not supported: ${status}`)
    }
    return {
      id: expectString(row.name, `skills.rows[${index}].name`),
      title: expectString(row.name, `skills.rows[${index}].name`),
      description: expectString(row.description, `skills.rows[${index}].description`),
      category: expectString(row.category, `skills.rows[${index}].category`),
      status,
      provenance: {
        sourceFamily: expectString(row.sourceFamily, `skills.rows[${index}].sourceFamily`),
      },
    }
  })
  const ready = entries.filter(entry => entry.status === 'READY_HISTORICAL_INVENTORY').length
  const pending = entries.filter(entry => entry.status === 'PENDING_RUNTIME_OR_CONNECTOR').length
  const declaredTotal = expectNumber(counts.activeProjectedSkills, 'skills.counts.activeProjectedSkills')
  if (entries.length !== declaredTotal || ready !== counts.runtimeReadySkills || pending !== counts.runtimePendingSkills) {
    throw new Error('Skill projection counts do not reconcile with the source inventory')
  }
  assertUnique(entries, 'id', 'Skill projection')

  return {
    schema: 'giana.browser.skill-catalog.v1',
    catalog: 'skills',
    generatedAt,
    status: {
      code: 'MIXED_HISTORICAL_EVIDENCE',
      label: 'Historical evidence and runtime pending',
      detail: 'Historical inventory evidence does not assert current runtime readiness.',
    },
    currentness: {
      asOf: expectString(source.generatedAt, 'skills.generatedAt'),
      basis: 'Source inventory generation time',
    },
    provenance: sourceProvenance({
      name: 'GIANA_WINDOWS_SKILL_FEATURE_INVENTORY_20260823.json',
      schema: expectString(source.schema, 'skills.schema'),
      generatedAt: expectString(source.generatedAt, 'skills.generatedAt'),
      mode: expectString(source.mode, 'skills.mode'),
      raw,
    }),
    counts: {
      total: entries.length,
      historicalRuntimeEvidence: ready,
      needsRuntimeOrConnector: pending,
      held: expectNumber(counts.heldSkills, 'skills.counts.heldSkills'),
    },
    entries,
  }
}

function projectConnectors(source, raw, generatedAt) {
  const providers = expectArray(source.providers, 'connectors.providers')
  const entries = providers.map((providerValue, index) => {
    const provider = expectObject(providerValue, `connectors.providers[${index}]`)
    const status = expectString(provider.status, `connectors.providers[${index}].status`)
    if (status !== 'DISCOVERABLE_NOT_CONNECTED_BY_DEFAULT') {
      throw new Error(`connectors.providers[${index}].status is not supported: ${status}`)
    }
    const service = expectString(provider.service, `connectors.providers[${index}].service`)
    return {
      id: service,
      title: expectString(provider.displayName, `connectors.providers[${index}].displayName`),
      categories: splitList(provider.categories, `connectors.providers[${index}].categories`),
      authTypes: splitList(provider.authTypes, `connectors.providers[${index}].authTypes`),
      actionCount: expectNumber(provider.actionCount, `connectors.providers[${index}].actionCount`),
      status,
      homepageUrl: publicUrl(provider.homepageUrl, `connectors.providers[${index}].homepageUrl`),
      provenance: { service },
    }
  })
  const actionCount = entries.reduce((total, entry) => total + entry.actionCount, 0)
  if (entries.length !== source.providerCount || actionCount !== source.actionCount) {
    throw new Error('Connector projection counts do not reconcile with the source inventory')
  }
  assertUnique(entries, 'id', 'Connector projection')

  return {
    schema: 'giana.browser.connector-catalog.v1',
    catalog: 'connectors',
    generatedAt,
    status: {
      code: 'DISCOVERABLE_NOT_CONNECTED_BY_DEFAULT',
      label: 'Discoverable, not connected',
      detail: 'Catalog presence does not imply authentication, connection, installation, or runtime readiness.',
    },
    currentness: {
      asOf: expectString(source.generatedAt, 'connectors.generatedAt'),
      basis: 'Source inventory generation time',
    },
    provenance: sourceProvenance({
      name: 'GIANA_WINDOWS_OPENCONNECTOR_PROVIDER_INVENTORY_20260823.json',
      schema: expectString(source.schema, 'connectors.schema'),
      generatedAt: expectString(source.generatedAt, 'connectors.generatedAt'),
      mode: expectString(source.mode, 'connectors.mode'),
      raw,
    }),
    counts: { total: entries.length, actions: actionCount },
    entries,
  }
}

function projectMarketplace(rows, raw, generatedAt) {
  const entries = rows.map((rowValue, index) => {
    const row = expectObject(rowValue, `marketplace[${index}]`)
    return {
      id: expectString(row.id, `marketplace[${index}].id`),
      title: expectString(row.name, `marketplace[${index}].name`),
      description: optionalString(row.description, `marketplace[${index}].description`),
      type: expectString(row.type, `marketplace[${index}].type`),
      owner: expectString(row.owner, `marketplace[${index}].owner`),
      language: optionalString(row.language, `marketplace[${index}].language`),
      tags: stringList(row.tags, `marketplace[${index}].tags`),
      stars: expectNumber(row.stars, `marketplace[${index}].stars`),
      installMethod: expectString(row.installMethod, `marketplace[${index}].installMethod`),
      needsConfig: expectBoolean(row.needsConfig, `marketplace[${index}].needsConfig`),
      status: 'DISCOVERABLE_UNVERIFIED',
      homepageUrl: publicUrl(row.homepage, `marketplace[${index}].homepage`),
      updatedAt: expectString(row.updatedAt, `marketplace[${index}].updatedAt`),
      provenance: {
        sources: stringList(row.sources, `marketplace[${index}].sources`),
        lastCheckedAt: expectString(row.lastCheckedAt, `marketplace[${index}].lastCheckedAt`),
      },
    }
  })
  assertUnique(entries, 'id', 'Marketplace projection')
  const checkedAt = entries.map(entry => entry.provenance.lastCheckedAt).sort().at(-1)
  if (checkedAt === undefined) throw new Error('Marketplace projection is empty')

  return {
    schema: 'giana.browser.marketplace-catalog.v1',
    catalog: 'marketplace',
    generatedAt,
    status: {
      code: 'DISCOVERABLE_UNVERIFIED',
      label: 'Discoverable, unverified',
      detail: 'Marketplace discovery does not imply curation, trust, installation, or runtime readiness.',
    },
    currentness: { asOf: checkedAt, basis: 'Latest source entry check' },
    provenance: {
      name: 'GIANA_WINDOWS_MARKETPLACE_CATALOG_20260823.jsonl',
      schema: 'giana.windows.marketplace-catalog.jsonl.v1',
      generatedAt: null,
      mode: 'DISCOVERY_CATALOG',
      sha256: sha256(raw),
    },
    counts: {
      total: entries.length,
      cordisPlugins: entries.filter(entry => entry.type === 'cordis-plugin').length,
      skills: entries.filter(entry => entry.type === 'skill').length,
      needsConfig: entries.filter(entry => entry.needsConfig).length,
    },
    entries,
  }
}

function serialize(value, pretty = false) {
  assertPublicProjection(value, 'Generated catalog')
  return `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`
}

async function writeAtomically(path, content) {
  const temporaryPath = `${path}.tmp-${process.pid}`
  await writeFile(temporaryPath, content, 'utf8')
  try {
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

const options = parseArguments(process.argv.slice(2))
const generatedAt = new Date().toISOString()
const [skillsSource, connectorsSource, marketplaceSource] = await Promise.all([
  loadJson(options.skills, 'skills'),
  loadJson(options.connectors, 'connectors'),
  loadJsonLines(options.marketplace, 'marketplace'),
])

const catalogs = [
  projectSkills(skillsSource.value, skillsSource.raw, generatedAt),
  projectConnectors(connectorsSource.value, connectorsSource.raw, generatedAt),
  projectMarketplace(marketplaceSource.value, marketplaceSource.raw, generatedAt),
]
const artifacts = catalogs.map((catalog) => {
  const file = `${catalog.catalog}.json`
  const content = serialize(catalog)
  return { catalog, file, content, sha256: sha256(content), bytes: Buffer.byteLength(content) }
})
const catalogByName = Object.fromEntries(catalogs.map(catalog => [catalog.catalog, catalog]))
const manifest = {
  schema: 'giana.browser.catalog-manifest.v1',
  generatedAt,
  status: 'SANITIZED_SOURCE_PROJECTION',
  sanitization: { policy: 'PUBLIC_FIELD_ALLOWLIST' },
  counts: {
    skills: catalogByName.skills.counts.total,
    skillsWithHistoricalRuntimeEvidence: catalogByName.skills.counts.historicalRuntimeEvidence,
    skillsNeedingRuntimeOrConnector: catalogByName.skills.counts.needsRuntimeOrConnector,
    connectorProviders: catalogByName.connectors.counts.total,
    connectorActions: catalogByName.connectors.counts.actions,
    marketplaceItems: catalogByName.marketplace.counts.total,
  },
  catalogs: artifacts.map(({ catalog, file, sha256: artifactSha256, bytes }) => ({
    id: catalog.catalog,
    href: `./${file}`,
    schema: catalog.schema,
    total: catalog.counts.total,
    status: catalog.status.code,
    currentnessAsOf: catalog.currentness.asOf,
    source: catalog.provenance.name,
    sourceSha256: catalog.provenance.sha256,
    artifactSha256,
    bytes,
  })),
}

await mkdir(options.output, { recursive: true })
await Promise.all(artifacts.map(artifact => writeAtomically(join(options.output, artifact.file), artifact.content)))
await writeAtomically(join(options.output, 'manifest.json'), serialize(manifest, true))

process.stdout.write(`${JSON.stringify({ output: options.output, counts: manifest.counts }, null, 2)}\n`)
