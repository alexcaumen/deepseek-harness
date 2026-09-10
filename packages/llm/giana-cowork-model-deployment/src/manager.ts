/** Fixed-command Server Manager process for the isolated Giana CoWork Preview deployment. */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

const RECEIPT_SCHEMA = 'giana.server-manager.resource-lease-receipt.v2'
const REGISTRY_SCHEMA = 'giana.cowork.preview.model-registry.v1'
const STATE_SCHEMA = 'giana.cowork.preview.model-manager-state.v1'
const BARE_DIGEST = /^[a-f0-9]{64}$/u
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u
const SAFE_TOKEN = /^[A-Za-z0-9._/:+-]+$/u
const TARGETS = ['r5300', 'prdg', 'ram-cpu'] as const
const STAGES = ['preflight', 'prestate', 'drain', 'stop', 'verify-stopped', 'start', 'health', 'probe'] as const
const MAX_FRAME_BYTES = 262_144
const MAX_CAPTURE_BYTES = 1_048_576

type TargetClass = typeof TARGETS[number]
type Stage = typeof STAGES[number]
type TransactionKind = 'MODEL_ROUTE' | 'IDLE_UNLOAD' | 'SHUTDOWN'

interface TargetDescriptor {
  readonly class: TargetClass
  readonly identity_digest: string
  readonly currentness_digest: string
}

interface ResourceRequirement {
  readonly gpuIndices: readonly number[]
  readonly minimumFreeVramMiB: Readonly<Record<string, number>>
  readonly reclaimableVramMiB: Readonly<Record<string, number>>
  readonly minimumFreeRamMiB: number
  readonly reclaimableRamMiB: number
}

interface RuntimeConfig {
  readonly kind: 'docker' | 'script' | 'systemd'
  readonly container?: string
  readonly containerId?: string
  readonly imageId?: string
  readonly startPath?: string
  readonly stopPath?: string
  readonly startSha256?: string
  readonly stopSha256?: string
  readonly pidFile?: string
  readonly processMarker?: string
  readonly unit?: string
  readonly launcherPath?: string
  readonly launcherSha256?: string
  readonly remotePort: number
  readonly expectedModel: string
  readonly drain: DrainConfig
  readonly release: ReleaseConfig
}

interface DrainConfig {
  readonly kind: 'sglang-load' | 'vllm-metrics'
  readonly path: string
  readonly pollIntervalMs: number
}

interface ReleaseConfig {
  readonly pollIntervalMs: number
  readonly maximumSamples: number
}

type ProcessPresence =
  | { readonly kind: 'running'; readonly processGroups: readonly number[] }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'unknown' }

type Residency =
  | { readonly kind: 'empty' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'resident'; readonly route: ManagedRoute; readonly processGroups: readonly number[] }

interface ManagedRoute {
  readonly id: string
  readonly revisionDigest: string
  readonly target: TargetClass
  readonly exclusiveEndpoint: boolean
  readonly runtime: RuntimeConfig
  readonly resources: ResourceRequirement
}

interface HostSlotConfig {
  readonly id: string
  readonly lockPath: string
  readonly operationLockPath: string
  readonly statePath: string
  readonly counterPath: string
}

/** Validated fixed-command registry consumed by the preview manager. */
export interface PreviewManagerRegistry {
  readonly schema: typeof REGISTRY_SCHEMA
  readonly issuerRef: string
  readonly holderRef: string
  readonly admissionDigest: string
  readonly renewAfterMs: number
  readonly slot: HostSlotConfig
  readonly targets: readonly TargetDescriptor[]
  readonly routes: readonly ManagedRoute[]
}

interface LeaseState {
  readonly leaseId: string
  readonly fence: number
  readonly generation: number
  readonly targets: readonly TargetClass[]
  readonly targetDescriptors: readonly TargetDescriptor[]
  expiresAt: number
  readonly renewAfterMs: number
  quarantined: boolean
}

interface TransactionState {
  readonly digest: string
  readonly kind: TransactionKind
  readonly scopeDigest: string
  nextAllowed: Stage[]
  cleanCancelable: boolean
  terminal: boolean
  started: boolean
  sequence: number
  allowedRoutes: Partial<Record<Stage, string[]>>
  destinationRouteId?: string | undefined
  sourceRouteId?: string | undefined
  destinationPrestateCaptured: boolean
  recovery: boolean
  startedRouteId?: string | undefined
  adoptedResidentRouteId?: string | undefined
  lastStoppedRouteId?: string | undefined
  inFlight?: Stage | undefined
}

interface ReplayEntry {
  readonly operation: string
  readonly key: string
  readonly requestDigest: string
  status: 'PENDING' | 'COMPLETE'
  result?: Readonly<Record<string, unknown>> | undefined
}

interface ManagerState {
  readonly schema: typeof STATE_SCHEMA
  nextFence: number
  generation: number
  lease?: LeaseState | undefined
  transactions: Record<string, TransactionState>
  replay: ReplayEntry[]
}

/** Fixed local process and remote host arguments for one manager instance. */
export interface PreviewManagerArguments {
  readonly registryPath: string
  readonly statePath: string
  readonly sshExecutable: string
  readonly sshConfigPath: string
  readonly sshHost: string
}

/** Sanitized settlement returned by one injected remote command runner. */
export interface PreviewManagerRemoteResult {
  readonly code: number
  readonly stdout: string
}

/** Deployment-owned remote runner used by the manager and its keyless tests. */
export type PreviewManagerRemoteRunner = (command: string, timeoutMs: number) => Promise<PreviewManagerRemoteResult>

class ManagerError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'BUSY' | 'LEASE_MISMATCH' | 'STATE_CONFLICT' | 'REMOTE_FAILURE' | 'UNKNOWN_COMMIT') {
    super(code)
    this.name = 'ManagerError'
  }
}

class StageBudget {
  private readonly deadline: number

  constructor(timeoutMs: number) {
    this.deadline = Date.now() + timeoutMs
  }

  remaining(maximum = Number.MAX_SAFE_INTEGER): number {
    const remaining = Math.floor(this.deadline - Date.now())
    if (remaining < 1) throw new ManagerError('REMOTE_FAILURE')
    return Math.min(remaining, maximum)
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ManagerError('INVALID_REQUEST')
  return value as Record<string, unknown>
}

function stringField(value: unknown, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || (pattern !== undefined && !pattern.test(value))) {
    throw new ManagerError('INVALID_REQUEST')
  }
  return value
}

function integerField(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new ManagerError('INVALID_REQUEST')
  }
  return Number(value)
}

function asciiJsonString(value: string): string {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/gu, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return asciiJsonString(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ManagerError('INVALID_REQUEST')
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const input = record(value)
  return `{${Object.keys(input).sort().map(key => `${asciiJsonString(key)}:${canonicalJson(input[key])}`).join(',')}}`
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function receipt(body: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...body, receiptDigest: `sha256:${digest(body)}` })
}

function sortedTargets(targets: readonly TargetDescriptor[]): readonly TargetDescriptor[] {
  return [...targets].sort((left, right) => left.class.localeCompare(right.class))
}

function parseArguments(argv: readonly string[]): PreviewManagerArguments {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (name === undefined || value === undefined || !name.startsWith('--') || values.has(name)) {
      throw new ManagerError('INVALID_REQUEST')
    }
    values.set(name, value)
  }
  const registryPath = stringField(values.get('--registry'))
  const statePath = stringField(values.get('--state'))
  const sshExecutable = stringField(values.get('--ssh'))
  const sshConfigPath = stringField(values.get('--ssh-config'))
  const sshHost = stringField(values.get('--host'), SAFE_TOKEN)
  if (!isAbsolute(registryPath) || !isAbsolute(statePath) || !isAbsolute(sshExecutable) || !isAbsolute(sshConfigPath)) {
    throw new ManagerError('INVALID_REQUEST')
  }
  return { registryPath, statePath, sshExecutable, sshConfigPath, sshHost }
}

function targetClass(value: unknown): TargetClass {
  if (typeof value !== 'string' || !TARGETS.includes(value as TargetClass)) throw new ManagerError('INVALID_REQUEST')
  return value as TargetClass
}

function strictKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new ManagerError('INVALID_REQUEST')
}

function parseRequirement(value: unknown): ResourceRequirement {
  const input = record(value)
  strictKeys(input, ['gpuIndices', 'minimumFreeVramMiB', 'reclaimableVramMiB', 'minimumFreeRamMiB', 'reclaimableRamMiB'])
  if (!Array.isArray(input.gpuIndices) || input.gpuIndices.length === 0) throw new ManagerError('INVALID_REQUEST')
  const gpuIndices = input.gpuIndices.map(index => integerField(index, 0, 31))
  if (new Set(gpuIndices).size !== gpuIndices.length) throw new ManagerError('INVALID_REQUEST')
  const parseMap = (candidate: unknown): Readonly<Record<string, number>> => {
    const map = record(candidate)
    const result: Record<string, number> = {}
    for (const [key, entry] of Object.entries(map)) {
      const index = integerField(Number(key), 0, 31)
      if (!gpuIndices.includes(index) || String(index) !== key) throw new ManagerError('INVALID_REQUEST')
      result[key] = integerField(entry, 0)
    }
    if (gpuIndices.some(index => result[String(index)] === undefined)) throw new ManagerError('INVALID_REQUEST')
    return Object.freeze(result)
  }
  return Object.freeze({
    gpuIndices: Object.freeze(gpuIndices),
    minimumFreeVramMiB: parseMap(input.minimumFreeVramMiB),
    reclaimableVramMiB: parseMap(input.reclaimableVramMiB),
    minimumFreeRamMiB: integerField(input.minimumFreeRamMiB, 0),
    reclaimableRamMiB: integerField(input.reclaimableRamMiB, 0),
  })
}

function parseRuntime(value: unknown): RuntimeConfig {
  const input = record(value)
  strictKeys(input, [
    'kind', 'container', 'startPath', 'stopPath', 'startSha256', 'stopSha256', 'pidFile', 'processMarker',
    'containerId', 'imageId', 'unit', 'launcherPath', 'launcherSha256',
    'remotePort', 'expectedModel', 'drain', 'release',
  ])
  if (input.kind !== 'docker' && input.kind !== 'script' && input.kind !== 'systemd') {
    throw new ManagerError('INVALID_REQUEST')
  }
  const expectedModel = stringField(input.expectedModel, SAFE_TOKEN)
  const remotePort = integerField(input.remotePort, 1, 65_535)
  const drainInput = record(input.drain)
  strictKeys(drainInput, ['kind', 'path', 'pollIntervalMs'])
  if (drainInput.kind !== 'sglang-load' && drainInput.kind !== 'vllm-metrics') {
    throw new ManagerError('INVALID_REQUEST')
  }
  const drainPath = stringField(drainInput.path, SAFE_TOKEN)
  if (!drainPath.startsWith('/')) throw new ManagerError('INVALID_REQUEST')
  const drain = Object.freeze({
    kind: drainInput.kind,
    path: drainPath,
    pollIntervalMs: integerField(drainInput.pollIntervalMs, 1, 10_000),
  })
  const releaseInput = record(input.release)
  strictKeys(releaseInput, ['pollIntervalMs', 'maximumSamples'])
  const release = Object.freeze({
    pollIntervalMs: integerField(releaseInput.pollIntervalMs, 1, 10_000),
    maximumSamples: integerField(releaseInput.maximumSamples, 3, 120),
  })
  if (input.kind === 'docker') {
    if (input.startPath !== undefined || input.stopPath !== undefined
      || input.startSha256 !== undefined || input.stopSha256 !== undefined || input.pidFile !== undefined
      || input.processMarker !== undefined || input.unit !== undefined || input.launcherPath !== undefined
      || input.launcherSha256 !== undefined || input.container === undefined || input.containerId === undefined
      || input.imageId === undefined) {
      throw new ManagerError('INVALID_REQUEST')
    }
    return Object.freeze({
      kind: 'docker',
      container: stringField(input.container, SAFE_TOKEN),
      containerId: stringField(input.containerId, BARE_DIGEST),
      imageId: stringField(input.imageId, SHA256_DIGEST),
      remotePort, expectedModel, drain, release,
    })
  }
  if (input.kind === 'systemd') {
    if (input.container !== undefined || input.containerId !== undefined || input.imageId !== undefined
      || input.startPath !== undefined || input.stopPath !== undefined
      || input.startSha256 !== undefined || input.stopSha256 !== undefined
      || input.pidFile !== undefined || input.unit === undefined || input.launcherPath === undefined
      || input.launcherSha256 === undefined || input.processMarker === undefined) {
      throw new ManagerError('INVALID_REQUEST')
    }
    const unit = stringField(input.unit, SAFE_TOKEN)
    const launcherPath = stringField(input.launcherPath, SAFE_TOKEN)
    if (!unit.endsWith('.service') || !launcherPath.startsWith('/')) throw new ManagerError('INVALID_REQUEST')
    return Object.freeze({
      kind: 'systemd', unit, launcherPath,
      launcherSha256: stringField(input.launcherSha256, BARE_DIGEST),
      processMarker: stringField(input.processMarker, SAFE_TOKEN),
      remotePort, expectedModel, drain, release,
    })
  }
  if (input.container !== undefined || input.containerId !== undefined || input.imageId !== undefined
    || input.startPath === undefined || input.stopPath === undefined
    || input.startSha256 === undefined || input.stopSha256 === undefined
    || input.pidFile === undefined || input.processMarker === undefined || input.unit !== undefined
    || input.launcherPath !== undefined || input.launcherSha256 !== undefined) {
    throw new ManagerError('INVALID_REQUEST')
  }
  const startPath = stringField(input.startPath, SAFE_TOKEN)
  const stopPath = stringField(input.stopPath, SAFE_TOKEN)
  const startSha256 = stringField(input.startSha256, BARE_DIGEST)
  const stopSha256 = stringField(input.stopSha256, BARE_DIGEST)
  const pidFile = stringField(input.pidFile, SAFE_TOKEN)
  const processMarker = stringField(input.processMarker, SAFE_TOKEN)
  if (!startPath.startsWith('/') || !stopPath.startsWith('/') || !pidFile.startsWith('/')) {
    throw new ManagerError('INVALID_REQUEST')
  }
  return Object.freeze({
    kind: 'script', startPath, stopPath, startSha256, stopSha256,
    pidFile, processMarker, remotePort, expectedModel, drain, release,
  })
}

/** Parse and validate a fixed-command preview registry. */
export function parsePreviewManagerRegistry(value: unknown): PreviewManagerRegistry {
  const input = record(value)
  strictKeys(input, ['schema', 'issuerRef', 'holderRef', 'admissionDigest', 'renewAfterMs', 'slot', 'targets', 'routes'])
  if (input.schema !== REGISTRY_SCHEMA || !Array.isArray(input.targets) || !Array.isArray(input.routes)
    || input.targets.length === 0 || input.routes.length === 0) throw new ManagerError('INVALID_REQUEST')
  const targets = input.targets.map((candidate) => {
    const target = record(candidate)
    strictKeys(target, ['class', 'identity_digest', 'currentness_digest'])
    return Object.freeze({
      class: targetClass(target.class),
      identity_digest: stringField(target.identity_digest, BARE_DIGEST),
      currentness_digest: stringField(target.currentness_digest, BARE_DIGEST),
    })
  })
  if (new Set(targets.map(target => target.class)).size !== targets.length) throw new ManagerError('INVALID_REQUEST')
  const routes = input.routes.map((candidate) => {
    const route = record(candidate)
    strictKeys(route, ['id', 'revisionDigest', 'target', 'exclusiveEndpoint', 'runtime', 'resources'])
    if (route.exclusiveEndpoint !== true) throw new ManagerError('INVALID_REQUEST')
    const target = targetClass(route.target)
    if (!targets.some(entry => entry.class === target)) throw new ManagerError('INVALID_REQUEST')
    return Object.freeze({
      id: stringField(route.id, SAFE_TOKEN),
      revisionDigest: stringField(route.revisionDigest, BARE_DIGEST),
      target,
      exclusiveEndpoint: true,
      runtime: parseRuntime(route.runtime),
      resources: parseRequirement(route.resources),
    })
  })
  if (new Set(routes.map(route => route.id)).size !== routes.length
    || new Set(routes.map(route => route.runtime.remotePort)).size !== routes.length) throw new ManagerError('INVALID_REQUEST')
  const slotInput = record(input.slot)
  strictKeys(slotInput, ['id', 'lockPath', 'operationLockPath', 'statePath', 'counterPath'])
  const remotePath = (value: unknown): string => {
    const path = stringField(value, SAFE_TOKEN)
    if (!path.startsWith('/')) throw new ManagerError('INVALID_REQUEST')
    return path
  }
  const slot = Object.freeze({
    id: stringField(slotInput.id, SAFE_TOKEN),
    lockPath: remotePath(slotInput.lockPath),
    operationLockPath: remotePath(slotInput.operationLockPath),
    statePath: remotePath(slotInput.statePath),
    counterPath: remotePath(slotInput.counterPath),
  })
  if (new Set([
    slot.lockPath,
    slot.operationLockPath,
    slot.statePath,
    slot.counterPath,
  ]).size !== 4) throw new ManagerError('INVALID_REQUEST')
  return Object.freeze({
    schema: REGISTRY_SCHEMA,
    issuerRef: stringField(input.issuerRef),
    holderRef: stringField(input.holderRef),
    admissionDigest: stringField(input.admissionDigest, BARE_DIGEST),
    renewAfterMs: integerField(input.renewAfterMs, 1),
    slot,
    targets: Object.freeze(targets),
    routes: Object.freeze(routes),
  })
}

function initialState(): ManagerState {
  return { schema: STATE_SCHEMA, nextFence: 1, generation: 0, transactions: {}, replay: [] }
}

function parseState(value: unknown): ManagerState {
  try {
    const input = record(value)
    strictKeys(input, ['schema', 'nextFence', 'generation', 'lease', 'transactions', 'replay'])
    if (input.schema !== STATE_SCHEMA) throw new ManagerError('STATE_CONFLICT')

    let lease: LeaseState | undefined
    if (input.lease !== undefined) {
      const candidate = record(input.lease)
      strictKeys(candidate, [
        'leaseId', 'fence', 'generation', 'targets', 'targetDescriptors',
        'expiresAt', 'renewAfterMs', 'quarantined',
      ])
      if (!Array.isArray(candidate.targets) || !Array.isArray(candidate.targetDescriptors)
        || typeof candidate.quarantined !== 'boolean') throw new ManagerError('STATE_CONFLICT')
      const targets = candidate.targets.map(targetClass)
      const targetDescriptors = candidate.targetDescriptors.map((value) => {
        const descriptor = record(value)
        strictKeys(descriptor, ['class', 'identity_digest', 'currentness_digest'])
        return {
          class: targetClass(descriptor.class),
          identity_digest: stringField(descriptor.identity_digest, BARE_DIGEST),
          currentness_digest: stringField(descriptor.currentness_digest, BARE_DIGEST),
        }
      })
      if (targets.length === 0 || new Set(targets).size !== targets.length
        || canonicalJson([...targets].sort()) !== canonicalJson(targetDescriptors.map(entry => entry.class).sort())) {
        throw new ManagerError('STATE_CONFLICT')
      }
      lease = {
        leaseId: stringField(candidate.leaseId, BARE_DIGEST),
        fence: integerField(candidate.fence, 1),
        generation: integerField(candidate.generation, 1),
        targets,
        targetDescriptors,
        expiresAt: integerField(candidate.expiresAt, 1),
        renewAfterMs: integerField(candidate.renewAfterMs, 1),
        quarantined: candidate.quarantined,
      }
    }

    const transactionInput = record(input.transactions)
    const transactions: Record<string, TransactionState> = {}
    for (const [key, value] of Object.entries(transactionInput)) {
      if (!BARE_DIGEST.test(key)) throw new ManagerError('STATE_CONFLICT')
      const candidate = record(value)
      strictKeys(candidate, [
        'digest', 'kind', 'scopeDigest', 'nextAllowed', 'cleanCancelable', 'terminal', 'started', 'sequence',
        'allowedRoutes', 'destinationRouteId', 'sourceRouteId', 'destinationPrestateCaptured', 'recovery',
        'startedRouteId', 'adoptedResidentRouteId', 'lastStoppedRouteId', 'inFlight',
      ])
      const kind = stringField(candidate.kind) as TransactionKind
      if (!['MODEL_ROUTE', 'IDLE_UNLOAD', 'SHUTDOWN'].includes(kind)
        || !Array.isArray(candidate.nextAllowed)
        || typeof candidate.cleanCancelable !== 'boolean'
        || typeof candidate.terminal !== 'boolean'
        || typeof candidate.started !== 'boolean'
        || typeof candidate.destinationPrestateCaptured !== 'boolean'
        || typeof candidate.recovery !== 'boolean') throw new ManagerError('STATE_CONFLICT')
      const nextAllowed = candidate.nextAllowed.map((value) => {
        const stage = stringField(value) as Stage
        if (!STAGES.includes(stage)) throw new ManagerError('STATE_CONFLICT')
        return stage
      })
      if (new Set(nextAllowed).size !== nextAllowed.length) throw new ManagerError('STATE_CONFLICT')
      const allowedInput = record(candidate.allowedRoutes)
      strictKeys(allowedInput, STAGES)
      const allowedRoutes: Partial<Record<Stage, string[]>> = {}
      for (const [name, routes] of Object.entries(allowedInput)) {
        if (!Array.isArray(routes) || routes.length === 0) throw new ManagerError('STATE_CONFLICT')
        const values = routes.map(route => route === '*' ? '*' : stringField(route, SAFE_TOKEN))
        if (new Set(values).size !== values.length) throw new ManagerError('STATE_CONFLICT')
        allowedRoutes[name as Stage] = values
      }
      const allowedStages = STAGES.filter(stage => allowedRoutes[stage] !== undefined)
      if (canonicalJson(nextAllowed) !== canonicalJson(allowedStages)
        || candidate.terminal !== (nextAllowed.length === 0)) throw new ManagerError('STATE_CONFLICT')
      const optionalRoute = (route: unknown): string | undefined => route === undefined
        ? undefined
        : stringField(route, SAFE_TOKEN)
      const inFlight = candidate.inFlight === undefined ? undefined : stringField(candidate.inFlight) as Stage
      if (inFlight !== undefined && (!STAGES.includes(inFlight) || !nextAllowed.includes(inFlight))) {
        throw new ManagerError('STATE_CONFLICT')
      }
      const startedRouteId = optionalRoute(candidate.startedRouteId)
      if (candidate.started !== (startedRouteId !== undefined)) throw new ManagerError('STATE_CONFLICT')
      const destinationRouteId = optionalRoute(candidate.destinationRouteId)
      const sourceRouteId = optionalRoute(candidate.sourceRouteId)
      const adoptedResidentRouteId = optionalRoute(candidate.adoptedResidentRouteId)
      const lastStoppedRouteId = optionalRoute(candidate.lastStoppedRouteId)
      const structurallyAdopted = kind === 'MODEL_ROUTE'
        && candidate.destinationPrestateCaptured
        && !candidate.started
        && startedRouteId === undefined
        && destinationRouteId !== undefined
        && sourceRouteId === destinationRouteId
      if (structurallyAdopted !== (adoptedResidentRouteId !== undefined)) {
        throw new ManagerError('STATE_CONFLICT')
      }
      if (adoptedResidentRouteId !== undefined && (kind !== 'MODEL_ROUTE'
        || startedRouteId !== undefined
        || adoptedResidentRouteId !== destinationRouteId
        || adoptedResidentRouteId !== sourceRouteId
        || !candidate.destinationPrestateCaptured
        || candidate.recovery
        || candidate.cleanCancelable
        || lastStoppedRouteId !== undefined
        || (!candidate.terminal && !(nextAllowed.length === 1
          && (nextAllowed[0] === 'health' || nextAllowed[0] === 'probe')
          && allowedRoutes[nextAllowed[0]]?.length === 1
          && allowedRoutes[nextAllowed[0]]?.[0] === adoptedResidentRouteId)))) {
        throw new ManagerError('STATE_CONFLICT')
      }
      transactions[key] = {
        digest: stringField(candidate.digest, BARE_DIGEST),
        kind,
        scopeDigest: stringField(candidate.scopeDigest, BARE_DIGEST),
        nextAllowed,
        cleanCancelable: candidate.cleanCancelable,
        terminal: candidate.terminal,
        started: candidate.started,
        sequence: integerField(candidate.sequence, 1),
        allowedRoutes,
        destinationRouteId,
        sourceRouteId,
        destinationPrestateCaptured: candidate.destinationPrestateCaptured,
        recovery: candidate.recovery,
        startedRouteId,
        adoptedResidentRouteId,
        lastStoppedRouteId,
        ...(inFlight === undefined ? {} : { inFlight }),
      }
      const restored = transactions[key]
      if (restored === undefined || restored.digest !== key) throw new ManagerError('STATE_CONFLICT')
    }

    if (!Array.isArray(input.replay) || input.replay.length > 256) throw new ManagerError('STATE_CONFLICT')
    const replay = input.replay.map((value) => {
      const candidate = record(value)
      strictKeys(candidate, ['operation', 'key', 'requestDigest', 'status', 'result'])
      if (candidate.status !== 'PENDING' && candidate.status !== 'COMPLETE') throw new ManagerError('STATE_CONFLICT')
      const result = candidate.result === undefined ? undefined : record(candidate.result)
      if ((candidate.status === 'COMPLETE') !== (result !== undefined)) throw new ManagerError('STATE_CONFLICT')
      return {
        operation: stringField(candidate.operation, SAFE_TOKEN),
        key: stringField(candidate.key, BARE_DIGEST),
        requestDigest: stringField(candidate.requestDigest, BARE_DIGEST),
        status: candidate.status,
        ...(result === undefined ? {} : { result }),
      } satisfies ReplayEntry
    })
    if (new Set(replay.map(entry => `${entry.operation}:${entry.key}`)).size !== replay.length) {
      throw new ManagerError('STATE_CONFLICT')
    }

    const nextFence = integerField(input.nextFence, 1)
    const generation = integerField(input.generation, 0)
    if (lease !== undefined && (lease.fence >= nextFence || lease.generation > generation)) {
      throw new ManagerError('STATE_CONFLICT')
    }
    return {
      schema: STATE_SCHEMA,
      nextFence,
      generation,
      ...(lease === undefined ? {} : { lease }),
      transactions,
      replay,
    }
  } catch {
    throw new ManagerError('STATE_CONFLICT')
  }
}

/** Durable state owner used by one preview manager process. */
export class PreviewManagerStateStore {
  private state = initialState()
  private queue = Promise.resolve()
  private persistenceFailed = false

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await withFileLock(this.path, () => this.reload())
  }

  private async reload(): Promise<void> {
    try {
      let value: unknown
      try { value = JSON.parse(await readFile(this.path, 'utf8')) as unknown }
      catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error
        throw new ManagerError('STATE_CONFLICT')
      }
      this.state = parseState(value)
    }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  run<T>(operation: (state: ManagerState) => Promise<T> | T): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.persistenceFailed) throw new ManagerError('STATE_CONFLICT')
      return withFileLock(this.path, async () => {
        await this.reload()
        return operation(this.state)
      })
    })
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  async persist(): Promise<void> {
    try { await this.writeState() }
    catch (error: unknown) {
      // In-memory changes must never be replayed as durable success after an I/O failure.
      this.persistenceFailed = true
      throw error
    }
  }

  private async writeState(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(this.state)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      await rename(temporary, this.path)
    } catch (error: unknown) {
      await handle.close().catch(() => {})
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function systemdPresenceCommand(runtime: RuntimeConfig): string {
  const script = [
    'set -euo pipefail',
    `unit=${shellQuote(runtime.unit ?? '')}`,
    `launcher=${shellQuote(runtime.launcherPath ?? '')}`,
    `expected_hash=${shellQuote(runtime.launcherSha256 ?? '')}`,
    `marker=${shellQuote(runtime.processMarker ?? '')}`,
    "unknown() { printf 'SYSTEMD UNKNOWN\\n'; exit 0; }",
    "actual_hash=$(sha256sum \"$launcher\" 2>/dev/null | awk '{print $1}') || unknown",
    '[ "$actual_hash" = "$expected_hash" ] || unknown',
    'properties=$(systemctl show "$unit" -p LoadState -p ActiveState -p SubState -p MainPID -p ControlGroup -p ExecStart --no-pager 2>/dev/null) || unknown',
    "property() { printf '%s\\n' \"$properties\" | sed -n \"s/^$1=//p\"; }",
    'load=$(property LoadState); active=$(property ActiveState); sub=$(property SubState)',
    'main=$(property MainPID); cgroup=$(property ControlGroup); exec_start=$(property ExecStart)',
    'marker_pids=""',
    'for cmdline in /proc/[0-9]*/cmdline; do [ -r "$cmdline" ] || continue; if tr "\\000" "\\n" < "$cmdline" 2>/dev/null | grep -Fqx -- "$marker"; then pid=${cmdline#/proc/}; marker_pids="$marker_pids ${pid%/cmdline}"; fi; done',
    'if [ "$load" = not-found ] && [ "$active" = inactive ] && [ "$sub" = dead ] && [ -z "$marker_pids" ]; then printf \'SYSTEMD STOPPED\\n\'; exit 0; fi',
    '[ "$load" = loaded ] && [ "$active" = active ] && [ "$sub" = running ] || unknown',
    '[[ "$main" =~ ^[1-9][0-9]*$ ]] || unknown',
    '[ "$cgroup" = "/system.slice/$unit" ] || unknown',
    'case "$exec_start" in *"argv[]=/usr/bin/bash $launcher ;"*) ;; *) unknown ;; esac',
    'cgroup_file="/sys/fs/cgroup$cgroup/cgroup.procs"; [ -r "$cgroup_file" ] || unknown',
    'grep -Fxq -- "$main" "$cgroup_file" || unknown',
    '[ -n "$marker_pids" ] || unknown',
    'for pid in $marker_pids; do grep -Fxq -- "$pid" "$cgroup_file" || unknown; done',
    'groups=""',
    'while read -r pid; do [[ "$pid" =~ ^[1-9][0-9]*$ ]] || unknown; group=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d " ") || unknown; [[ "$group" =~ ^[1-9][0-9]*$ ]] || unknown; groups="$groups $group"; done < "$cgroup_file"',
    '[ -n "$groups" ] || unknown',
    'unique_groups=$(printf \'%s\\n\' $groups | sort -n -u | paste -sd \' \' -)',
    "printf 'SYSTEMD RUNNING %s\\n' \"$unique_groups\"",
  ].join('\n')
  return `/usr/bin/bash -c ${shellQuote(script)}`
}

function systemdMutationCommand(runtime: RuntimeConfig, action: 'start' | 'stop'): string {
  const variables = [
    'set -euo pipefail',
    `unit=${shellQuote(runtime.unit ?? '')}`,
    `launcher=${shellQuote(runtime.launcherPath ?? '')}`,
    `expected_hash=${shellQuote(runtime.launcherSha256 ?? '')}`,
    `marker=${shellQuote(runtime.processMarker ?? '')}`,
    "actual_hash=$(sha256sum \"$launcher\" 2>/dev/null | awk '{print $1}')",
    '[ "$actual_hash" = "$expected_hash" ] || exit 76',
  ]
  if (action === 'start') {
    variables.push(
      'load=$(systemctl show "$unit" -p LoadState --value 2>/dev/null)',
      '[ "$load" = not-found ] || exit 76',
      'for cmdline in /proc/[0-9]*/cmdline; do [ -r "$cmdline" ] || continue; if tr "\\000" "\\n" < "$cmdline" 2>/dev/null | grep -Fqx -- "$marker"; then exit 76; fi; done',
      'systemd-run --unit="$unit" --collect --property=KillMode=mixed --property=TimeoutStopSec=3min --description="Giana CoWork Preview managed model" /usr/bin/bash "$launcher"',
    )
  } else {
    variables.push(
      'properties=$(systemctl show "$unit" -p LoadState -p ActiveState -p SubState -p MainPID -p ControlGroup -p ExecStart --no-pager 2>/dev/null)',
      "property() { printf '%s\\n' \"$properties\" | sed -n \"s/^$1=//p\"; }",
      'load=$(property LoadState); active=$(property ActiveState); sub=$(property SubState)',
      'main=$(property MainPID); cgroup=$(property ControlGroup); exec_start=$(property ExecStart)',
      '[ "$load" = loaded ] && [ "$active" = active ] && [ "$sub" = running ] || exit 76',
      '[[ "$main" =~ ^[1-9][0-9]*$ ]] || exit 76',
      '[ "$cgroup" = "/system.slice/$unit" ] || exit 76',
      'case "$exec_start" in *"argv[]=/usr/bin/bash $launcher ;"*) ;; *) exit 76 ;; esac',
      'cgroup_file="/sys/fs/cgroup$cgroup/cgroup.procs"; [ -r "$cgroup_file" ] || exit 76',
      'grep -Fxq -- "$main" "$cgroup_file" || exit 76',
      'marker_found=0',
      'for cmdline in /proc/[0-9]*/cmdline; do [ -r "$cmdline" ] || continue; if tr "\\000" "\\n" < "$cmdline" 2>/dev/null | grep -Fqx -- "$marker"; then pid=${cmdline#/proc/}; pid=${pid%/cmdline}; grep -Fxq -- "$pid" "$cgroup_file" || exit 76; marker_found=1; fi; done',
      '[ "$marker_found" -eq 1 ] || exit 76',
      'systemctl stop "$unit"',
    )
  }
  variables.push("printf 'GCP_SYSTEMD_MUTATION_APPLIED\\n'")
  return `/usr/bin/bash -c ${shellQuote(variables.join('\n'))}`
}

function dockerMutationCommand(runtime: RuntimeConfig, action: 'start' | 'stop'): string {
  const script = [
    'set -euo pipefail',
    `container=${shellQuote(runtime.container ?? '')}`,
    `container_id=${shellQuote(runtime.containerId ?? '')}`,
    `image_id=${shellQuote(runtime.imageId ?? '')}`,
    'identity=$(docker inspect --format \'{{.Id}} {{.Image}} {{.Name}}\' "$container" 2>/dev/null)',
    '[ "$identity" = "$container_id $image_id /$container" ] || exit 76',
    `docker ${action} ${action === 'stop' ? '--time 30 ' : ''}"$container_id"`,
    "printf 'GCP_DOCKER_MUTATION_APPLIED\\n'",
  ].join('\n')
  return `/usr/bin/bash -c ${shellQuote(script)}`
}

function scriptMutationCommand(runtime: RuntimeConfig, action: 'start' | 'stop'): string {
  const script = [
    'set -euo pipefail',
    `start_path=${shellQuote(runtime.startPath ?? '')}`,
    `stop_path=${shellQuote(runtime.stopPath ?? '')}`,
    `expected_start_hash=${shellQuote(runtime.startSha256 ?? '')}`,
    `expected_stop_hash=${shellQuote(runtime.stopSha256 ?? '')}`,
    `pid_file=${shellQuote(runtime.pidFile ?? '')}`,
    `marker=${shellQuote(runtime.processMarker ?? '')}`,
    "actual_start_hash=$(sha256sum \"$start_path\" 2>/dev/null | awk '{print $1}')",
    "actual_stop_hash=$(sha256sum \"$stop_path\" 2>/dev/null | awk '{print $1}')",
    '[ "$actual_start_hash" = "$expected_start_hash" ] || exit 76',
    '[ "$actual_stop_hash" = "$expected_stop_hash" ] || exit 76',
  ]
  if (action === 'start') {
    script.push(
      'for cmdline in /proc/[0-9]*/cmdline; do [ -r "$cmdline" ] || continue; if tr "\\000" "\\n" < "$cmdline" 2>/dev/null | grep -Fqx -- "$marker"; then exit 76; fi; done',
      '"$start_path"',
    )
  } else {
    script.push(
      '[ -r "$pid_file" ] || exit 76',
      'read -r tracked < "$pid_file" || exit 76',
      '[[ "$tracked" =~ ^[1-9][0-9]*$ ]] || exit 76',
      '[ -r "/proc/$tracked/cmdline" ] || exit 76',
      'tr "\\000" "\\n" < "/proc/$tracked/cmdline" | grep -Fqx -- "$marker" || exit 76',
      'matches=0',
      'for cmdline in /proc/[0-9]*/cmdline; do [ -r "$cmdline" ] || continue; if tr "\\000" "\\n" < "$cmdline" 2>/dev/null | grep -Fqx -- "$marker"; then pid=${cmdline#/proc/}; pid=${pid%/cmdline}; [ "$pid" = "$tracked" ] || exit 76; matches=$((matches + 1)); fi; done',
      '[ "$matches" -eq 1 ] || exit 76',
      '"$stop_path"',
    )
  }
  script.push("printf 'GCP_SCRIPT_MUTATION_APPLIED\\n'")
  return `/usr/bin/bash -c ${shellQuote(script.join('\n'))}`
}

function runRemote(args: PreviewManagerArguments, command: string, timeoutMs: number): Promise<PreviewManagerRemoteResult> {
  return new Promise((resolve, reject) => {
    const remoteSeconds = Math.max(1, Math.floor((timeoutMs - 2_000) / 1_000))
    const wrapped = `timeout --signal=TERM --kill-after=10 ${remoteSeconds}s bash -lc ${shellQuote(command)}`
    const childEnvironment: NodeJS.ProcessEnv = {}
    for (const name of [
      'SystemRoot', 'WINDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
      'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'TEMP', 'TMP',
    ] as const) {
      if (process.env[name] !== undefined) childEnvironment[name] = process.env[name]
    }
    const child = spawn(args.sshExecutable, [
      '-F', args.sshConfigPath,
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', args.sshHost, wrapped,
    ], {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment,
    })
    let stdout = Buffer.alloc(0)
    let captured = 0
    let timedOut = false
    const append = (chunk: Buffer): void => {
      captured += chunk.length
      if (captured > MAX_CAPTURE_BYTES) {
        child.kill('SIGKILL')
        reject(new ManagerError('REMOTE_FAILURE'))
        return
      }
      stdout = Buffer.concat([stdout, chunk])
    }
    child.stdout.on('data', append)
    child.stderr.on('data', (chunk: Buffer) => { captured += chunk.length })
    child.on('error', () => { reject(new ManagerError('REMOTE_FAILURE')) })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.once('close', (code) => {
      clearTimeout(timer)
      if (timedOut || code === null) reject(new ManagerError('UNKNOWN_COMMIT'))
      else resolve({ code, stdout: stdout.toString('utf8') })
    })
  })
}

/** Stateful JSONL operation implementation behind the Server Manager transport. */
export class PreviewManager {
  private readonly routeById: ReadonlyMap<string, ManagedRoute>

  constructor(
    private readonly registry: PreviewManagerRegistry,
    private readonly store: PreviewManagerStateStore,
    args: PreviewManagerArguments,
    private readonly remote: PreviewManagerRemoteRunner = (command, timeoutMs) => runRemote(args, command, timeoutMs),
  ) {
    this.routeById = new Map(registry.routes.map(route => [route.id, route]))
  }

  async invoke(operation: string, envelopeValue: unknown): Promise<Readonly<Record<string, unknown>>> {
    const envelope = record(envelopeValue)
    const key = stringField(envelope.idempotency_key, BARE_DIGEST)
    const requestDigest = digest(envelope)
    const replay = await this.store.run(async (state) => {
      const existing = state.replay.find(entry => entry.operation === operation && entry.key === key)
      if (existing !== undefined) {
        if (existing.requestDigest !== requestDigest) throw new ManagerError('STATE_CONFLICT')
        if (existing.status === 'PENDING' || existing.result === undefined) throw new ManagerError('BUSY')
        return existing.result
      }
      state.replay.push({ operation, key, requestDigest, status: 'PENDING' })
      this.trimReplay(state)
      await this.store.persist()
      return undefined
    })
    if (replay !== undefined) return replay
    try {
      if (operation === 'acquire') return await this.acquire(envelope, key)
      if (operation === 'renew') return await this.renew(envelope, key)
      if (operation === 'release') return await this.release(envelope, key)
      if (operation === 'begin') return await this.begin(envelope, key)
      if (operation === 'cancel-clean') return await this.cancelClean(envelope, key)
      if (operation === 'stage') return await this.stage(envelope, key)
      throw new ManagerError('INVALID_REQUEST')
    } catch (error: unknown) {
      if (!(error instanceof ManagerError) || error.code !== 'UNKNOWN_COMMIT') {
        await this.store.run(async (state) => {
          state.replay = state.replay.filter(entry => !(entry.operation === operation && entry.key === key))
          await this.store.persist()
        })
      }
      throw error
    }
  }

  private async acquire(envelope: Record<string, unknown>, key: string): Promise<Readonly<Record<string, unknown>>> {
    const ttlMs = integerField(envelope.ttl_ms, 2)
    if (!Array.isArray(envelope.targets) || envelope.targets.length === 0) throw new ManagerError('INVALID_REQUEST')
    const requested = sortedTargets(envelope.targets.map((candidate) => {
      const target = record(candidate)
      return {
        class: targetClass(target.class),
        identity_digest: stringField(target.identity_digest, BARE_DIGEST),
        currentness_digest: stringField(target.currentness_digest, BARE_DIGEST),
      }
    }))
    const admitted = sortedTargets(this.registry.targets.filter(target => requested.some(entry => entry.class === target.class)))
    if (canonicalJson(requested) !== canonicalJson(admitted) || this.registry.renewAfterMs >= ttlMs) {
      throw new ManagerError('LEASE_MISMATCH')
    }
    return this.store.run(async (state) => {
      const unresolved = Object.values(state.transactions).some(transaction =>
        !transaction.terminal || transaction.inFlight !== undefined)
      if (state.lease !== undefined && (state.lease.quarantined || unresolved || state.lease.expiresAt > Date.now())) {
        throw new ManagerError('BUSY')
      }
      const leaseId = randomBytes(32).toString('hex')
      const hostLease = await this.acquireHostLease(leaseId, ttlMs)
      state.transactions = {}
      state.generation += 1
      state.nextFence = Math.max(state.nextFence, hostLease.fence + 1)
      const lease: LeaseState = {
        leaseId, fence: hostLease.fence, generation: state.generation,
        targets: requested.map(target => target.class), targetDescriptors: requested,
        expiresAt: hostLease.expiresAt, renewAfterMs: this.registry.renewAfterMs, quarantined: false,
      }
      state.lease = lease
      const result = this.leaseReceipt(lease, 'ACQUIRED')
      this.remember(state, 'acquire', key, result)
      await this.store.persist()
      return result
    })
  }

  private async renew(envelope: Record<string, unknown>, key: string): Promise<Readonly<Record<string, unknown>>> {
    const ttlMs = integerField(envelope.ttl_ms, 2)
    return this.store.run(async (state) => {
      const lease = this.boundLease(state, envelope)
      if (lease.quarantined || this.registry.renewAfterMs >= ttlMs) throw new ManagerError('LEASE_MISMATCH')
      lease.expiresAt = await this.renewHostLease(lease, ttlMs)
      const result = this.leaseReceipt(lease, 'RENEWED')
      this.remember(state, 'renew', key, result)
      await this.store.persist()
      return result
    })
  }

  private async release(envelope: Record<string, unknown>, key: string): Promise<Readonly<Record<string, unknown>>> {
    if (envelope.outcome !== 'SETTLED' && envelope.outcome !== 'UNCERTAIN') throw new ManagerError('INVALID_REQUEST')
    return this.store.run(async (state) => {
      const lease = this.boundLease(state, envelope, false)
      const unsettled = Object.values(state.transactions).some(transaction => !transaction.terminal || transaction.inFlight !== undefined)
      const requestedSettlement = envelope.outcome === 'SETTLED' && !unsettled && !lease.quarantined
      const settled = requestedSettlement && await this.releaseHostLease(lease)
      const result = this.leaseReceipt(lease, settled ? 'RELEASED' : 'QUARANTINED')
      if (settled) {
        delete state.lease
        state.transactions = {}
      } else lease.quarantined = true
      this.remember(state, 'release', key, result)
      await this.store.persist()
      return result
    })
  }

  private async begin(envelope: Record<string, unknown>, key: string): Promise<Readonly<Record<string, unknown>>> {
    const transactionDigest = stringField(envelope.transaction_digest, BARE_DIGEST)
    const scopeDigest = stringField(envelope.scope_digest, BARE_DIGEST)
    const kind = stringField(envelope.transaction_kind) as TransactionKind
    if (!['MODEL_ROUTE', 'IDLE_UNLOAD', 'SHUTDOWN'].includes(kind)) throw new ManagerError('INVALID_REQUEST')
    return this.store.run(async (state) => {
      const lease = this.boundLease(state, envelope)
      if (state.transactions[transactionDigest] !== undefined) throw new ManagerError('STATE_CONFLICT')
      if (Object.values(state.transactions).some(transaction => !transaction.terminal || transaction.inFlight !== undefined)) {
        throw new ManagerError('BUSY')
      }
      const transaction: TransactionState = {
        digest: transactionDigest, kind, scopeDigest,
        nextAllowed: kind === 'MODEL_ROUTE' ? ['preflight'] : ['prestate'],
        cleanCancelable: true, terminal: false, started: false, sequence: 1,
        allowedRoutes: kind === 'MODEL_ROUTE' ? { preflight: ['*'] } : { prestate: ['*'] },
        destinationPrestateCaptured: false, recovery: false,
      }
      state.transactions[transactionDigest] = transaction
      const result = this.transactionReceipt(lease, transaction, 'TRANSACTION_BEGUN')
      this.remember(state, 'begin', key, result)
      await this.store.persist()
      return result
    })
  }

  private async cancelClean(envelope: Record<string, unknown>, key: string): Promise<Readonly<Record<string, unknown>>> {
    return this.store.run(async (state) => {
      const lease = this.boundLease(state, envelope)
      const transaction = this.transaction(state, envelope)
      if (!transaction.cleanCancelable || transaction.inFlight !== undefined) throw new ManagerError('STATE_CONFLICT')
      transaction.terminal = true
      transaction.nextAllowed = []
      transaction.allowedRoutes = {}
      transaction.sequence += 1
      const result = this.transactionReceipt(lease, transaction, 'TRANSACTION_CANCELLED_CLEAN')
      this.remember(state, 'cancel-clean', key, result)
      await this.store.persist()
      return result
    })
  }

  private async stage(envelope: Record<string, unknown>, key: string): Promise<Readonly<Record<string, unknown>>> {
    const stage = stringField(envelope.stage) as Stage
    if (!STAGES.includes(stage)) throw new ManagerError('INVALID_REQUEST')
    const routeId = stringField(envelope.route_id, SAFE_TOKEN)
    const revision = stringField(envelope.exact_revision_digest, BARE_DIGEST)
    const target = record(envelope.target)
    const targetName = targetClass(target.class)
    const timeoutMs = integerField(envelope.timeout_ms, 1, 2_147_483_647)
    const route = this.routeById.get(routeId)
    if (route === undefined || route.revisionDigest !== revision || route.target !== targetName) throw new ManagerError('INVALID_REQUEST')
    const transactionDigest = stringField(envelope.transaction_digest, BARE_DIGEST)
    let hostLease: Pick<LeaseState, 'leaseId' | 'fence'> | undefined
    await this.store.run(async (state) => {
      const lease = this.boundLease(state, envelope)
      const covered = lease.targetDescriptors.find(descriptor => descriptor.class === targetName)
      if (covered === undefined || canonicalJson(target) !== canonicalJson(covered)) throw new ManagerError('LEASE_MISMATCH')
      const transaction = this.transaction(state, envelope)
      const probeAfterHealthyStart = stage === 'probe' && transaction.terminal && transaction.started
      if ((!transaction.nextAllowed.includes(stage) && !probeAfterHealthyStart) || transaction.inFlight !== undefined
        || lease.expiresAt <= Date.now() || !this.routeAllowed(transaction, stage, route)) {
        throw new ManagerError('STATE_CONFLICT')
      }
      hostLease = { leaseId: lease.leaseId, fence: lease.fence }
      transaction.inFlight = stage
      await this.store.persist()
    })

    let outcome: { status: 'PASS' | 'FAIL' | 'QUARANTINED'; decision: string; evidence: unknown }
    try {
      if (hostLease === undefined) throw new ManagerError('STATE_CONFLICT')
      outcome = await this.executeStage(stage, route, timeoutMs, hostLease)
    }
    catch (error: unknown) {
      outcome = {
        status: error instanceof ManagerError && error.code === 'UNKNOWN_COMMIT' ? 'QUARANTINED' : 'FAIL',
        decision: 'FAILED', evidence: { stage, error: error instanceof ManagerError ? error.code : 'REMOTE_FAILURE' },
      }
    }

    return this.store.run(async (state) => {
      const lease = this.boundLease(state, envelope, false)
      const transaction = state.transactions[transactionDigest]
      if (transaction === undefined || transaction.inFlight !== stage || lease.expiresAt <= Date.now() || lease.quarantined) {
        if (transaction !== undefined) delete transaction.inFlight
        lease.quarantined = true
        await this.store.persist()
        throw new ManagerError('UNKNOWN_COMMIT')
      }
      delete transaction.inFlight
      transaction.sequence += 1
      transaction.cleanCancelable = stage === 'preflight' && outcome.status === 'PASS' && outcome.decision === 'UNAVAILABLE'
      transaction.nextAllowed = this.advanceTransaction(stage, route, outcome, transaction)
      transaction.terminal = transaction.nextAllowed.length === 0
      const result = this.stageReceipt(lease, transaction, route, stage, outcome)
      this.remember(state, 'stage', key, result)
      if (outcome.status === 'QUARANTINED') lease.quarantined = true
      await this.store.persist()
      return result
    })
  }

  private async executeStage(
    stage: Stage,
    route: ManagedRoute,
    timeoutMs: number,
    lease: Pick<LeaseState, 'leaseId' | 'fence'>,
  ): Promise<{ status: 'PASS' | 'FAIL' | 'QUARANTINED'; decision: string; evidence: unknown }> {
    const budget = new StageBudget(timeoutMs)
    await this.assertHostLease(lease, budget)
    if (stage === 'preflight') {
      const available = await this.capacity(route, budget)
      return { status: 'PASS', decision: available ? 'AVAILABLE' : 'UNAVAILABLE', evidence: { available } }
    }
    if (stage === 'prestate') {
      const resident = await this.residency(route.target, budget)
      if (resident.kind === 'resident') return {
        status: 'PASS', decision: 'RESIDENT',
        evidence: resident,
      }
      return { status: 'PASS', decision: resident.kind === 'empty' ? 'EMPTY' : 'UNKNOWN', evidence: resident }
    }
    if (stage === 'drain') {
      if (!route.exclusiveEndpoint) return { status: 'FAIL', decision: 'FAILED', evidence: { exclusive: false } }
      const drain = await this.waitDrained(route, budget)
      return {
        status: drain.drained ? 'PASS' : 'FAIL',
        decision: drain.drained ? 'DRAINED' : 'FAILED',
        evidence: { exclusive: true, samples: drain.samples },
      }
    }
    if (stage === 'stop') {
      const before = await this.residency(route.target, budget)
      if (before.kind === 'unknown' || (before.kind === 'resident' && before.route.id !== route.id)) {
        return { status: 'FAIL', decision: 'FAILED', evidence: before }
      }
      if (before.kind === 'resident') {
        const command = route.runtime.kind === 'docker'
          ? dockerMutationCommand(route.runtime, 'stop')
          : route.runtime.kind === 'systemd'
            ? systemdMutationCommand(route.runtime, 'stop')
            : scriptMutationCommand(route.runtime, 'stop')
        const stopped = await this.runFencedMutation(lease, command, budget)
        if (stopped.code !== 0) throw new ManagerError('UNKNOWN_COMMIT')
        if (route.runtime.kind === 'systemd' && !/(?:^|\n)GCP_SYSTEMD_MUTATION_APPLIED\s*$/u.test(stopped.stdout)) {
          throw new ManagerError('UNKNOWN_COMMIT')
        }
        if (route.runtime.kind === 'docker' && !/(?:^|\n)GCP_DOCKER_MUTATION_APPLIED\s*$/u.test(stopped.stdout)) {
          throw new ManagerError('UNKNOWN_COMMIT')
        }
        if (route.runtime.kind === 'script' && !/(?:^|\n)GCP_SCRIPT_MUTATION_APPLIED\s*$/u.test(stopped.stdout)) {
          throw new ManagerError('UNKNOWN_COMMIT')
        }
      }
      return { status: 'PASS', decision: 'STOPPED', evidence: { previous: before.kind } }
    }
    if (stage === 'verify-stopped') {
      const release = await this.waitReleased(route, budget)
      return {
        status: release.released ? 'PASS' : 'QUARANTINED',
        decision: release.released ? 'VERIFIED_STOPPED' : 'FAILED',
        evidence: { samples: release.samples },
      }
    }
    if (stage === 'start') {
      const before = await this.residency(route.target, budget)
      if (before.kind === 'unknown' || (before.kind === 'resident' && before.route.id !== route.id)) {
        return { status: 'FAIL', decision: 'FAILED', evidence: before }
      }
      if (before.kind === 'empty') {
        if (!await this.capacity(route, budget)) {
          return { status: 'FAIL', decision: 'FAILED', evidence: { available: false } }
        }
        const command = route.runtime.kind === 'docker'
          ? dockerMutationCommand(route.runtime, 'start')
          : route.runtime.kind === 'systemd'
            ? systemdMutationCommand(route.runtime, 'start')
            : scriptMutationCommand(route.runtime, 'start')
        const started = await this.runFencedMutation(lease, command, budget)
        if (started.code !== 0) throw new ManagerError('UNKNOWN_COMMIT')
        if (route.runtime.kind === 'systemd' && !/(?:^|\n)GCP_SYSTEMD_MUTATION_APPLIED\s*$/u.test(started.stdout)) {
          throw new ManagerError('UNKNOWN_COMMIT')
        }
        if (route.runtime.kind === 'docker' && !/(?:^|\n)GCP_DOCKER_MUTATION_APPLIED\s*$/u.test(started.stdout)) {
          throw new ManagerError('UNKNOWN_COMMIT')
        }
        if (route.runtime.kind === 'script' && !/(?:^|\n)GCP_SCRIPT_MUTATION_APPLIED\s*$/u.test(started.stdout)) {
          throw new ManagerError('UNKNOWN_COMMIT')
        }
        if (!await this.waitHealthy(route, budget)) return { status: 'FAIL', decision: 'FAILED', evidence: { ready: false } }
      }
      return { status: 'PASS', decision: 'STARTED', evidence: { previous: before.kind } }
    }
    if (stage === 'health') {
      const healthy = await this.routeHealthy(route, budget)
      return { status: healthy ? 'PASS' : 'FAIL', decision: healthy ? 'HEALTHY' : 'UNHEALTHY', evidence: { healthy } }
    }
    const healthy = await this.routeProbe(route, budget)
    return { status: healthy ? 'PASS' : 'FAIL', decision: healthy ? 'HEALTHY' : 'UNHEALTHY', evidence: { healthy } }
  }

  private async acquireHostLease(leaseId: string, ttlMs: number): Promise<{ readonly fence: number; readonly expiresAt: number }> {
    const slot = this.registry.slot
    const command = [
      'set -euo pipefail',
      `state_lock=${shellQuote(slot.lockPath)}`,
      `operation_lock=${shellQuote(slot.operationLockPath)}`,
      `state_file=${shellQuote(slot.statePath)}`,
      `counter_file=${shellQuote(slot.counterPath)}`,
      `requested_lease=${shellQuote(leaseId)}`,
      `ttl_ms=${ttlMs}`,
      'install -d -m 700 "$(dirname "$state_lock")" "$(dirname "$state_file")" "$(dirname "$counter_file")"',
      'exec 8>"$operation_lock"',
      "flock -n 8 || { printf 'BUSY\\n'; exit 75; }",
      'exec 9>"$state_lock"',
      "flock -w 5 9 || { printf 'BUSY\\n'; exit 75; }",
      'now=$(date +%s%3N)',
      'old_fence=0; old_lease=none; old_expires=0; recovered=0',
      'if [ -e "$state_file" ]; then [ -r "$state_file" ] || exit 76; read -r old_fence old_lease old_expires extra < "$state_file" || exit 76; [ -z "${extra:-}" ] || exit 76; [[ "$old_fence" =~ ^[0-9]+$ && "$old_lease" =~ ^[a-f0-9]{64}$ && "$old_expires" =~ ^[0-9]+$ ]] || exit 76; if [ "$old_expires" -gt "$now" ]; then printf \'BUSY\\n\'; exit 75; fi; recovered=1; fi',
      'counter=0; if [ -e "$counter_file" ]; then [ -r "$counter_file" ] || exit 76; read -r counter extra < "$counter_file" || exit 76; [ -z "${extra:-}" ] || exit 76; [[ "$counter" =~ ^[0-9]+$ ]] || exit 76; fi',
      'next=$((counter + 1)); if [ "$next" -le "$old_fence" ]; then next=$((old_fence + 1)); fi',
      'expires=$((now + ttl_ms))',
      'umask 077; tmp_counter="${counter_file}.$$.$RANDOM.tmp"; tmp_state="${state_file}.$$.$RANDOM.tmp"',
      'trap \'rm -f "$tmp_counter" "$tmp_state"\' EXIT',
      'printf \'%s\\n\' "$next" > "$tmp_counter"; mv -f "$tmp_counter" "$counter_file"',
      'printf \'%s %s %s\\n\' "$next" "$requested_lease" "$expires" > "$tmp_state"; mv -f "$tmp_state" "$state_file"',
      'printf \'ACQUIRED %s %s %s\\n\' "$next" "$expires" "$recovered"',
    ].join('; ')
    const result = await this.remote(command, 15_000)
    if (result.code === 75) throw new ManagerError('BUSY')
    if (result.code !== 0) throw new ManagerError('REMOTE_FAILURE')
    const match = /^ACQUIRED (\d+) (\d+) [01]\s*$/u.exec(result.stdout)
    if (match === null) throw new ManagerError('REMOTE_FAILURE')
    return { fence: integerField(Number(match[1]), 1), expiresAt: integerField(Number(match[2]), 1) }
  }

  private async renewHostLease(lease: LeaseState, ttlMs: number): Promise<number> {
    const slot = this.registry.slot
    const command = [
      'set -euo pipefail',
      `state_lock=${shellQuote(slot.lockPath)}`,
      `state_file=${shellQuote(slot.statePath)}`,
      `expected_lease=${shellQuote(lease.leaseId)}`,
      `expected_fence=${lease.fence}`,
      `ttl_ms=${ttlMs}`,
      'exec 9>"$state_lock"; flock -w 5 9 || exit 75',
      'read -r current_fence current_lease current_expires extra < "$state_file" || exit 76',
      '[ -z "${extra:-}" ] || exit 76',
      '[[ "$current_fence" =~ ^[0-9]+$ && "$current_lease" =~ ^[a-f0-9]{64}$ && "$current_expires" =~ ^[0-9]+$ ]] || exit 76',
      '[ "$current_fence" = "$expected_fence" ] && [ "$current_lease" = "$expected_lease" ] || exit 76',
      'now=$(date +%s%3N); [ "$current_expires" -gt "$now" ] || exit 76; expires=$((now + ttl_ms))',
      'umask 077; tmp_state="${state_file}.$$.$RANDOM.tmp"; trap \'rm -f "$tmp_state"\' EXIT',
      'printf \'%s %s %s\\n\' "$current_fence" "$current_lease" "$expires" > "$tmp_state"; mv -f "$tmp_state" "$state_file"',
      'printf \'RENEWED %s\\n\' "$expires"',
    ].join('; ')
    const result = await this.remote(command, 15_000)
    if (result.code !== 0) throw new ManagerError('LEASE_MISMATCH')
    const match = /^RENEWED (\d+)\s*$/u.exec(result.stdout)
    if (match === null) throw new ManagerError('LEASE_MISMATCH')
    return integerField(Number(match[1]), 1)
  }

  private async releaseHostLease(lease: LeaseState): Promise<boolean> {
    const slot = this.registry.slot
    const command = [
      'set -euo pipefail',
      `state_lock=${shellQuote(slot.lockPath)}`,
      `operation_lock=${shellQuote(slot.operationLockPath)}`,
      `state_file=${shellQuote(slot.statePath)}`,
      `expected_lease=${shellQuote(lease.leaseId)}`,
      `expected_fence=${lease.fence}`,
      'exec 8>"$operation_lock"; flock -n 8 || exit 75',
      'exec 9>"$state_lock"; flock -w 5 9 || exit 75',
      'read -r current_fence current_lease current_expires extra < "$state_file" || exit 76',
      '[ -z "${extra:-}" ] || exit 76',
      '[ "$current_fence" = "$expected_fence" ] && [ "$current_lease" = "$expected_lease" ] || exit 76',
      'rm -f "$state_file"',
      "printf 'RELEASED\\n'",
    ].join('; ')
    const result = await this.remote(command, 15_000)
    return result.code === 0 && /^RELEASED\s*$/u.test(result.stdout)
  }

  private async assertHostLease(lease: Pick<LeaseState, 'leaseId' | 'fence'>, budget: StageBudget): Promise<void> {
    const slot = this.registry.slot
    const command = [
      'set -euo pipefail',
      `state_lock=${shellQuote(slot.lockPath)}`,
      `state_file=${shellQuote(slot.statePath)}`,
      `expected_lease=${shellQuote(lease.leaseId)}`,
      `expected_fence=${lease.fence}`,
      'exec 9>"$state_lock"; flock -w 5 9 || exit 75',
      'read -r current_fence current_lease current_expires extra < "$state_file" || exit 76',
      '[ -z "${extra:-}" ] || exit 76',
      '[ "$current_fence" = "$expected_fence" ] && [ "$current_lease" = "$expected_lease" ] || exit 76',
      'now=$(date +%s%3N); [ "$current_expires" -gt "$now" ] || exit 76',
      "printf 'CURRENT\\n'",
    ].join('; ')
    const result = await this.remote(command, budget.remaining(15_000))
    if (result.code !== 0 || !/^CURRENT\s*$/u.test(result.stdout)) throw new ManagerError('UNKNOWN_COMMIT')
  }

  private async runFencedMutation(
    lease: Pick<LeaseState, 'leaseId' | 'fence'>,
    command: string,
    budget: StageBudget,
  ): Promise<PreviewManagerRemoteResult> {
    const slot = this.registry.slot
    const fenced = [
      'set -euo pipefail',
      `state_lock=${shellQuote(slot.lockPath)}`,
      `operation_lock=${shellQuote(slot.operationLockPath)}`,
      `state_file=${shellQuote(slot.statePath)}`,
      `expected_lease=${shellQuote(lease.leaseId)}`,
      `expected_fence=${lease.fence}`,
      'exec 8>"$operation_lock"; flock -w 5 8 || exit 75',
      'exec 9>"$state_lock"; flock -w 5 9 || exit 75',
      'read -r current_fence current_lease current_expires extra < "$state_file" || exit 76',
      '[ -z "${extra:-}" ] || exit 76',
      '[ "$current_fence" = "$expected_fence" ] && [ "$current_lease" = "$expected_lease" ] || exit 76',
      'now=$(date +%s%3N); [ "$current_expires" -gt "$now" ] || exit 76',
      'flock -u 9',
      `set +e; ${command}; command_code=$?; set -e`,
      '[ "$command_code" -eq 0 ] || exit "$command_code"',
      'flock -w 5 9 || exit 75',
      'read -r current_fence current_lease current_expires extra < "$state_file" || exit 76',
      '[ -z "${extra:-}" ] || exit 76',
      '[ "$current_fence" = "$expected_fence" ] && [ "$current_lease" = "$expected_lease" ] || exit 76',
      'now=$(date +%s%3N); [ "$current_expires" -gt "$now" ] || exit 76',
    ].join('; ')
    return this.remote(fenced, budget.remaining())
  }

  private async capacity(route: ManagedRoute, budget: StageBudget): Promise<boolean> {
    if (route.target !== 'r5300') return false
    const resident = await this.residency(route.target, budget)
    if (resident.kind === 'unknown') return false
    if (resident.kind === 'resident' && resident.route.id === route.id) return true
    const current = resident.kind === 'resident' ? resident : undefined
    const telemetry = await this.remote(
      "awk '/MemAvailable:/{print \"MEM \" $2}' /proc/meminfo; printf 'GPUS\\n'; "
        + "nvidia-smi --query-gpu=index,uuid,memory.free --format=csv,noheader,nounits; printf 'APPS\\n'; "
        + 'nvidia-smi --query-compute-apps=pid,gpu_uuid,used_gpu_memory --format=csv,noheader,nounits',
      budget.remaining(),
    )
    if (telemetry.code !== 0) return false
    const lines = telemetry.stdout.trim().split(/\r?\n/u)
    const memory = /^MEM\s+(\d+)$/u.exec(lines.shift() ?? '')
    if (memory === null) return false
    const memoryKiB = Number(memory[1])
    if (!Number.isSafeInteger(memoryKiB)) return false
    if (lines.shift() !== 'GPUS') return false

    const applicationMarker = lines.indexOf('APPS')
    if (applicationMarker < 1) return false
    const gpuLines = lines.slice(0, applicationMarker)
    const applicationLines = lines.slice(applicationMarker + 1).filter(line => line.length > 0)
    const gpu = new Map<number, { readonly uuid: string; readonly freeMiB: number }>()
    const gpuByUuid = new Map<string, number>()
    for (const line of gpuLines) {
      const match = /^\s*(\d+)\s*,\s*(GPU-[A-Fa-f0-9-]+)\s*,\s*(\d+)\s*$/u.exec(line)
      if (match === null) return false
      const index = Number(match[1])
      const uuid = match[2]
      const freeMiB = Number(match[3])
      if (uuid === undefined) return false
      if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(freeMiB) || freeMiB < 0
        || gpu.has(index) || gpuByUuid.has(uuid)) return false
      gpu.set(index, { uuid, freeMiB })
      gpuByUuid.set(uuid, index)
    }

    const applications: Array<{ readonly pid: number; readonly gpuIndex: number; readonly usedMiB: number }> = []
    for (const line of applicationLines) {
      const match = /^\s*(\d+)\s*,\s*(GPU-[A-Fa-f0-9-]+)\s*,\s*(\d+)\s*$/u.exec(line)
      if (match === null) return false
      const pid = Number(match[1])
      const uuid = match[2]
      if (uuid === undefined) return false
      const gpuIndex = gpuByUuid.get(uuid)
      const usedMiB = Number(match[3])
      if (!Number.isSafeInteger(pid) || pid < 1 || gpuIndex === undefined
        || !Number.isSafeInteger(usedMiB) || usedMiB < 0) return false
      applications.push({ pid, gpuIndex, usedMiB })
    }

    const processResult = await this.remote('ps -eo pid=,pgid=,rss=', budget.remaining())
    if (processResult.code !== 0) return false
    const processes = new Map<number, { readonly group: number; readonly rssKiB: number }>()
    for (const line of processResult.stdout.trim().split(/\r?\n/u)) {
      if (line.length === 0) continue
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(line)
      if (match === null) return false
      const pid = Number(match[1])
      const group = Number(match[2])
      const rssKiB = Number(match[3])
      if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(group) || group < 1
        || !Number.isSafeInteger(rssKiB) || rssKiB < 0 || processes.has(pid)) return false
      processes.set(pid, { group, rssKiB })
    }
    if (applications.some(application => !processes.has(application.pid))) return false

    const currentGroups = new Set(current?.processGroups ?? [])
    const measuredRamMiB = Math.floor([...processes.values()]
      .filter(process => currentGroups.has(process.group))
      .reduce((total, process) => total + process.rssKiB, 0) / 1024)
    const reclaimableRamMiB = current === undefined
      ? 0
      : Math.min(measuredRamMiB, current.route.resources.reclaimableRamMiB)
    const availableRamMiB = Math.floor(memoryKiB / 1024) + reclaimableRamMiB
    if (availableRamMiB < route.resources.minimumFreeRamMiB) return false

    return route.resources.gpuIndices.every((index) => {
      const gpuState = gpu.get(index)
      if (gpuState === undefined) return false
      const measuredVramMiB = applications
        .filter((application) => {
          const process = processes.get(application.pid)
          return application.gpuIndex === index && process !== undefined && currentGroups.has(process.group)
        })
        .reduce((total, application) => total + application.usedMiB, 0)
      const configuredCeiling = current?.route.resources.reclaimableVramMiB[String(index)] ?? 0
      const minimumFreeVramMiB = route.resources.minimumFreeVramMiB[String(index)]
      if (minimumFreeVramMiB === undefined) return false
      return gpuState.freeMiB + Math.min(measuredVramMiB, configuredCeiling)
        >= minimumFreeVramMiB
    })
  }

  private async residency(target: TargetClass, budget: StageBudget): Promise<Residency> {
    const found: Array<{ route: ManagedRoute; processGroups: readonly number[] }> = []
    let unresolved = false
    for (const route of this.registry.routes.filter(candidate => candidate.target === target)) {
      const presence = await this.processPresence(route, budget)
      if (presence.kind === 'unknown') unresolved = true
      else if (presence.kind === 'running') found.push({ route, processGroups: presence.processGroups })
    }
    if (found.length > 1 || (found.length === 0 && unresolved)) return { kind: 'unknown' }
    if (found.length === 0) return { kind: 'empty' }
    const resident = found[0]
    if (resident === undefined) return { kind: 'unknown' }
    return { kind: 'resident', route: resident.route, processGroups: resident.processGroups }
  }

  private async processPresence(route: ManagedRoute, budget: StageBudget): Promise<ProcessPresence> {
    if (route.runtime.kind === 'docker') {
      const result = await this.remote(
        `docker inspect --format '{{.Id}} {{.Image}} {{.Name}} {{json .State}}' ${shellQuote(route.runtime.container ?? '')}`,
        budget.remaining(10_000),
      )
      if (result.code !== 0) return { kind: 'unknown' }
      try {
        const identity = /^([a-f0-9]{64}) (sha256:[a-f0-9]{64}) (\/[A-Za-z0-9._/:+-]+) (\{.*\})\s*$/u.exec(result.stdout)
        if (identity === null || identity[1] !== route.runtime.containerId
          || identity[2] !== route.runtime.imageId || identity[3] !== `/${route.runtime.container}`) {
          return { kind: 'unknown' }
        }
        const stateJson = identity[4]
        if (stateJson === undefined) return { kind: 'unknown' }
        const state = record(JSON.parse(stateJson) as unknown)
        if (state.Running === false && state.Restarting === false && state.Paused === false) return { kind: 'stopped' }
        if (state.Running !== true || state.Restarting === true || state.Paused === true) return { kind: 'unknown' }
        const pid = integerField(state.Pid, 1)
        const group = await this.remote(`ps -o pgid= -p ${pid}`, budget.remaining(10_000))
        if (group.code !== 0 || !/^\s*\d+\s*$/u.test(group.stdout)) return { kind: 'unknown' }
        return { kind: 'running', processGroups: [Number(group.stdout.trim())] }
      } catch { return { kind: 'unknown' } }
    }

    if (route.runtime.kind === 'systemd') {
      const result = await this.remote(systemdPresenceCommand(route.runtime), budget.remaining(15_000))
      if (result.code !== 0) return { kind: 'unknown' }
      if (/^SYSTEMD STOPPED\s*$/u.test(result.stdout)) return { kind: 'stopped' }
      const running = /^SYSTEMD RUNNING ((?:[1-9][0-9]*)(?: [1-9][0-9]*)*)\s*$/u.exec(result.stdout)
      if (running === null) return { kind: 'unknown' }
      const groupList = running[1]
      if (groupList === undefined) return { kind: 'unknown' }
      const groups = groupList.split(' ').map(Number)
      return new Set(groups).size === groups.length
        ? { kind: 'running', processGroups: groups }
        : { kind: 'unknown' }
    }

    const pidFile = shellQuote(route.runtime.pidFile ?? '')
    const marker = shellQuote(route.runtime.processMarker ?? '')
    const command = `pid_file=${pidFile}; marker=${marker}; `
      + "if [ ! -e \"$pid_file\" ]; then printf 'PIDFILE MISSING\\n'; elif [ ! -r \"$pid_file\" ]; then printf 'PIDFILE UNREADABLE\\n'; else read -r tracked < \"$pid_file\" || tracked=; case \"$tracked\" in ''|*[!0-9]*) printf 'PIDFILE INVALID\\n' ;; *) if [ -r \"/proc/$tracked/cmdline\" ]; then if tr '\\000' '\\n' < \"/proc/$tracked/cmdline\" | grep -Fqx -- \"$marker\"; then group=$(ps -o pgid= -p \"$tracked\" | tr -d ' '); printf 'PIDFILE MATCH %s %s\\n' \"$tracked\" \"$group\"; else printf 'PIDFILE MISMATCH %s\\n' \"$tracked\"; fi; elif [ -e \"/proc/$tracked\" ]; then printf 'PIDFILE UNREADABLE\\n'; else printf 'PIDFILE DEAD\\n'; fi ;; esac; fi; for cmdline in /proc/[0-9]*/cmdline; do [ -r \"$cmdline\" ] || continue; if tr '\\000' '\\n' < \"$cmdline\" | grep -Fqx -- \"$marker\"; then pid=${cmdline#/proc/}; pid=${pid%/cmdline}; group=$(ps -o pgid= -p \"$pid\" | tr -d ' '); printf 'MATCH %s %s\\n' \"$pid\" \"$group\"; fi; done"
    const result = await this.remote(command, budget.remaining(15_000))
    if (result.code !== 0) return { kind: 'unknown' }
    const lines = result.stdout.trim().split(/\r?\n/u)
    const pidState = /^PIDFILE (MISSING|DEAD|INVALID|UNREADABLE|MISMATCH \d+|MATCH \d+ \d+)$/u.exec(lines[0] ?? '')
    if (pidState === null) return { kind: 'unknown' }
    const groups = new Set<number>()
    for (const line of lines) {
      const match = /^(?:PIDFILE )?MATCH \d+ (\d+)$/u.exec(line)
      if (match !== null) groups.add(Number(match[1]))
      else if (!line.startsWith('PIDFILE ')) return { kind: 'unknown' }
    }
    if (groups.size > 0) return { kind: 'running', processGroups: [...groups] }
    return pidState[1] === 'MISSING' || pidState[1] === 'DEAD' ? { kind: 'stopped' } : { kind: 'unknown' }
  }

  private async routeHealthy(route: ManagedRoute, budget: StageBudget): Promise<boolean> {
    const before = await this.processPresence(route, budget)
    if (before.kind !== 'running') return false
    const result = await this.remote(
      `curl -fsS --max-time 5 http://127.0.0.1:${route.runtime.remotePort}/v1/models`, budget.remaining(10_000))
    if (result.code !== 0) return false
    try {
      const payload = record(JSON.parse(result.stdout) as unknown)
      if (!Array.isArray(payload.data) || !payload.data.some(entry => record(entry).id === route.runtime.expectedModel)) {
        return false
      }
      return (await this.processPresence(route, budget)).kind === 'running'
    } catch { return false }
  }

  private async routeProbe(route: ManagedRoute, budget: StageBudget): Promise<boolean> {
    if ((await this.processPresence(route, budget)).kind !== 'running') return false
    const body = JSON.stringify({ model: route.runtime.expectedModel, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 4, stream: false })
    const command = `curl -fsS --max-time 45 -H 'Content-Type: application/json' --data-binary ${shellQuote(body)} http://127.0.0.1:${route.runtime.remotePort}/v1/chat/completions`
    const result = await this.remote(command, budget.remaining(55_000))
    if (result.code !== 0) return false
    try {
      const payload = record(JSON.parse(result.stdout) as unknown)
      return Array.isArray(payload.choices) && payload.choices.length > 0
        && (await this.processPresence(route, budget)).kind === 'running'
    } catch { return false }
  }

  private async waitDrained(
    route: ManagedRoute,
    budget: StageBudget,
  ): Promise<{ readonly drained: boolean; readonly samples: readonly number[] }> {
    const samples: number[] = []
    let consecutiveZero = 0
    while (consecutiveZero < 3) {
      const active = await this.activeRequestCount(route, budget)
      if (active === undefined) return { drained: false, samples }
      samples.push(active)
      consecutiveZero = active === 0 ? consecutiveZero + 1 : 0
      if (consecutiveZero === 3) break
      const remaining = budget.remaining()
      await new Promise(resolve => setTimeout(resolve, Math.min(route.runtime.drain.pollIntervalMs, remaining)))
    }
    return { drained: true, samples }
  }

  private async waitReleased(
    route: ManagedRoute,
    budget: StageBudget,
  ): Promise<{
    readonly released: boolean
    readonly samples: readonly { readonly residency: Residency['kind']; readonly listener: 'closed' | 'listening' | 'unknown' }[]
  }> {
    const samples: Array<{ residency: Residency['kind']; listener: 'closed' | 'listening' | 'unknown' }> = []
    let consecutiveReleased = 0
    for (let index = 0; index < route.runtime.release.maximumSamples; index += 1) {
      const residency = await this.residency(route.target, budget)
      const listener = await this.listenerState(route, budget)
      samples.push({ residency: residency.kind, listener })
      if (residency.kind === 'unknown' || listener === 'unknown') return { released: false, samples }
      consecutiveReleased = residency.kind === 'empty' && listener === 'closed' ? consecutiveReleased + 1 : 0
      if (consecutiveReleased === 3) return { released: true, samples }
      if (index + 1 < route.runtime.release.maximumSamples) {
        const remaining = budget.remaining()
        await new Promise(resolve => setTimeout(resolve, Math.min(route.runtime.release.pollIntervalMs, remaining)))
      }
    }
    return { released: false, samples }
  }

  private async listenerState(
    route: ManagedRoute,
    budget: StageBudget,
  ): Promise<'closed' | 'listening' | 'unknown'> {
    const filter = shellQuote(`sport = :${route.runtime.remotePort}`)
    const command = 'command -v ss >/dev/null 2>&1 || exit 127; if [ -n "$(ss -H -ltn '
      + filter
      + " 2>/dev/null)\" ]; then printf 'LISTENING\\n'; else printf 'CLOSED\\n'; fi"
    const result = await this.remote(command, budget.remaining(10_000))
    if (result.code !== 0) return 'unknown'
    if (/^CLOSED\s*$/u.test(result.stdout)) return 'closed'
    if (/^LISTENING\s*$/u.test(result.stdout)) return 'listening'
    return 'unknown'
  }

  private async activeRequestCount(route: ManagedRoute, budget: StageBudget): Promise<number | undefined> {
    const result = await this.remote(
      `curl -fsS --max-time 5 http://127.0.0.1:${route.runtime.remotePort}${route.runtime.drain.path}`,
      budget.remaining(10_000),
    )
    if (result.code !== 0) return undefined
    if (route.runtime.drain.kind === 'sglang-load') {
      try {
        const payload = JSON.parse(result.stdout) as unknown
        if (!Array.isArray(payload) || payload.length === 0) return undefined
        return payload.reduce((total, value) => {
          const entry = record(value)
          return total + integerField(entry.num_reqs, 0) + integerField(entry.num_waiting_reqs, 0)
        }, 0)
      } catch { return undefined }
    }

    let running: number | undefined
    let waiting: number | undefined
    let swapped = 0
    for (const line of result.stdout.split(/\r?\n/u)) {
      const match = /^vllm:num_requests_(running|waiting|swapped)(?:\{[^}]*\})?\s+([0-9]+(?:\.[0-9]+)?)\s*$/u.exec(line)
      if (match === null) continue
      const value = Number(match[2])
      if (!Number.isSafeInteger(value) || value < 0) return undefined
      if (match[1] === 'running') running = (running ?? 0) + value
      else if (match[1] === 'waiting') waiting = (waiting ?? 0) + value
      else swapped += value
    }
    return running === undefined || waiting === undefined ? undefined : running + waiting + swapped
  }

  private async waitHealthy(route: ManagedRoute, budget: StageBudget): Promise<boolean> {
    while (true) {
      if (await this.routeHealthy(route, budget)) return true
      const remaining = budget.remaining()
      await new Promise(resolve => setTimeout(resolve, Math.min(2_000, remaining)))
    }
  }

  private routeAllowed(transaction: TransactionState, stage: Stage, route: ManagedRoute): boolean {
    const allowed = transaction.allowedRoutes[stage]
    if (allowed === undefined || (!allowed.includes('*') && !allowed.includes(route.id))) return false
    if (stage === 'prestate' && transaction.destinationPrestateCaptured
      && transaction.destinationRouteId !== undefined) {
      const destination = this.routeById.get(transaction.destinationRouteId)
      if (destination === undefined || route.id === destination.id || route.target === destination.target) return false
    }
    return true
  }

  private setAllowed(transaction: TransactionState, entries: Readonly<Partial<Record<Stage, readonly string[]>>>): Stage[] {
    transaction.allowedRoutes = Object.fromEntries(Object.entries(entries)
      .map(([stage, routes]) => [stage, [...(routes ?? [])]])) as Partial<Record<Stage, string[]>>
    return STAGES.filter(stage => (transaction.allowedRoutes[stage]?.length ?? 0) > 0)
  }

  private advanceTransaction(
    stage: Stage,
    route: ManagedRoute,
    outcome: { status: string; decision: string; evidence: unknown },
    transaction: TransactionState,
  ): Stage[] {
    if (outcome.status === 'QUARANTINED') return this.setAllowed(transaction, {})
    if (outcome.status !== 'PASS') {
      if (stage === 'start' || stage === 'health' || stage === 'probe') {
        if ((stage === 'health' || stage === 'probe') && transaction.adoptedResidentRouteId === route.id) {
          return this.setAllowed(transaction, {})
        }
        if (route.id === transaction.destinationRouteId) transaction.recovery = true
        return this.setAllowed(transaction, { stop: [route.id] })
      }
      if (stage === 'stop') return this.setAllowed(transaction, { 'verify-stopped': [route.id] })
      return this.setAllowed(transaction, {})
    }

    if (stage === 'preflight') {
      if (outcome.decision !== 'AVAILABLE') return this.setAllowed(transaction, { preflight: [route.id] })
      transaction.destinationRouteId = route.id
      transaction.destinationPrestateCaptured = false
      transaction.recovery = false
      delete transaction.sourceRouteId
      delete transaction.startedRouteId
      delete transaction.adoptedResidentRouteId
      delete transaction.lastStoppedRouteId
      return this.setAllowed(transaction, { prestate: [route.id] })
    }

    if (stage === 'prestate') {
      const residency = outcome.evidence as Residency
      if (transaction.kind !== 'MODEL_ROUTE') {
        if (residency.kind !== 'resident' || residency.route.id !== route.id) return this.setAllowed(transaction, {})
        transaction.sourceRouteId = route.id
        return this.setAllowed(transaction, { stop: [route.id] })
      }

      if (!transaction.destinationPrestateCaptured) {
        transaction.destinationPrestateCaptured = true
        if (route.id !== transaction.destinationRouteId) return this.setAllowed(transaction, {})
        if (residency.kind === 'resident') {
          transaction.sourceRouteId = residency.route.id
          if (residency.route.id === transaction.destinationRouteId) {
            transaction.adoptedResidentRouteId = route.id
          }
          return residency.route.id === transaction.destinationRouteId
            ? this.setAllowed(transaction, { health: [route.id] })
            : this.setAllowed(transaction, { drain: [residency.route.id] })
        }
        return residency.kind === 'empty' && transaction.destinationRouteId !== undefined
          ? this.setAllowed(transaction, { prestate: ['*'], start: [transaction.destinationRouteId] })
          : this.setAllowed(transaction, {})
      }

      if (residency.kind !== 'resident' || residency.route.id !== route.id) return this.setAllowed(transaction, {})
      transaction.sourceRouteId = route.id
      return this.setAllowed(transaction, { drain: [route.id] })
    }

    if (stage === 'drain') return this.setAllowed(transaction, { stop: [route.id] })
    if (stage === 'stop') {
      transaction.lastStoppedRouteId = route.id
      return this.setAllowed(transaction, { 'verify-stopped': [route.id] })
    }
    if (stage === 'verify-stopped') {
      if (transaction.lastStoppedRouteId !== route.id || transaction.kind !== 'MODEL_ROUTE') {
        return this.setAllowed(transaction, {})
      }
      if (transaction.recovery) {
        return transaction.sourceRouteId !== undefined && transaction.sourceRouteId !== transaction.destinationRouteId
          ? this.setAllowed(transaction, { start: [transaction.sourceRouteId] })
          : this.setAllowed(transaction, {})
      }
      return transaction.destinationRouteId !== undefined && transaction.sourceRouteId === route.id
        ? this.setAllowed(transaction, { start: [transaction.destinationRouteId] })
        : this.setAllowed(transaction, {})
    }
    if (stage === 'start') {
      transaction.started = true
      transaction.startedRouteId = route.id
      delete transaction.adoptedResidentRouteId
      return this.setAllowed(transaction, { health: [route.id] })
    }
    if (stage === 'health') {
      return transaction.startedRouteId === route.id || transaction.adoptedResidentRouteId === route.id
        ? this.setAllowed(transaction, { probe: [route.id] })
        : this.setAllowed(transaction, {})
    }
    return this.setAllowed(transaction, {})
  }

  private boundLease(state: ManagerState, envelope: Record<string, unknown>, requireCurrent = true): LeaseState {
    const lease = state.lease
    if (lease === undefined || lease.leaseId !== stringField(envelope.lease_id, BARE_DIGEST)
      || lease.fence !== integerField(envelope.fence, 1)
      || (requireCurrent && (lease.expiresAt <= Date.now() || lease.quarantined))) {
      throw new ManagerError('LEASE_MISMATCH')
    }
    return lease
  }

  private transaction(state: ManagerState, envelope: Record<string, unknown>): TransactionState {
    const digestValue = stringField(envelope.transaction_digest, BARE_DIGEST)
    const transaction = state.transactions[digestValue]
    if (transaction === undefined) throw new ManagerError('STATE_CONFLICT')
    return transaction
  }

  private leaseReceipt(lease: LeaseState, state: string): Readonly<Record<string, unknown>> {
    return receipt({
      schema: RECEIPT_SCHEMA, state,
      leaseRef: `giana:lease:sha256:${lease.leaseId}`,
      issuerRef: this.registry.issuerRef, holderRef: this.registry.holderRef,
      targets: lease.targets, fencingDigest: `sha256:${digest({ lease: lease.leaseId, fence: lease.fence })}`,
      expiresAt: lease.expiresAt, renewAfterMs: lease.renewAfterMs,
      lease_id: lease.leaseId, fence: lease.fence, generation: lease.generation,
      coverage_digest: digest({ targets: sortedTargets(lease.targetDescriptors) }),
      admission_digest: this.registry.admissionDigest, no_secret: true,
    })
  }

  private transactionReceipt(lease: LeaseState, transaction: TransactionState, state: string): Readonly<Record<string, unknown>> {
    const base = { ...this.withoutDigest(this.leaseReceipt(lease, state)),
      transaction_digest: transaction.digest, transaction_kind: transaction.kind,
      scope_digest: transaction.scopeDigest,
      state_machine_digest: digest({ transaction: transaction.digest, sequence: transaction.sequence, state }),
      next_allowed_stages: transaction.nextAllowed,
    }
    return receipt(base)
  }

  private stageReceipt(
    lease: LeaseState,
    transaction: TransactionState,
    route: ManagedRoute,
    stage: Stage,
    outcome: { status: string; decision: string; evidence: unknown },
  ): Readonly<Record<string, unknown>> {
    const state = outcome.status === 'PASS' ? 'STAGE_SUCCEEDED'
      : transaction.nextAllowed.length > 0 ? 'STAGE_FAILED_RECOVERY_REQUIRED' : 'FAILED_FINAL'
    const base = { ...this.withoutDigest(this.transactionReceipt(lease, transaction, state)),
      route_id: route.id, target_class: route.target, exact_revision_digest: route.revisionDigest,
      stage_receipt: {
        stage, status: outcome.status, decision: outcome.decision,
        evidence_digest: digest(outcome.evidence), error_class: outcome.status === 'PASS' ? '' : 'MODEL_STAGE_FAILED',
        ...stage === 'prestate' && outcome.decision === 'RESIDENT'
          ? { resident_route_id: (outcome.evidence as { route: ManagedRoute }).route.id,
            resident_revision_digest: (outcome.evidence as { route: ManagedRoute }).route.revisionDigest } : {},
      },
    }
    return receipt(base)
  }

  private withoutDigest(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const copy = { ...value }
    delete copy.receiptDigest
    return copy
  }

  private remember(state: ManagerState, operation: string, key: string, result: Readonly<Record<string, unknown>>): void {
    const entry = state.replay.find(candidate => candidate.operation === operation && candidate.key === key)
    if (entry === undefined || entry.status !== 'PENDING') throw new ManagerError('STATE_CONFLICT')
    entry.status = 'COMPLETE'
    entry.result = result
    this.trimReplay(state)
  }

  private trimReplay(state: ManagerState): void {
    while (state.replay.length > 256) {
      const index = state.replay.findIndex(entry => entry.status === 'COMPLETE')
      if (index === -1) break
      state.replay.splice(index, 1)
    }
  }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  const registry = parsePreviewManagerRegistry(JSON.parse(await readFile(args.registryPath, 'utf8')) as unknown)
  const store = new PreviewManagerStateStore(args.statePath)
  await store.load()
  const manager = new PreviewManager(registry, store, args)
  let buffer = Buffer.alloc(0)
  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > MAX_FRAME_BYTES) process.exitCode = 2
    let end: number
    while ((end = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, end)
      buffer = buffer.subarray(end + 1)
      void Promise.resolve().then(async () => {
        const frame = record(JSON.parse(line.toString('utf8')) as unknown)
        const id = stringField(frame.id)
        const operation = stringField(frame.operation)
        try {
          const result = await manager.invoke(operation, frame.envelope)
          process.stdout.write(`${JSON.stringify({ id, result })}\n`)
        } catch (error: unknown) {
          const code = error instanceof ManagerError ? error.code : 'REMOTE_FAILURE'
          process.stdout.write(`${JSON.stringify({ id, error: { code } })}\n`)
        }
      }).catch(() => { process.exitCode = 2 })
    }
  })
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch(() => { process.exitCode = 2 })
}
