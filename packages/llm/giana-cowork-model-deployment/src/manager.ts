/** Fixed-command Server Manager process for the isolated Giana CoWork Preview deployment. */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { dirname, isAbsolute } from 'node:path'
import { Transform } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

const RECEIPT_SCHEMA = 'giana.server-manager.resource-lease-receipt.v2'
const REGISTRY_SCHEMA = 'giana.cowork.preview.model-registry.v2'
const STATE_SCHEMA = 'giana.cowork.preview.model-manager-state.v2'
const BARE_DIGEST = /^[a-f0-9]{64}$/u
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u
const SAFE_TOKEN = /^[A-Za-z0-9._/:+-]+$/u
const TARGETS = ['r5300', 'prdg', 'ram-cpu'] as const
const STAGES = ['preflight', 'prestate', 'drain', 'stop', 'verify-stopped', 'start', 'health', 'probe'] as const
const MAX_FRAME_BYTES = 262_144
const MAX_CAPTURE_BYTES = 1_048_576
const MAX_HTTP_HEADER_BYTES = 65_536
const ENDPOINT_RECOVERY_TIMEOUT_MS = 15_000
const STATE_RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160] as const

export type TargetClass = typeof TARGETS[number]
type Stage = typeof STAGES[number]
type TransactionKind = 'MODEL_ROUTE' | 'IDLE_UNLOAD' | 'SHUTDOWN'

/** Retry only the short-lived Windows rename failures seen during atomic replacement. */
export async function replaceStateFile(
  temporary: string,
  target: string,
  renameFile: typeof rename = rename,
): Promise<void> {
  for (const delayMs of [...STATE_RENAME_RETRY_DELAYS_MS, undefined]) {
    try {
      await renameFile(temporary, target)
      return
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (delayMs === undefined || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
}

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
  /** Stable loopback port consumed by the frozen provider profile. */
  readonly localPort: number
  /** Manager-owned local hop; distinct from localPort to expose listener conflicts. */
  readonly upstreamLocalPort: number
  readonly expectedModel: string
  readonly drain: DrainConfig
  readonly release: ReleaseConfig
}

interface DrainConfig {
  readonly kind: 'sglang-load' | 'vllm-metrics' | 'llama-metrics'
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
  readonly target: TargetClass
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
  readonly slots: readonly HostSlotConfig[]
  readonly targets: readonly TargetDescriptor[]
  readonly routes: readonly ManagedRoute[]
}

interface LeaseState {
  readonly leaseId: string
  readonly fence: number
  readonly generation: number
  targets: readonly TargetClass[]
  targetDescriptors: readonly TargetDescriptor[]
  readonly hostLeases: Partial<Record<TargetClass, HostLeaseState>>
  expiresAt: number
  readonly renewAfterMs: number
  quarantined: boolean
}

interface HostLeaseState {
  readonly fence: number
  expiresAt: number
}

interface TransactionState {
  settlement: 'ACTIVE' | 'AWAITING_PUBLICATION' | 'COMPENSATING' | 'COMMITTED'
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
  destinationPrestateDigest?: string | undefined
  sourcePrestateDigest?: string | undefined
}

interface EvictionConsent {
  readonly id: string
  readonly fencing_digest: string
  readonly scope_digest: string
  readonly transaction_digest: string
  readonly source_route_id: string
  readonly source_revision_digest: string
  readonly source_target: TargetClass
  readonly destination_route_id: string
  readonly destination_revision_digest: string
  readonly destination_target: TargetClass
  readonly source_prestate_digest: string
  readonly destination_prestate_digest: string
  readonly expires_at: number
  readonly signature: string
}

interface DeviceRecoveryRequirement {
  readonly index: number
  readonly uuid: string
  readonly action: 'Reset'
}

interface DeviceRecoveryConsent {
  readonly id: string
  readonly fencing_digest: string
  readonly scope_digest: string
  readonly transaction_digest: string
  readonly route_id: string
  readonly revision_digest: string
  readonly target: TargetClass
  readonly preflight_receipt_digest: string
  readonly recovery_state_digest: string
  readonly devices: readonly DeviceRecoveryRequirement[]
  readonly expires_at: number
  readonly signature: string
}

type CapacityAssessment =
  | { readonly kind: 'available'; readonly evidence: unknown }
  | { readonly kind: 'unavailable'; readonly evidence: unknown }
  | {
    readonly kind: 'recovery-required'
    readonly evidence: unknown
    readonly recoveryStateDigest: string
    readonly devices: readonly DeviceRecoveryRequirement[]
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
  consumedEvictions: Record<string, string>
}

/** Fixed local process and remote host arguments for one manager instance. */
export interface PreviewManagerArguments {
  readonly registryPath: string
  readonly statePath: string
  readonly runners: readonly PreviewManagerRunnerConfig[]
}

/** One fixed command runner for an admitted compute target. */
export type PreviewManagerRunnerConfig =
  | {
    readonly target: TargetClass
    readonly kind: 'ssh'
    readonly executable: string
    readonly configPath: string
    readonly host: string
  }
  | {
    readonly target: TargetClass
    readonly kind: 'wsl'
    readonly executable: string
    readonly distribution: string
  }

/** Sanitized settlement returned by one injected remote command runner. */
export interface PreviewManagerRemoteResult {
  readonly code: number
  readonly stdout: string
}

/** Deployment-owned remote runner used by the manager and its keyless tests. */
export type PreviewManagerRemoteRunner = (
  target: TargetClass,
  command: string,
  timeoutMs: number,
) => Promise<PreviewManagerRemoteResult>

/** Minimum admitted route identity required by the process-local endpoint owner. */
export interface PreviewEndpointRoute {
  readonly id: string
  readonly target: TargetClass
  readonly runtime: {
    readonly localPort: number
    readonly upstreamLocalPort: number
    readonly remotePort: number
    readonly expectedModel: string
  }
}

/** Process-local endpoint ownership used to bind one admitted host to a stable provider URL. */
export interface PreviewEndpointController {
  ensure(route: PreviewEndpointRoute, timeoutMs: number): Promise<boolean>
  healthy(route: PreviewEndpointRoute, timeoutMs: number): Promise<boolean>
  probe(route: PreviewEndpointRoute, timeoutMs: number): Promise<boolean>
  quiesce(route: PreviewEndpointRoute, timeoutMs: number): Promise<boolean>
  resume(route: PreviewEndpointRoute, timeoutMs: number): Promise<boolean>
  close(route: PreviewEndpointRoute, timeoutMs: number): Promise<boolean>
  released(route: PreviewEndpointRoute, timeoutMs: number): Promise<boolean>
  shutdown(): Promise<void>
}

/** Test seam for one fixed SSH forwarding child; production keeps fixed spawn options. */
export type PreviewEndpointProcessSpawner = (executable: string, args: readonly string[]) => ChildProcess

class ManagerError extends Error {
  constructor(
    readonly code: 'INVALID_REQUEST' | 'BUSY' | 'TARGET_UNAVAILABLE' | 'LEASE_MISMATCH' | 'STATE_CONFLICT' | 'REMOTE_FAILURE' | 'UNKNOWN_COMMIT',
    readonly failureDetail?: StageFailureDetail,
  ) {
    super(code)
    this.name = 'ManagerError'
  }
}

interface StageFailureDetail {
  readonly substage: 'HOST_LEASE_ASSERTION' | 'DEVICE_RECOVERY_PRECHECK' | 'DEVICE_RECOVERY_DISPATCH'
  readonly remote_code?: number
  readonly reset_invocation: 'NOT_STARTED' | 'STARTED' | 'UNKNOWN'
}

class StageBudget {
  private readonly deadline: number

  constructor(timeoutMs: number, absoluteDeadline?: number) {
    const relativeDeadline = Date.now() + timeoutMs
    this.deadline = absoluteDeadline === undefined
      ? relativeDeadline
      : Math.min(relativeDeadline, absoluteDeadline)
  }

  remaining(maximum = Number.MAX_SAFE_INTEGER): number {
    const remaining = Math.floor(this.deadline - Date.now())
    if (remaining < 1) throw new ManagerError('REMOTE_FAILURE')
    return Math.min(remaining, maximum)
  }

  available(): number {
    return Math.max(0, Math.floor(this.deadline - Date.now()))
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

export function canonicalJson(value: unknown): string {
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

function deploymentKey(routeId: string, target: TargetClass): string {
  return createHash('sha256').update(`${routeId}\u0000${target}`).digest('hex')
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
  const runners = parseRunnerConfigs(JSON.parse(stringField(values.get('--runners'))) as unknown)
  if (values.size !== 3 || !isAbsolute(registryPath) || !isAbsolute(statePath)) {
    throw new ManagerError('INVALID_REQUEST')
  }
  return { registryPath, statePath, runners }
}

function targetClass(value: unknown): TargetClass {
  if (typeof value !== 'string' || !TARGETS.includes(value as TargetClass)) throw new ManagerError('INVALID_REQUEST')
  return value as TargetClass
}

function parseRunnerConfigs(value: unknown): readonly PreviewManagerRunnerConfig[] {
  if (!Array.isArray(value) || value.length === 0) throw new ManagerError('INVALID_REQUEST')
  const runners = value.map((candidate): PreviewManagerRunnerConfig => {
    const input = record(candidate)
    const target = targetClass(input.target)
    if (input.kind === 'ssh') {
      strictKeys(input, ['target', 'kind', 'executable', 'configPath', 'host'])
      const executable = stringField(input.executable)
      const configPath = stringField(input.configPath)
      if (!isAbsolute(executable) || !isAbsolute(configPath)) throw new ManagerError('INVALID_REQUEST')
      return Object.freeze({
        target, kind: 'ssh', executable, configPath,
        host: stringField(input.host, SAFE_TOKEN),
      })
    }
    if (input.kind === 'wsl') {
      strictKeys(input, ['target', 'kind', 'executable', 'distribution'])
      const executable = stringField(input.executable)
      if (!isAbsolute(executable)) throw new ManagerError('INVALID_REQUEST')
      return Object.freeze({
        target, kind: 'wsl', executable,
        distribution: stringField(input.distribution, SAFE_TOKEN),
      })
    }
    throw new ManagerError('INVALID_REQUEST')
  })
  if (new Set(runners.map(runner => runner.target)).size !== runners.length) {
    throw new ManagerError('INVALID_REQUEST')
  }
  return Object.freeze(runners)
}

function strictKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new ManagerError('INVALID_REQUEST')
}

function parseEvictionConsent(value: unknown): EvictionConsent {
  const input = record(value)
  strictKeys(input, [
    'id', 'fencing_digest', 'scope_digest', 'transaction_digest', 'source_route_id', 'source_revision_digest',
    'source_target', 'destination_route_id', 'destination_revision_digest', 'destination_target',
    'source_prestate_digest', 'destination_prestate_digest', 'expires_at', 'signature',
  ])
  return {
    id: stringField(input.id, BARE_DIGEST),
    fencing_digest: stringField(input.fencing_digest, BARE_DIGEST),
    scope_digest: stringField(input.scope_digest, BARE_DIGEST),
    transaction_digest: stringField(input.transaction_digest, BARE_DIGEST),
    source_route_id: stringField(input.source_route_id, SAFE_TOKEN),
    source_revision_digest: stringField(input.source_revision_digest, BARE_DIGEST),
    source_target: targetClass(input.source_target),
    destination_route_id: stringField(input.destination_route_id, SAFE_TOKEN),
    destination_revision_digest: stringField(input.destination_revision_digest, BARE_DIGEST),
    destination_target: targetClass(input.destination_target),
    source_prestate_digest: stringField(input.source_prestate_digest, BARE_DIGEST),
    destination_prestate_digest: stringField(input.destination_prestate_digest, BARE_DIGEST),
    expires_at: integerField(input.expires_at, 1),
    signature: stringField(input.signature, BARE_DIGEST),
  }
}

function parseRecoveryDevices(value: unknown): readonly DeviceRecoveryRequirement[] {
  if (!Array.isArray(value) || value.length === 0) throw new ManagerError('INVALID_REQUEST')
  const devices = value.map((candidate): DeviceRecoveryRequirement => {
    const input = record(candidate)
    strictKeys(input, ['index', 'uuid', 'action'])
    if (input.action !== 'Reset') throw new ManagerError('INVALID_REQUEST')
    return {
      index: integerField(input.index, 0, 31),
      uuid: stringField(input.uuid, /^GPU-[A-Fa-f0-9-]+$/u),
      action: 'Reset',
    }
  }).sort((left, right) => left.index - right.index)
  if (new Set(devices.map(device => device.index)).size !== devices.length
    || new Set(devices.map(device => device.uuid)).size !== devices.length) {
    throw new ManagerError('INVALID_REQUEST')
  }
  return devices
}

function parseDeviceRecoveryConsent(value: unknown): DeviceRecoveryConsent {
  const input = record(value)
  strictKeys(input, [
    'id', 'fencing_digest', 'scope_digest', 'transaction_digest', 'route_id', 'revision_digest',
    'target', 'preflight_receipt_digest', 'recovery_state_digest', 'devices', 'expires_at', 'signature',
  ])
  return {
    id: stringField(input.id, BARE_DIGEST),
    fencing_digest: stringField(input.fencing_digest, BARE_DIGEST),
    scope_digest: stringField(input.scope_digest, BARE_DIGEST),
    transaction_digest: stringField(input.transaction_digest, BARE_DIGEST),
    route_id: stringField(input.route_id, SAFE_TOKEN),
    revision_digest: stringField(input.revision_digest, BARE_DIGEST),
    target: targetClass(input.target),
    preflight_receipt_digest: stringField(input.preflight_receipt_digest, BARE_DIGEST),
    recovery_state_digest: stringField(input.recovery_state_digest, BARE_DIGEST),
    devices: parseRecoveryDevices(input.devices),
    expires_at: integerField(input.expires_at, 1),
    signature: stringField(input.signature, BARE_DIGEST),
  }
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
    'remotePort', 'localPort', 'upstreamLocalPort', 'expectedModel', 'drain', 'release',
  ])
  if (input.kind !== 'docker' && input.kind !== 'script' && input.kind !== 'systemd') {
    throw new ManagerError('INVALID_REQUEST')
  }
  const expectedModel = stringField(input.expectedModel, SAFE_TOKEN)
  const remotePort = integerField(input.remotePort, 1, 65_535)
  const localPort = integerField(input.localPort, 1, 65_535)
  const upstreamLocalPort = integerField(input.upstreamLocalPort, 1, 65_535)
  if (localPort === upstreamLocalPort) throw new ManagerError('INVALID_REQUEST')
  const drainInput = record(input.drain)
  strictKeys(drainInput, ['kind', 'path', 'pollIntervalMs'])
  if (drainInput.kind !== 'sglang-load' && drainInput.kind !== 'vllm-metrics'
    && drainInput.kind !== 'llama-metrics') {
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
      remotePort, localPort, upstreamLocalPort, expectedModel, drain, release,
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
      remotePort, localPort, upstreamLocalPort, expectedModel, drain, release,
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
    pidFile, processMarker, remotePort, localPort, upstreamLocalPort, expectedModel, drain, release,
  })
}

/** Parse and validate a fixed-command preview registry. */
export function parsePreviewManagerRegistry(value: unknown): PreviewManagerRegistry {
  const input = record(value)
  strictKeys(input, ['schema', 'issuerRef', 'holderRef', 'admissionDigest', 'renewAfterMs', 'slots', 'targets', 'routes'])
  if (input.schema !== REGISTRY_SCHEMA || !Array.isArray(input.targets) || !Array.isArray(input.routes)
    || !Array.isArray(input.slots) || input.targets.length === 0 || input.routes.length === 0) {
    throw new ManagerError('INVALID_REQUEST')
  }
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
  if (new Set(routes.map(route => deploymentKey(route.id, route.target))).size !== routes.length
    || new Set(routes.map(route => `${route.target}\u0000${route.runtime.remotePort}`)).size !== routes.length) {
    throw new ManagerError('INVALID_REQUEST')
  }
  const logicalRevisions = new Map<string, string>()
  const logicalEndpoints = new Map<string, { localPort: number; expectedModel: string }>()
  for (const route of routes) {
    const existing = logicalRevisions.get(route.id)
    if (existing !== undefined && existing !== route.revisionDigest) throw new ManagerError('INVALID_REQUEST')
    logicalRevisions.set(route.id, route.revisionDigest)
    const endpoint = logicalEndpoints.get(route.id)
    if (endpoint !== undefined && (endpoint.localPort !== route.runtime.localPort
      || endpoint.expectedModel !== route.runtime.expectedModel)) throw new ManagerError('INVALID_REQUEST')
    logicalEndpoints.set(route.id, { localPort: route.runtime.localPort, expectedModel: route.runtime.expectedModel })
  }
  const endpointOwners = new Map<number, string>()
  for (const route of routes) {
    const owner = endpointOwners.get(route.runtime.localPort)
    if (owner !== undefined && owner !== route.id) throw new ManagerError('INVALID_REQUEST')
    endpointOwners.set(route.runtime.localPort, route.id)
  }
  const remotePath = (value: unknown): string => {
    const path = stringField(value, SAFE_TOKEN)
    if (!path.startsWith('/')) throw new ManagerError('INVALID_REQUEST')
    return path
  }
  const slots = input.slots.map((candidate) => {
    const slotInput = record(candidate)
    strictKeys(slotInput, ['target', 'id', 'lockPath', 'operationLockPath', 'statePath', 'counterPath'])
    const slot = Object.freeze({
      target: targetClass(slotInput.target),
      id: stringField(slotInput.id, SAFE_TOKEN),
      lockPath: remotePath(slotInput.lockPath),
      operationLockPath: remotePath(slotInput.operationLockPath),
      statePath: remotePath(slotInput.statePath),
      counterPath: remotePath(slotInput.counterPath),
    })
    if (new Set([slot.lockPath, slot.operationLockPath, slot.statePath, slot.counterPath]).size !== 4) {
      throw new ManagerError('INVALID_REQUEST')
    }
    return slot
  })
  if (new Set(slots.map(slot => slot.target)).size !== slots.length
    || new Set(slots.map(slot => slot.id)).size !== slots.length
    || targets.some(target => !slots.some(slot => slot.target === target.class))) {
    throw new ManagerError('INVALID_REQUEST')
  }
  return Object.freeze({
    schema: REGISTRY_SCHEMA,
    issuerRef: stringField(input.issuerRef),
    holderRef: stringField(input.holderRef),
    admissionDigest: stringField(input.admissionDigest, BARE_DIGEST),
    renewAfterMs: integerField(input.renewAfterMs, 1),
    slots: Object.freeze(slots),
    targets: Object.freeze(targets),
    routes: Object.freeze(routes),
  })
}

function initialState(): ManagerState {
  return { schema: STATE_SCHEMA, nextFence: 1, generation: 0, transactions: {}, replay: [], consumedEvictions: {} }
}

function parseState(value: unknown): ManagerState {
  try {
    const input = record(value)
    strictKeys(input, ['schema', 'nextFence', 'generation', 'lease', 'transactions', 'replay', 'consumedEvictions'])
    if (input.schema !== STATE_SCHEMA) throw new ManagerError('STATE_CONFLICT')

    let lease: LeaseState | undefined
    if (input.lease !== undefined) {
      const candidate = record(input.lease)
      strictKeys(candidate, [
        'leaseId', 'fence', 'generation', 'targets', 'targetDescriptors',
        'hostLeases', 'expiresAt', 'renewAfterMs', 'quarantined',
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
      const hostLeaseInput = record(candidate.hostLeases)
      const hostLeases: Partial<Record<TargetClass, HostLeaseState>> = {}
      for (const [key, value] of Object.entries(hostLeaseInput)) {
        const target = targetClass(key)
        const entry = record(value)
        strictKeys(entry, ['fence', 'expiresAt'])
        hostLeases[target] = {
          fence: integerField(entry.fence, 1),
          expiresAt: integerField(entry.expiresAt, 1),
        }
      }
      if (canonicalJson(Object.keys(hostLeases).sort()) !== canonicalJson([...targets].sort())) {
        throw new ManagerError('STATE_CONFLICT')
      }
      lease = {
        leaseId: stringField(candidate.leaseId, BARE_DIGEST),
        fence: integerField(candidate.fence, 1),
        generation: integerField(candidate.generation, 1),
        targets,
        targetDescriptors,
        hostLeases,
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
        'destinationPrestateDigest', 'sourcePrestateDigest', 'settlement',
      ])
      const kind = stringField(candidate.kind) as TransactionKind
      const settlement = stringField(candidate.settlement) as TransactionState['settlement']
      if (!['ACTIVE', 'AWAITING_PUBLICATION', 'COMPENSATING', 'COMMITTED'].includes(settlement)) {
        throw new ManagerError('STATE_CONFLICT')
      }
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
        || candidate.terminal !== (nextAllowed.length === 0 && settlement !== 'AWAITING_PUBLICATION')) {
        throw new ManagerError('STATE_CONFLICT')
      }
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
      if ((settlement === 'AWAITING_PUBLICATION' || settlement === 'COMMITTED')
        && (kind !== 'MODEL_ROUTE' || candidate.recovery || nextAllowed.length !== 0
          || destinationRouteId === undefined
          || (startedRouteId !== destinationRouteId && adoptedResidentRouteId !== destinationRouteId))) {
        throw new ManagerError('STATE_CONFLICT')
      }
      if (settlement === 'COMPENSATING' && (!candidate.recovery || kind !== 'MODEL_ROUTE')) {
        throw new ManagerError('STATE_CONFLICT')
      }
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
        || (candidate.cleanCancelable && (nextAllowed.includes('probe') || inFlight !== undefined))
        || lastStoppedRouteId !== undefined
        || (!candidate.terminal && settlement !== 'AWAITING_PUBLICATION' && !(nextAllowed.length === 1
          && (nextAllowed[0] === 'health' || nextAllowed[0] === 'probe')
          && allowedRoutes[nextAllowed[0]]?.length === 1
          && allowedRoutes[nextAllowed[0]]?.[0] === adoptedResidentRouteId)))) {
        throw new ManagerError('STATE_CONFLICT')
      }
      const transactionDigest = stringField(candidate.digest, BARE_DIGEST)
      if (transactionDigest !== key) throw new ManagerError('STATE_CONFLICT')
      transactions[key] = {
        settlement,
        digest: transactionDigest,
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
        ...(candidate.destinationPrestateDigest === undefined ? {}
          : { destinationPrestateDigest: stringField(candidate.destinationPrestateDigest, BARE_DIGEST) }),
        ...(candidate.sourcePrestateDigest === undefined ? {}
          : { sourcePrestateDigest: stringField(candidate.sourcePrestateDigest, BARE_DIGEST) }),
      }
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

    const consumedInput = input.consumedEvictions === undefined ? {} : record(input.consumedEvictions)
    const consumedEvictions: Record<string, string> = {}
    for (const [id, transactionDigest] of Object.entries(consumedInput)) {
      consumedEvictions[stringField(id, BARE_DIGEST)] = stringField(transactionDigest, BARE_DIGEST)
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
      consumedEvictions,
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
      await replaceStateFile(temporary, this.path)
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
      'for environ in /proc/[0-9]*/environ; do [ -r "$environ" ] || continue; if tr "\\000" "\\n" < "$environ" 2>/dev/null | grep -Fqx -- "GCP_PROCESS_MARKER=$marker"; then exit 76; fi; done',
      '"$start_path"',
    )
  } else {
    script.push(
      '[ -r "$pid_file" ] || exit 76',
      'read -r tracked < "$pid_file" || exit 76',
      '[[ "$tracked" =~ ^[1-9][0-9]*$ ]] || exit 76',
      '[ -r "/proc/$tracked/environ" ] || exit 76',
      'tr "\\000" "\\n" < "/proc/$tracked/environ" | grep -Fqx -- "GCP_PROCESS_MARKER=$marker" || exit 76',
      'tracked_group=$(ps -o pgid= -p "$tracked" 2>/dev/null | tr -d " ")',
      '[[ "$tracked_group" =~ ^[1-9][0-9]*$ ]] || exit 76',
      'matches=0',
      'for environ in /proc/[0-9]*/environ; do [ -r "$environ" ] || continue; if tr "\\000" "\\n" < "$environ" 2>/dev/null | grep -Fqx -- "GCP_PROCESS_MARKER=$marker"; then pid=${environ#/proc/}; pid=${pid%/environ}; group=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d " "); [ "$group" = "$tracked_group" ] || exit 76; matches=$((matches + 1)); fi; done',
      '[ "$matches" -ge 1 ] || exit 76',
      '"$stop_path"',
    )
  }
  script.push("printf 'GCP_SCRIPT_MUTATION_APPLIED\\n'")
  return `/usr/bin/bash -c ${shellQuote(script.join('\n'))}`
}

function runRemote(
  args: PreviewManagerArguments,
  target: TargetClass,
  command: string,
  timeoutMs: number,
): Promise<PreviewManagerRemoteResult> {
  const runner = args.runners.find(candidate => candidate.target === target)
  if (runner === undefined) return Promise.reject(new ManagerError('REMOTE_FAILURE'))
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
    const child = spawn(runner.executable, runner.kind === 'ssh'
      ? ['-F', runner.configPath, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', runner.host, wrapped]
      : ['--distribution', runner.distribution, '--exec', 'bash', '--noprofile', '--norc', '-c', wrapped], {
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

interface EndpointState {
  readonly key: string
  readonly localPort: number
  readonly server: Server
  readonly sockets: Set<Socket>
  readonly channels: Set<ChildProcess>
  unhealthy: boolean
  serverClose?: Promise<boolean>
  closing?: Promise<boolean>
}

function endpointKey(route: PreviewEndpointRoute, runner: PreviewManagerRunnerConfig): string {
  return digest({ id: route.id, target: route.target, runtime: route.runtime, runner })
}

function portOpen(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(Math.max(1, timeoutMs), () => { finish(false) })
    socket.once('connect', () => { finish(true) })
    socket.once('error', () => { finish(false) })
  })
}

function settleWithin(operation: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => { finish(false) }, Math.max(1, timeoutMs))
    operation.then(finish, () => { finish(false) })
  })
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  do {
    if (await portOpen(port, Math.min(500, Math.max(1, deadline - Date.now())))) return true
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
  } while (Date.now() < deadline)
  return false
}

function singleRequestTransform(): Transform {
  let header = Buffer.alloc(0)
  let forwarded = false
  return new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      if (forwarded) {
        callback(null, chunk)
        return
      }
      header = Buffer.concat([header, chunk])
      const end = header.indexOf('\r\n\r\n')
      if (end === -1 && header.length > MAX_HTTP_HEADER_BYTES) {
        callback(new Error('HTTP_HEADER_TOO_LARGE'))
        return
      }
      if (end === -1) {
        callback()
        return
      }
      if (end + 4 > MAX_HTTP_HEADER_BYTES) {
        callback(new Error('HTTP_HEADER_TOO_LARGE'))
        return
      }
      const head = header.subarray(0, end).toString('latin1')
      const closed = /(?:^|\r\n)connection\s*:/iu.test(head)
        ? head.replace(/(^|\r\n)connection\s*:[^\r\n]*/iu, '$1Connection: close')
        : `${head}\r\nConnection: close`
      forwarded = true
      callback(null, Buffer.concat([Buffer.from(`${closed}\r\n\r\n`, 'latin1'), header.subarray(end + 4)]))
      header = Buffer.alloc(0)
    },
    flush(callback): void {
      callback(forwarded ? undefined : new Error('INCOMPLETE_HTTP_HEADER'))
    },
  })
}

export class LoopbackEndpointController implements PreviewEndpointController {
  private readonly states = new Map<number, EndpointState>()
  private readonly runners: ReadonlyMap<TargetClass, PreviewManagerRunnerConfig>

  constructor(
    args: PreviewManagerArguments,
    private readonly spawnEndpoint: PreviewEndpointProcessSpawner = (executable, childArgs) => spawn(
      executable,
      [...childArgs],
      { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
    ),
  ) {
    this.runners = new Map(args.runners.map(runner => [runner.target, runner]))
  }

  private async request(route: PreviewEndpointRoute, path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, Math.max(1, timeoutMs))
    timer.unref()
    try {
      const response = await fetch(`http://127.0.0.1:${route.runtime.localPort}${path}`, {
        ...init,
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('endpoint rejected request')
      return await response.json()
    } finally {
      clearTimeout(timer)
    }
  }

  private async exactModel(route: PreviewEndpointRoute, timeoutMs: number): Promise<boolean> {
    try {
      const payload = record(await this.request(route, '/v1/models', { method: 'GET' }, timeoutMs))
      return Array.isArray(payload.data)
        && payload.data.some(entry => record(entry).id === route.runtime.expectedModel)
    } catch {
      return false
    }
  }

  async ensure(route: PreviewEndpointRoute, timeoutMs: number): Promise<boolean> {
    const runner = this.runners.get(route.target)
    if (runner === undefined) return false
    const key = endpointKey(route, runner)
    const current = this.states.get(route.runtime.localPort)
    if (current?.key === key && current.serverClose === undefined && current.closing === undefined && !current.unhealthy
      && current.server.listening) return this.exactModel(route, timeoutMs)
    if (current !== undefined && !await this.closeState(current, timeoutMs)) return false

    if (runner.kind === 'wsl' && !await waitForPort(route.runtime.upstreamLocalPort, Math.min(timeoutMs, 12_000))) {
      return false
    }

    const sockets = new Set<Socket>()
    const channels = new Set<ChildProcess>()
    const server = createServer((client) => {
      sockets.add(client)
      client.once('close', () => sockets.delete(client))
      if (runner.kind === 'ssh') {
        const channel = this.spawnEndpoint(runner.executable, [
          '-T', '-F', runner.configPath,
          '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
          '-W', `127.0.0.1:${route.runtime.remotePort}`,
          runner.host,
        ])
        channels.add(channel)
        let terminated = false
        const terminate = (): void => {
          if (terminated) return
          terminated = true
          channel.stdin?.destroy()
          channel.stdout?.destroy()
          if (channel.exitCode === null && channel.signalCode === null) channel.kill('SIGKILL')
          client.destroy()
        }
        channel.once('error', terminate)
        channel.once('close', (code, signal) => {
          channels.delete(channel)
          if (code !== 0 || signal !== null) terminate()
        })
        if (channel.stdin === null || channel.stdout === null) {
          channel.kill('SIGKILL')
          client.destroy()
          return
        }
        channel.stdin.once('error', terminate)
        channel.stdout.once('error', terminate)
        client.once('error', terminate)
        client.once('close', () => {
          if (channel.exitCode === null && channel.signalCode === null) channel.kill()
        })
        const request = singleRequestTransform()
        request.once('error', terminate)
        client.pipe(request).pipe(channel.stdin)
        channel.stdout.pipe(client)
        return
      }
      const upstream = connect({ host: '127.0.0.1', port: route.runtime.upstreamLocalPort })
      sockets.add(upstream)
      upstream.once('close', () => sockets.delete(upstream))
      const terminate = (): void => {
        upstream.destroy()
        client.destroy()
      }
      client.once('error', terminate)
      upstream.once('error', terminate)
      const request = singleRequestTransform()
      request.once('error', terminate)
      client.pipe(request).pipe(upstream)
      upstream.pipe(client)
    })
    const listening = await new Promise<boolean>((resolve) => {
      const onError = (): void => { resolve(false) }
      server.once('error', onError)
      server.listen({ host: '127.0.0.1', port: route.runtime.localPort, exclusive: true }, () => {
        server.off('error', onError)
        resolve(true)
      })
    })
    if (!listening) {
      return false
    }
    const state: EndpointState = {
      key,
      localPort: route.runtime.localPort,
      server,
      sockets,
      channels,
      unhealthy: false,
    }
    server.on('error', () => { state.unhealthy = true })
    this.states.set(route.runtime.localPort, state)
    if (await this.exactModel(route, Math.min(timeoutMs, 10_000))) return true
    await this.closeState(state, timeoutMs)
    return false
  }

  async healthy(route: PreviewEndpointRoute, timeoutMs: number): Promise<boolean> {
    const runner = this.runners.get(route.target)
    if (runner === undefined) return false
    const state = this.states.get(route.runtime.localPort)
    return state?.key === endpointKey(route, runner)
      && !state.unhealthy
      && state.closing === undefined
      && await this.exactModel(route, timeoutMs)
  }

  async probe(route: PreviewEndpointRoute, timeoutMs: number): Promise<boolean> {
    if (!await this.healthy(route, timeoutMs)) return false
    const body = JSON.stringify({
      model: route.runtime.expectedModel,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: 4,
      stream: false,
    })
    try {
      const payload = record(await this.request(route, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }, timeoutMs))
      return Array.isArray(payload.choices) && payload.choices.length > 0
    } catch {
      return false
    }
  }

  async quiesce(route: PreviewEndpointRoute, timeoutMs: number): Promise<boolean> {
    const runner = this.runners.get(route.target)
    if (runner === undefined) return false
    const state = this.states.get(route.runtime.localPort)
    if (state === undefined) return !await portOpen(route.runtime.localPort, Math.min(timeoutMs, 1_000))
    if (state.key !== endpointKey(route, runner)) return false
    const deadline = Date.now() + timeoutMs
    const forceReserveMs = Math.min(1_000, Math.max(1, Math.floor(timeoutMs / 4)))
    const gracefulDeadline = deadline - forceReserveMs
    const serverClose = this.beginServerClose(state)
    while ((state.sockets.size > 0 || state.channels.size > 0) && Date.now() < gracefulDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    if (state.sockets.size > 0 || state.channels.size > 0) {
      // Admission is already closed and the grace window has elapsed. Reclaim
      // only this controller's transports; the following remote drain proof
      // still prevents the model process from stopping mid-request.
      return this.closeState(state, Math.max(1, deadline - Date.now()))
    }
    const closed = await settleWithin(serverClose, Math.max(1, deadline - Date.now()))
    return closed && !state.server.listening
  }

  async resume(route: PreviewEndpointRoute, timeoutMs: number): Promise<boolean> {
    const runner = this.runners.get(route.target)
    if (runner === undefined) return false
    const state = this.states.get(route.runtime.localPort)
    if (state === undefined) return this.ensure(route, timeoutMs)
    if (state.key !== endpointKey(route, runner) || state.closing !== undefined || state.unhealthy) return false
    if (state.server.listening) return this.exactModel(route, timeoutMs)
    if (state.serverClose !== undefined && !await settleWithin(state.serverClose, timeoutMs)) return false
    delete state.serverClose
    const listening = await new Promise<boolean>((resolve) => {
      const onError = (): void => { resolve(false) }
      state.server.once('error', onError)
      state.server.listen({ host: '127.0.0.1', port: state.localPort, exclusive: true }, () => {
        state.server.off('error', onError)
        resolve(true)
      })
    })
    return listening && await this.exactModel(route, timeoutMs)
  }

  async close(route: PreviewEndpointRoute, timeoutMs: number): Promise<boolean> {
    const runner = this.runners.get(route.target)
    if (runner === undefined) return false
    const state = this.states.get(route.runtime.localPort)
    if (state === undefined) return !await portOpen(route.runtime.localPort, Math.min(timeoutMs, 1_000))
    if (state.key !== endpointKey(route, runner)) return false
    return this.closeState(state, timeoutMs)
  }

  async released(route: PreviewEndpointRoute, timeoutMs: number): Promise<boolean> {
    return !this.states.has(route.runtime.localPort)
      && !await portOpen(route.runtime.localPort, Math.min(timeoutMs, 1_000))
  }

  private beginServerClose(state: EndpointState): Promise<boolean> {
    state.serverClose ??= state.server.listening
      ? new Promise<boolean>((resolve) => { state.server.close((error) => { resolve(error === undefined) }) })
      : Promise.resolve(true)
    return state.serverClose
  }

  private async closeState(state: EndpointState, timeoutMs: number): Promise<boolean> {
    if (state.closing !== undefined) return state.closing
    state.unhealthy = true
    state.closing = (async () => {
      const budgetMs = Math.max(1, timeoutMs)
      const deadline = Date.now() + budgetMs
      const forceReserveMs = Math.min(1_000, Math.max(1, Math.floor(budgetMs / 4)))
      const portReserveMs = Math.min(1_000, Math.max(1, Math.floor(budgetMs / 4)))
      const gracefulDeadline = Math.max(Date.now(), deadline - forceReserveMs - portReserveMs)
      const forceDeadline = Math.max(gracefulDeadline, deadline - portReserveMs)
      const waitForChannelsUntil = async (until: number): Promise<void> => {
        while (state.channels.size > 0) {
          const remaining = until - Date.now()
          if (remaining <= 0) return
          await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)))
        }
      }
      const serverClose = this.beginServerClose(state)
      for (const socket of state.sockets) socket.destroy()
      for (const channel of state.channels) channel.kill()
      const gracefulBudgetMs = gracefulDeadline - Date.now()
      let closed = gracefulBudgetMs > 0 && await settleWithin(serverClose, gracefulBudgetMs)
      await waitForChannelsUntil(gracefulDeadline)
      if (state.channels.size > 0) {
        for (const channel of state.channels) channel.kill('SIGKILL')
        await waitForChannelsUntil(forceDeadline)
      }
      if (!closed) {
        const closeBudgetMs = forceDeadline - Date.now()
        closed = closeBudgetMs > 0 && await settleWithin(serverClose, closeBudgetMs)
      }
      const portBudgetMs = deadline - Date.now()
      const released = closed && state.channels.size === 0
        && portBudgetMs > 0
        && !await portOpen(state.localPort, Math.min(portBudgetMs, 1_000))
      if (released && this.states.get(state.localPort) === state) this.states.delete(state.localPort)
      return released
    })()
    return state.closing
  }

  async shutdown(): Promise<void> {
    let released = true
    for (const state of [...this.states.values()]) {
      try {
        if (!await this.closeState(state, 5_000)) released = false
      } catch {
        released = false
      }
    }
    if (!released) throw new ManagerError('REMOTE_FAILURE')
  }
}

/** Stateful JSONL operation implementation behind the Server Manager transport. */
export class PreviewManager {
  private readonly routeByKey: ReadonlyMap<string, ManagedRoute>
  private readonly slotByTarget: ReadonlyMap<TargetClass, HostSlotConfig>
  private readonly evictionKeyPath: string

  constructor(
    private readonly registry: PreviewManagerRegistry,
    private readonly store: PreviewManagerStateStore,
    args: PreviewManagerArguments,
    private readonly remote: PreviewManagerRemoteRunner = (target, command, timeoutMs) =>
      runRemote(args, target, command, timeoutMs),
    private readonly endpoints: PreviewEndpointController = new LoopbackEndpointController(args),
  ) {
    this.routeByKey = new Map(registry.routes.map(route => [deploymentKey(route.id, route.target), route]))
    this.slotByTarget = new Map(registry.slots.map(slot => [slot.target, slot]))
    const runnerTargets = new Set(args.runners.map(runner => runner.target))
    if (registry.targets.some(target => !runnerTargets.has(target.class))) throw new ManagerError('INVALID_REQUEST')
    this.evictionKeyPath = `${args.statePath}.eviction-key`
  }

  /** Close process-local channels and loopback bridges without mutating resident models. */
  shutdown(): Promise<void> {
    return this.endpoints.shutdown()
  }

  private route(routeId: string, target: TargetClass): ManagedRoute | undefined {
    return this.routeByKey.get(deploymentKey(routeId, target))
  }

  private slot(target: TargetClass): HostSlotConfig {
    const slot = this.slotByTarget.get(target)
    if (slot === undefined) throw new ManagerError('INVALID_REQUEST')
    return slot
  }

  private logicalRouteId(key: string): string {
    const route = this.routeByKey.get(key)
    if (route === undefined) throw new ManagerError('STATE_CONFLICT')
    return route.id
  }

  private async verifyConsent(consent: EvictionConsent | DeviceRecoveryConsent): Promise<void> {
    let key: Buffer
    try {
      key = await readFile(this.evictionKeyPath)
    } catch {
      throw new ManagerError('STATE_CONFLICT')
    }
    if (key.length !== 32) throw new ManagerError('STATE_CONFLICT')
    const { signature, ...fields } = consent
    const expected = createHmac('sha256', key).update(canonicalJson(fields), 'utf8').digest()
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new ManagerError('STATE_CONFLICT')
  }

  private requestedTargets(envelope: Record<string, unknown>, ttlMs: number): readonly TargetDescriptor[] {
    if (!Array.isArray(envelope.targets) || envelope.targets.length === 0) {
      throw new ManagerError('INVALID_REQUEST')
    }
    const requested = sortedTargets(envelope.targets.map((candidate) => {
      const target = record(candidate)
      return {
        class: targetClass(target.class),
        identity_digest: stringField(target.identity_digest, BARE_DIGEST),
        currentness_digest: stringField(target.currentness_digest, BARE_DIGEST),
      }
    }))
    const admitted = sortedTargets(this.registry.targets
      .filter(target => requested.some(entry => entry.class === target.class)))
    if (canonicalJson(requested) !== canonicalJson(admitted) || this.registry.renewAfterMs >= ttlMs) {
      throw new ManagerError('LEASE_MISMATCH')
    }
    return requested
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
      if (operation === 'expand') return await this.expand(envelope, key)
      if (operation === 'renew') return await this.renew(envelope, key)
      if (operation === 'release') return await this.release(envelope, key)
      if (operation === 'begin') return await this.begin(envelope, key)
      if (operation === 'cancel-clean') return await this.cancelClean(envelope, key)
      if (operation === 'settle-activation') return await this.settleActivation(envelope, key)
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
    const requested = this.requestedTargets(envelope, ttlMs)
    return this.store.run(async (state) => {
      const unresolved = Object.values(state.transactions).some(transaction =>
        !transaction.terminal || transaction.inFlight !== undefined)
      if (state.lease !== undefined && (state.lease.quarantined || unresolved || state.lease.expiresAt > Date.now())) {
        throw new ManagerError('BUSY')
      }
      const leaseId = randomBytes(32).toString('hex')
      const fence = state.nextFence
      state.nextFence += 1
      const hostLeases: Partial<Record<TargetClass, HostLeaseState>> = {}
      try {
        for (const descriptor of requested) {
          hostLeases[descriptor.class] = await this.acquireHostLease(descriptor.class, leaseId, ttlMs)
        }
      } catch (error: unknown) {
        const released = await this.releaseHostLeases(leaseId, hostLeases)
        if (!released) {
          const captured = requested.filter(descriptor => hostLeases[descriptor.class] !== undefined)
          state.generation += 1
          state.lease = {
            leaseId, fence, generation: state.generation,
            targets: captured.map(target => target.class), targetDescriptors: captured,
            hostLeases,
            expiresAt: Math.min(...Object.values(hostLeases).map(hostLease => hostLease.expiresAt)),
            renewAfterMs: this.registry.renewAfterMs, quarantined: true,
          }
          await this.store.persist()
          throw new ManagerError('UNKNOWN_COMMIT')
        }
        throw error
      }
      state.transactions = {}
      state.generation += 1
      const lease: LeaseState = {
        leaseId, fence, generation: state.generation,
        targets: requested.map(target => target.class), targetDescriptors: requested,
        hostLeases,
        expiresAt: Math.min(...Object.values(hostLeases).map(hostLease => hostLease.expiresAt)),
        renewAfterMs: this.registry.renewAfterMs, quarantined: false,
      }
      state.lease = lease
      const result = this.leaseReceipt(lease, 'ACQUIRED')
      this.remember(state, 'acquire', key, result)
      await this.store.persist()
      return result
    })
  }

  private async expand(envelope: Record<string, unknown>, key: string): Promise<Readonly<Record<string, unknown>>> {
    const ttlMs = integerField(envelope.ttl_ms, 2)
    const requested = this.requestedTargets(envelope, ttlMs)
    return this.store.run(async (state) => {
      const lease = this.boundLease(state, envelope)
      if (!lease.targets.every(target => requested.some(descriptor => descriptor.class === target))) {
        throw new ManagerError('LEASE_MISMATCH')
      }
      const additions = requested.filter(descriptor => !lease.targets.includes(descriptor.class))
      if (additions.length === 0) throw new ManagerError('INVALID_REQUEST')
      const acquired: Partial<Record<TargetClass, HostLeaseState>> = {}
      try {
        for (const descriptor of additions) {
          acquired[descriptor.class] = await this.acquireHostLease(descriptor.class, lease.leaseId, ttlMs)
        }
      } catch (error: unknown) {
        if (!await this.releaseHostLeases(lease.leaseId, acquired)) {
          lease.quarantined = true
          await this.store.persist()
          throw new ManagerError('UNKNOWN_COMMIT')
        }
        throw error
      }
      try {
        for (const target of lease.targets) {
          const hostLease = lease.hostLeases[target]
          if (hostLease === undefined) throw new ManagerError('LEASE_MISMATCH')
          hostLease.expiresAt = await this.renewHostLease(target, lease.leaseId, hostLease, ttlMs)
        }
      } catch {
        Object.assign(lease.hostLeases, acquired)
        lease.targets = requested.map(target => target.class)
        lease.targetDescriptors = requested
        lease.expiresAt = Math.min(...Object.values(lease.hostLeases).map(hostLease => hostLease.expiresAt))
        lease.quarantined = true
        await this.store.persist()
        throw new ManagerError('UNKNOWN_COMMIT')
      }
      Object.assign(lease.hostLeases, acquired)
      lease.targets = requested.map(target => target.class)
      lease.targetDescriptors = requested
      lease.expiresAt = Math.min(...Object.values(lease.hostLeases).map(hostLease => hostLease.expiresAt))
      const result = this.leaseReceipt(lease, 'EXPANDED')
      this.remember(state, 'expand', key, result)
      await this.store.persist()
      return result
    })
  }

  private async renew(envelope: Record<string, unknown>, key: string): Promise<Readonly<Record<string, unknown>>> {
    const ttlMs = integerField(envelope.ttl_ms, 2)
    return this.store.run(async (state) => {
      const lease = this.boundLease(state, envelope)
      if (lease.quarantined || this.registry.renewAfterMs >= ttlMs) throw new ManagerError('LEASE_MISMATCH')
      try {
        for (const target of lease.targets) {
          const hostLease = lease.hostLeases[target]
          if (hostLease === undefined) throw new ManagerError('LEASE_MISMATCH')
          hostLease.expiresAt = await this.renewHostLease(target, lease.leaseId, hostLease, ttlMs)
        }
      } catch {
        lease.quarantined = true
        await this.store.persist()
        throw new ManagerError('UNKNOWN_COMMIT')
      }
      lease.expiresAt = Math.min(...Object.values(lease.hostLeases).map(hostLease => hostLease.expiresAt))
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
      const settled = requestedSettlement && await this.releaseHostLeases(lease.leaseId, lease.hostLeases)
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
        settlement: 'ACTIVE',
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

  private async settleActivation(envelope: Record<string, unknown>, key: string): Promise<Readonly<Record<string, unknown>>> {
    const disposition = stringField(envelope.disposition)
    if (disposition !== 'COMMIT' && disposition !== 'COMPENSATE') throw new ManagerError('INVALID_REQUEST')
    const target = targetClass(record(envelope.target).class)
    const requestedRoute = this.route(stringField(envelope.route_id, SAFE_TOKEN), target)
    return this.store.run(async (state) => {
      const lease = this.boundLease(state, envelope)
      const transaction = this.transaction(state, envelope)
      const destination = this.routeByKey.get(transaction.destinationRouteId ?? '')
      if (transaction.kind !== 'MODEL_ROUTE' || transaction.terminal || transaction.inFlight !== undefined
        || transaction.sequence !== integerField(envelope.expected_sequence, 1)
        || transaction.scopeDigest !== stringField(envelope.scope_digest, BARE_DIGEST)
        || destination === undefined || destination !== requestedRoute
        || destination.revisionDigest !== envelope.exact_revision_digest
        || canonicalJson(envelope.target) !== canonicalJson(lease.targetDescriptors.find(target => target.class === destination.target))) {
        throw new ManagerError('STATE_CONFLICT')
      }
      if (disposition === 'COMMIT') {
        if (transaction.settlement !== 'AWAITING_PUBLICATION') throw new ManagerError('STATE_CONFLICT')
        transaction.settlement = 'COMMITTED'
      } else {
        if (transaction.settlement !== 'ACTIVE' && transaction.settlement !== 'AWAITING_PUBLICATION') {
          throw new ManagerError('STATE_CONFLICT')
        }
        if (transaction.adoptedResidentRouteId !== undefined) {
          if (transaction.settlement !== 'AWAITING_PUBLICATION') throw new ManagerError('STATE_CONFLICT')
          // Read-only adoption failed publication; it never authorizes stopping the resident.
          transaction.settlement = 'ACTIVE'
        } else {
          const destinationKey = deploymentKey(destination.id, destination.target)
          const destinationNeedsStop = transaction.startedRouteId === destinationKey
            || (transaction.recovery && transaction.allowedRoutes.stop?.includes(destinationKey) === true)
          const sourceCanRestart = transaction.sourceRouteId !== undefined
            && transaction.sourceRouteId !== destinationKey
            && transaction.lastStoppedRouteId === transaction.sourceRouteId
            && transaction.allowedRoutes.start?.includes(destinationKey) === true
          if (!destinationNeedsStop && !sourceCanRestart) throw new ManagerError('STATE_CONFLICT')
          const restoration = destinationNeedsStop ? { stop: [destinationKey] }
            : transaction.sourceRouteId === undefined ? undefined : { start: [transaction.sourceRouteId] }
          if (restoration === undefined) throw new ManagerError('STATE_CONFLICT')
          transaction.recovery = true
          transaction.settlement = 'COMPENSATING'
          transaction.nextAllowed = this.setAllowed(transaction, restoration)
        }
      }
      transaction.cleanCancelable = false
      transaction.terminal = transaction.nextAllowed.length === 0
      transaction.sequence += 1
      const result = this.transactionReceipt(lease, transaction,
        disposition === 'COMMIT' ? 'ACTIVATION_COMMITTED' : 'COMPENSATION_AUTHORIZED')
      this.remember(state, 'settle-activation', key, result)
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
    const deadlineAt = integerField(envelope.deadline_at, 1)
    const budget = new StageBudget(timeoutMs, deadlineAt)
    const route = this.route(routeId, targetName)
    if (route === undefined || route.revisionDigest !== revision) throw new ManagerError('INVALID_REQUEST')
    const routeKey = deploymentKey(route.id, route.target)
    const transactionDigest = stringField(envelope.transaction_digest, BARE_DIGEST)
    let hostLease: Pick<LeaseState, 'leaseId' | 'fence'> | undefined
    let consentExpiresAt: number | undefined
    let deviceRecoveryConsent: DeviceRecoveryConsent | undefined
    let evictionDestination: { route: ManagedRoute; lease: Pick<LeaseState, 'leaseId' | 'fence'> } | undefined
    let allowOwnedUnhealthyCleanup = false
    await this.store.run(async (state) => {
      budget.remaining()
      const lease = this.boundLease(state, envelope)
      const covered = lease.targetDescriptors.find(descriptor => descriptor.class === targetName)
      if (covered === undefined || canonicalJson(target) !== canonicalJson(covered)) throw new ManagerError('LEASE_MISMATCH')
      const transaction = this.transaction(state, envelope)
      if (!transaction.nextAllowed.includes(stage) || transaction.terminal || transaction.inFlight !== undefined
        || lease.expiresAt <= Date.now() || !this.routeAllowed(transaction, stage, route)) {
        throw new ManagerError('STATE_CONFLICT')
      }
      if (stage === 'preflight' && envelope.device_recovery_consent !== undefined) {
        if (transaction.kind !== 'MODEL_ROUTE') throw new ManagerError('STATE_CONFLICT')
        const consent = parseDeviceRecoveryConsent(envelope.device_recovery_consent)
        const previous = [...state.replay].reverse().find((entry) => {
          if (entry.operation !== 'stage' || entry.status !== 'COMPLETE' || entry.result === undefined) return false
          const stageReceipt = entry.result.stage_receipt
          return entry.result.transaction_digest === transaction.digest
            && stageReceipt !== null && typeof stageReceipt === 'object' && !Array.isArray(stageReceipt)
            && (stageReceipt as Record<string, unknown>).stage === 'preflight'
        })?.result
        const previousStage = previous?.stage_receipt === null || typeof previous?.stage_receipt !== 'object'
          || Array.isArray(previous.stage_receipt) ? undefined : previous.stage_receipt as Record<string, unknown>
        if (previous === undefined || previousStage === undefined
          || previousStage.decision !== 'RECOVERY_REQUIRED') {
          throw new ManagerError('STATE_CONFLICT')
        }
        const previousDevices = parseRecoveryDevices(previousStage.recovery_devices)
        if (consent.expires_at <= Date.now() || consent.expires_at > lease.expiresAt
          || consent.id in state.consumedEvictions
          || consent.fencing_digest !== digest({ lease: lease.leaseId, fence: lease.fence })
          || consent.scope_digest !== transaction.scopeDigest
          || consent.transaction_digest !== transaction.digest
          || consent.route_id !== route.id
          || consent.revision_digest !== route.revisionDigest
          || consent.target !== route.target
          || consent.preflight_receipt_digest !== stringField(previous.receiptDigest, SHA256_DIGEST).slice(7)
          || consent.recovery_state_digest !== stringField(previousStage.recovery_state_digest, BARE_DIGEST)
          || canonicalJson(consent.devices) !== canonicalJson(previousDevices)) {
          throw new ManagerError('STATE_CONFLICT')
        }
        await this.verifyConsent(consent)
        state.consumedEvictions[consent.id] = transaction.digest
        transaction.cleanCancelable = false
        deviceRecoveryConsent = consent
      } else if (envelope.device_recovery_consent !== undefined) {
        throw new ManagerError('INVALID_REQUEST')
      }
      if (stage === 'stop') {
        if (transaction.kind !== 'MODEL_ROUTE') throw new ManagerError('STATE_CONFLICT')
        if (transaction.recovery && transaction.settlement !== 'COMPENSATING') throw new ManagerError('STATE_CONFLICT')
        allowOwnedUnhealthyCleanup = transaction.recovery
          && transaction.settlement === 'COMPENSATING'
          && transaction.startedRouteId === routeKey
          && transaction.sourceRouteId !== routeKey
        const evictsExisting = transaction.sourceRouteId === routeKey
          && transaction.destinationRouteId !== routeKey && !transaction.recovery
        if (evictsExisting) {
          const consent = parseEvictionConsent(envelope.eviction_consent)
          const destination = this.routeByKey.get(transaction.destinationRouteId ?? '')
          if (destination === undefined || consent.expires_at <= Date.now()
            || consent.expires_at > lease.expiresAt
            || consent.id in state.consumedEvictions
            || consent.fencing_digest !== digest({ lease: lease.leaseId, fence: lease.fence })
            || consent.scope_digest !== transaction.scopeDigest
            || consent.transaction_digest !== transaction.digest
            || consent.source_route_id !== route.id
            || consent.source_revision_digest !== route.revisionDigest
            || consent.source_target !== route.target
            || consent.destination_route_id !== destination.id
            || consent.destination_revision_digest !== destination.revisionDigest
            || consent.destination_target !== destination.target
            || consent.source_prestate_digest !== transaction.sourcePrestateDigest
            || consent.destination_prestate_digest !== transaction.destinationPrestateDigest) {
            throw new ManagerError('STATE_CONFLICT')
          }
          await this.verifyConsent(consent)
          const destinationLease = lease.hostLeases[destination.target]
          if (destinationLease === undefined) throw new ManagerError('LEASE_MISMATCH')
          evictionDestination = {
            route: destination,
            lease: { leaseId: lease.leaseId, fence: destinationLease.fence },
          }
          state.consumedEvictions[consent.id] = transaction.digest
          consentExpiresAt = consent.expires_at
        } else if (envelope.eviction_consent !== undefined) {
          throw new ManagerError('INVALID_REQUEST')
        }
      } else if (envelope.eviction_consent !== undefined) throw new ManagerError('INVALID_REQUEST')
      const targetLease = lease.hostLeases[targetName]
      if (targetLease === undefined) throw new ManagerError('LEASE_MISMATCH')
      hostLease = { leaseId: lease.leaseId, fence: targetLease.fence }
      if (stage !== 'preflight' && stage !== 'prestate') transaction.cleanCancelable = false
      transaction.inFlight = stage
      await this.store.persist()
    })

    let outcome: { status: 'PASS' | 'FAIL' | 'QUARANTINED'; decision: string; evidence: unknown }
    try {
      if (hostLease === undefined) throw new ManagerError('STATE_CONFLICT')
      const markStartedMutation = async (): Promise<void> => {
        await this.store.run(async (state) => {
          const lease = this.boundLease(state, envelope, false)
          const transaction = state.transactions[transactionDigest]
          if (transaction === undefined || transaction.inFlight !== 'start') throw new ManagerError('UNKNOWN_COMMIT')
          transaction.started = true
          transaction.startedRouteId = routeKey
          if (lease.expiresAt <= Date.now() || lease.quarantined) lease.quarantined = true
          await this.store.persist()
          if (lease.quarantined) throw new ManagerError('UNKNOWN_COMMIT')
        })
      }
      outcome = await this.executeStage(
        stage, route, budget, hostLease, consentExpiresAt, allowOwnedUnhealthyCleanup, markStartedMutation,
        deviceRecoveryConsent, evictionDestination,
      )
    }
    catch (error: unknown) {
      outcome = {
        status: error instanceof ManagerError && error.code === 'UNKNOWN_COMMIT' ? 'QUARANTINED' : 'FAIL',
        decision: 'FAILED', evidence: {
          stage, error: error instanceof ManagerError ? error.code : 'REMOTE_FAILURE',
          ...(error instanceof ManagerError && error.failureDetail !== undefined
            ? { failure_detail: error.failureDetail } : {}),
        },
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
      transaction.cleanCancelable = transaction.cleanCancelable
        && (stage === 'preflight' || stage === 'prestate') && outcome.status === 'PASS'
      transaction.nextAllowed = this.advanceTransaction(stage, route, outcome, transaction)
      transaction.terminal = transaction.nextAllowed.length === 0 && transaction.settlement !== 'AWAITING_PUBLICATION'
      const result = this.stageReceipt(lease, transaction, route, stage, outcome)
      if (stage === 'prestate' && outcome.status === 'PASS') {
        const receiptDigest = stringField(result.receiptDigest, SHA256_DIGEST).slice(7)
        if (routeKey === transaction.destinationRouteId && transaction.destinationPrestateCaptured) {
          transaction.destinationPrestateDigest = receiptDigest
        } else if (routeKey === transaction.sourceRouteId) {
          transaction.sourcePrestateDigest = receiptDigest
        }
      }
      this.remember(state, 'stage', key, result)
      if (outcome.status === 'QUARANTINED') lease.quarantined = true
      await this.store.persist()
      return result
    })
  }

  private async executeStage(
    stage: Stage,
    route: ManagedRoute,
    budget: StageBudget,
    lease: Pick<LeaseState, 'leaseId' | 'fence'>,
    consentExpiresAt?: number,
    allowOwnedUnhealthyCleanup = false,
    markStartedMutation?: () => Promise<void>,
    deviceRecoveryConsent?: DeviceRecoveryConsent,
    evictionDestination?: { route: ManagedRoute; lease: Pick<LeaseState, 'leaseId' | 'fence'> },
  ): Promise<{ status: 'PASS' | 'FAIL' | 'QUARANTINED'; decision: string; evidence: unknown }> {
    const restoreAdmission = async (): Promise<boolean> => {
      try {
        return await this.endpoints.resume(route, ENDPOINT_RECOVERY_TIMEOUT_MS)
      } catch {
        return false
      }
    }
    await this.assertHostLease(route.target, lease, budget)
    if (stage === 'preflight') {
      if (deviceRecoveryConsent !== undefined) {
        await this.resetDevices(route, lease, deviceRecoveryConsent, budget)
      }
      const assessment = await this.capacity(route, budget)
      if (assessment.kind === 'recovery-required') return {
        status: 'PASS', decision: 'RECOVERY_REQUIRED', evidence: assessment.evidence,
      }
      return {
        status: 'PASS',
        decision: assessment.kind === 'available' ? 'AVAILABLE' : 'UNAVAILABLE',
        evidence: assessment.evidence,
      }
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
        if (evictionDestination !== undefined) {
          await this.assertHostLease(evictionDestination.route.target, evictionDestination.lease, budget)
          const fit = await this.capacity(evictionDestination.route, budget)
          if (fit.kind !== 'available') return {
            status: 'FAIL', decision: 'SOURCE_RESTORED',
            evidence: { destinationFitLost: true, assessment: fit.evidence, mutationApplied: false },
          }
        }
        let quiesced = false
        try {
          quiesced = await this.endpoints.quiesce(route, budget.remaining(15_000))
        } catch {}
        if (!quiesced) {
          const restored = await restoreAdmission()
          return {
            status: restored ? 'FAIL' : 'QUARANTINED', decision: restored ? 'SOURCE_RESTORED' : 'FAILED',
            evidence: { admissionDrained: false, admissionRestored: restored, mutationApplied: false },
          }
        }
        let finalDrain: Awaited<ReturnType<PreviewManager['waitDrained']>>
        try {
          finalDrain = await this.waitDrained(route, budget)
        } catch {
          const restored = await restoreAdmission()
          return {
            status: restored ? 'FAIL' : 'QUARANTINED', decision: restored ? 'SOURCE_RESTORED' : 'FAILED',
            evidence: { admissionDrained: true, admissionRestored: restored, mutationApplied: false },
          }
        }
        if (!finalDrain.drained && !allowOwnedUnhealthyCleanup) {
          const restored = await restoreAdmission()
          return {
            status: restored ? 'FAIL' : 'QUARANTINED', decision: restored ? 'SOURCE_RESTORED' : 'FAILED',
            evidence: { admissionDrained: true, admissionRestored: restored, mutationApplied: false, finalDrain },
          }
        }
        if (consentExpiresAt !== undefined && consentExpiresAt <= Date.now()) {
          const restored = await restoreAdmission()
          return {
            status: restored ? 'FAIL' : 'QUARANTINED', decision: restored ? 'SOURCE_RESTORED' : 'FAILED',
            evidence: { admissionDrained: true, admissionRestored: restored, mutationApplied: false, consentExpired: true },
          }
        }
        if (budget.available() < 1) {
          const restored = await restoreAdmission()
          return {
            status: restored ? 'FAIL' : 'QUARANTINED', decision: restored ? 'SOURCE_RESTORED' : 'FAILED',
            evidence: { admissionDrained: true, admissionRestored: restored, mutationApplied: false, budgetReserved: false },
          }
        }
      }
      let endpointClosed = false
      try {
        endpointClosed = await this.endpoints.close(route, budget.remaining(15_000))
      } catch {}
      if (!endpointClosed) {
        const restored = before.kind === 'resident' && await restoreAdmission()
        return {
          status: restored ? 'FAIL' : 'QUARANTINED', decision: restored ? 'SOURCE_RESTORED' : 'FAILED',
          evidence: { endpointReleased: false, admissionRestored: restored, mutationApplied: false },
        }
      }
      if (before.kind === 'resident') {
        if (consentExpiresAt !== undefined && consentExpiresAt <= Date.now()) {
          const restored = await restoreAdmission()
          return {
            status: restored ? 'FAIL' : 'QUARANTINED', decision: restored ? 'SOURCE_RESTORED' : 'FAILED',
            evidence: { endpointReleased: true, admissionRestored: restored, mutationApplied: false, consentExpired: true },
          }
        }
        const command = route.runtime.kind === 'docker'
          ? dockerMutationCommand(route.runtime, 'stop')
          : route.runtime.kind === 'systemd'
            ? systemdMutationCommand(route.runtime, 'stop')
            : scriptMutationCommand(route.runtime, 'stop')
        const mutationTimeoutMs = budget.available()
        if (mutationTimeoutMs < 1) {
          const restored = await restoreAdmission()
          return {
            status: restored ? 'FAIL' : 'QUARANTINED', decision: restored ? 'SOURCE_RESTORED' : 'FAILED',
            evidence: { endpointReleased: true, admissionRestored: restored, mutationApplied: false, mutationDispatched: false },
          }
        }
        const stopped = await this.runFencedMutation(route.target, lease, command, mutationTimeoutMs)
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
      const endpointReleased = await this.endpoints.released(route, budget.remaining(5_000))
      return {
        status: release.released && endpointReleased ? 'PASS' : 'QUARANTINED',
        decision: release.released && endpointReleased ? 'VERIFIED_STOPPED' : 'FAILED',
        evidence: { samples: release.samples, endpointReleased },
      }
    }
    if (stage === 'start') {
      const before = await this.residency(route.target, budget)
      if (before.kind === 'unknown' || (before.kind === 'resident' && before.route.id !== route.id)) {
        return { status: 'FAIL', decision: 'FAILED', evidence: before }
      }
      if (before.kind === 'empty') {
        if ((await this.capacity(route, budget)).kind !== 'available') {
          return { status: 'FAIL', decision: 'FAILED', evidence: { available: false } }
        }
        const command = route.runtime.kind === 'docker'
          ? dockerMutationCommand(route.runtime, 'start')
          : route.runtime.kind === 'systemd'
            ? systemdMutationCommand(route.runtime, 'start')
            : scriptMutationCommand(route.runtime, 'start')
        // Once the exact start command is ready to cross the host boundary, own
        // its possible result durably. A caller timeout or lost remote reply may
        // otherwise leave a running model without a compensatable route record.
        await markStartedMutation?.()
        const started = await this.runFencedMutation(route.target, lease, command, budget.remaining())
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
      if (!await this.endpoints.ensure(route, budget.remaining(30_000))) {
        return { status: 'FAIL', decision: 'FAILED', evidence: { endpointReady: false } }
      }
      return { status: 'PASS', decision: 'STARTED', evidence: { previous: before.kind } }
    }
    if (stage === 'health') {
      const healthy = await this.routeHealthy(route, budget)
        && await this.endpoints.ensure(route, budget.remaining(30_000))
        && await this.endpoints.healthy(route, budget.remaining(15_000))
      return { status: healthy ? 'PASS' : 'FAIL', decision: healthy ? 'HEALTHY' : 'UNHEALTHY', evidence: { healthy } }
    }
    // The health stage already proves the admitted process, listener, and exact
    // model. Re-check that identity here, then probe the same local endpoint the
    // LLM adapter will use. A second completion issued directly on the host was
    // redundant and could race dynamic worker membership after inference.
    const healthy = await this.routeHealthy(route, budget)
      && await this.endpoints.probe(route, budget.remaining(120_000))
    return { status: healthy ? 'PASS' : 'FAIL', decision: healthy ? 'HEALTHY' : 'UNHEALTHY', evidence: { healthy } }
  }

  private async acquireHostLease(
    target: TargetClass,
    leaseId: string,
    ttlMs: number,
  ): Promise<HostLeaseState> {
    const slot = this.slot(target)
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
    const result = await this.remote(target, command, 15_000)
    if (result.code === 75) throw new ManagerError('TARGET_UNAVAILABLE')
    if (result.code !== 0) throw new ManagerError('REMOTE_FAILURE')
    const match = /^ACQUIRED (\d+) (\d+) [01]\s*$/u.exec(result.stdout)
    if (match === null) throw new ManagerError('REMOTE_FAILURE')
    return { fence: integerField(Number(match[1]), 1), expiresAt: integerField(Number(match[2]), 1) }
  }

  private async renewHostLease(
    target: TargetClass,
    leaseId: string,
    hostLease: HostLeaseState,
    ttlMs: number,
  ): Promise<number> {
    const slot = this.slot(target)
    const command = [
      'set -euo pipefail',
      `state_lock=${shellQuote(slot.lockPath)}`,
      `state_file=${shellQuote(slot.statePath)}`,
      `expected_lease=${shellQuote(leaseId)}`,
      `expected_fence=${hostLease.fence}`,
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
    const result = await this.remote(target, command, 15_000)
    if (result.code !== 0) throw new ManagerError('LEASE_MISMATCH')
    const match = /^RENEWED (\d+)\s*$/u.exec(result.stdout)
    if (match === null) throw new ManagerError('LEASE_MISMATCH')
    return integerField(Number(match[1]), 1)
  }

  private async releaseHostLease(
    target: TargetClass,
    leaseId: string,
    hostLease: HostLeaseState,
  ): Promise<boolean> {
    const slot = this.slot(target)
    const command = [
      'set -euo pipefail',
      `state_lock=${shellQuote(slot.lockPath)}`,
      `operation_lock=${shellQuote(slot.operationLockPath)}`,
      `state_file=${shellQuote(slot.statePath)}`,
      `expected_lease=${shellQuote(leaseId)}`,
      `expected_fence=${hostLease.fence}`,
      'exec 8>"$operation_lock"; flock -n 8 || exit 75',
      'exec 9>"$state_lock"; flock -w 5 9 || exit 75',
      'read -r current_fence current_lease current_expires extra < "$state_file" || exit 76',
      '[ -z "${extra:-}" ] || exit 76',
      '[ "$current_fence" = "$expected_fence" ] && [ "$current_lease" = "$expected_lease" ] || exit 76',
      'rm -f "$state_file"',
      "printf 'RELEASED\\n'",
    ].join('; ')
    const result = await this.remote(target, command, 15_000)
    return result.code === 0 && /^RELEASED\s*$/u.test(result.stdout)
  }

  private async releaseHostLeases(
    leaseId: string,
    hostLeases: Partial<Record<TargetClass, HostLeaseState>>,
  ): Promise<boolean> {
    let settled = true
    const targets = TARGETS.filter(target => hostLeases[target] !== undefined).reverse()
    for (const target of targets) {
      const hostLease = hostLeases[target]
      if (hostLease === undefined) continue
      try {
        if (!await this.releaseHostLease(target, leaseId, hostLease)) settled = false
      } catch {
        settled = false
      }
    }
    return settled
  }

  private async assertHostLease(
    target: TargetClass,
    lease: Pick<LeaseState, 'leaseId' | 'fence'>,
    budget: StageBudget,
  ): Promise<void> {
    const slot = this.slot(target)
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
    let result: PreviewManagerRemoteResult
    try {
      result = await this.remote(target, command, budget.remaining(15_000))
    } catch {
      throw new ManagerError('UNKNOWN_COMMIT', {
        substage: 'HOST_LEASE_ASSERTION', reset_invocation: 'NOT_STARTED',
      })
    }
    if (result.code !== 0 || !/^CURRENT\s*$/u.test(result.stdout)) {
      throw new ManagerError('UNKNOWN_COMMIT', {
        substage: 'HOST_LEASE_ASSERTION', remote_code: result.code, reset_invocation: 'NOT_STARTED',
      })
    }
  }

  private async runFencedMutation(
    target: TargetClass,
    lease: Pick<LeaseState, 'leaseId' | 'fence'>,
    command: string,
    timeoutMs: number,
  ): Promise<PreviewManagerRemoteResult> {
    const slot = this.slot(target)
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
    try {
      return await this.remote(target, fenced, timeoutMs)
    } catch {
      throw new ManagerError('UNKNOWN_COMMIT')
    }
  }

  private async resetDevices(
    route: ManagedRoute,
    lease: Pick<LeaseState, 'leaseId' | 'fence'>,
    consent: DeviceRecoveryConsent,
    budget: StageBudget,
  ): Promise<void> {
    if (route.target !== 'r5300' || consent.expires_at <= Date.now()
      || canonicalJson(consent.devices.map(device => device.index))
        !== canonicalJson(consent.devices.map(device => device.index).sort((left, right) => left - right))) {
      throw new ManagerError('REMOTE_FAILURE')
    }
    const checks = consent.devices.flatMap((device) => {
      const expected = `${device.index}, ${device.uuid}`
      return [
        `row=$(nvidia-smi --query-gpu=index,uuid --format=csv,noheader,nounits -i ${device.index}) || exit 78`,
        `[ "$row" = ${shellQuote(expected)} ] || exit 76`,
        `recovery=$(nvidia-smi -q -i ${device.index} 2>/dev/null | awk -F: '/^[[:space:]]*GPU Recovery Action[[:space:]]*:/{ value=$2; sub(/^[[:space:]]+/, "", value); sub(/[[:space:]]+$/, "", value); print value; exit }') || exit 78`,
        '[ "$recovery" = Reset ] || exit 76',
        'apps=$(nvidia-smi --query-compute-apps=pid,gpu_uuid --format=csv,noheader,nounits) || exit 78',
        `if printf '%s\\n' "$apps" | awk -F',' -v uuid=${shellQuote(device.uuid)} '{ gsub(/^[ \\t]+|[ \\t]+$/, "", $1); gsub(/^[ \\t]+|[ \\t]+$/, "", $2); if ($2 == uuid && $1 ~ /^[0-9]+$/) found=1 } END { exit found ? 0 : 1 }'; then exit 76; fi`,
      ]
    })
    const precheck = [
      `now=$(date +%s%3N); [ ${consent.expires_at} -gt "$now" ] || exit 76`,
      ...checks,
      "printf 'GCP_DEVICE_RECOVERY_PRECHECKED\\n'",
    ].join('; ')
    let result: PreviewManagerRemoteResult | undefined
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (consent.expires_at <= Date.now()) throw new ManagerError('REMOTE_FAILURE')
      try {
        result = await this.runFencedMutation(route.target, lease, precheck, budget.remaining())
      } catch {
        result = undefined
      }
      if (result?.code === 0 && result.stdout.trim() === 'GCP_DEVICE_RECOVERY_PRECHECKED') break
      if (![75, 78, 255].includes(result?.code ?? 255) || attempt === 3) {
        throw new ManagerError('REMOTE_FAILURE', {
          substage: 'DEVICE_RECOVERY_PRECHECK',
          ...(result === undefined ? {} : { remote_code: result.code }),
          reset_invocation: 'NOT_STARTED',
        })
      }
      const retryDelayMs = Math.min(250 * attempt, budget.remaining())
      await new Promise(resolve => setTimeout(resolve, retryDelayMs))
    }
    if (result?.code !== 0 || result.stdout.trim() !== 'GCP_DEVICE_RECOVERY_PRECHECKED') {
      throw new ManagerError('REMOTE_FAILURE', {
        substage: 'DEVICE_RECOVERY_PRECHECK',
        ...(result === undefined ? {} : { remote_code: result.code }),
        reset_invocation: 'NOT_STARTED',
      })
    }

    for (const device of consent.devices) {
      const reset = [
        `now=$(date +%s%3N); [ ${consent.expires_at} -gt "$now" ] && [ "$current_expires" -gt "$now" ] || exit 76`,
        `target_index=${device.index}`,
        `target_uuid=${shellQuote(device.uuid)}`,
        'row=$(nvidia-smi --query-gpu=index,uuid --format=csv,noheader,nounits -i "$target_index")',
        `[ "$row" = ${shellQuote(`${device.index}, ${device.uuid}`)} ] || exit 76`,
        'recovery=$(nvidia-smi -q -i "$target_index" 2>/dev/null | awk -F: \'/^[[:space:]]*GPU Recovery Action[[:space:]]*:/{ value=$2; sub(/^[[:space:]]+/, "", value); sub(/[[:space:]]+$/, "", value); print value; exit }\')',
        '[ "$recovery" = Reset ] || exit 76',
        'apps=$(nvidia-smi --query-compute-apps=pid,gpu_uuid --format=csv,noheader,nounits) || exit 76',
        `if printf '%s\\n' "$apps" | awk -F',' -v uuid=${shellQuote(device.uuid)} '{ gsub(/^[ \\t]+|[ \\t]+$/, "", $1); gsub(/^[ \\t]+|[ \\t]+$/, "", $2); if ($2 == uuid && $1 ~ /^[0-9]+$/) found=1 } END { exit found ? 0 : 1 }'; then exit 76; fi`,
        `other_apps_before=$(printf '%s\\n' "$apps" | awk -F',' -v uuid=${shellQuote(device.uuid)} '{ gsub(/^[ \\t]+|[ \\t]+$/, "", $1); gsub(/^[ \\t]+|[ \\t]+$/, "", $2); if ($2 != uuid && $1 ~ /^[0-9]+$/) print $1 "," $2 }' | sort)`,
        `now=$(date +%s%3N); [ ${consent.expires_at} -gt "$now" ] && [ "$current_expires" -gt "$now" ] || exit 76`,
        `printf 'GCP_DEVICE_RECOVERY_STARTED ${device.index} ${device.uuid}\\n'`,
        `sudo -n nvidia-smi --gpu-reset -i ${device.index} >/dev/null 2>&1 || exit 77`,
        'row=$(nvidia-smi --query-gpu=index,uuid --format=csv,noheader,nounits -i "$target_uuid")',
        `[ "$row" = ${shellQuote(`${device.index}, ${device.uuid}`)} ] || exit 76`,
        'recovery=$(nvidia-smi -q -i "$target_uuid" 2>/dev/null | awk -F: \'/^[[:space:]]*GPU Recovery Action[[:space:]]*:/{ value=$2; sub(/^[[:space:]]+/, "", value); sub(/[[:space:]]+$/, "", value); print value; exit }\')',
        '[ "$recovery" = None ] || exit 76',
        'apps=$(nvidia-smi --query-compute-apps=pid,gpu_uuid --format=csv,noheader,nounits) || exit 76',
        `other_apps_after=$(printf '%s\\n' "$apps" | awk -F',' -v uuid=${shellQuote(device.uuid)} '{ gsub(/^[ \\t]+|[ \\t]+$/, "", $1); gsub(/^[ \\t]+|[ \\t]+$/, "", $2); if ($2 != uuid && $1 ~ /^[0-9]+$/) print $1 "," $2 }' | sort)`,
        '[ "$other_apps_after" = "$other_apps_before" ] || exit 76',
        `printf 'GCP_DEVICE_RECOVERY_APPLIED ${device.index} ${device.uuid}\\n'`,
      ].join('; ')
      try {
        result = await this.runFencedMutation(route.target, lease, reset, budget.remaining())
      } catch {
        throw new ManagerError('UNKNOWN_COMMIT', {
          substage: 'DEVICE_RECOVERY_DISPATCH', reset_invocation: 'UNKNOWN',
        })
      }
      const started = `GCP_DEVICE_RECOVERY_STARTED ${device.index} ${device.uuid}`
      const marker = `GCP_DEVICE_RECOVERY_APPLIED ${device.index} ${device.uuid}`
      const output = result.stdout.trim().split(/\r?\n/u)
      if (result.code !== 0 || canonicalJson(output) !== canonicalJson([started, marker])) {
        throw new ManagerError('UNKNOWN_COMMIT', {
          substage: 'DEVICE_RECOVERY_DISPATCH', remote_code: result.code,
          reset_invocation: output.includes(started) ? 'STARTED' : 'NOT_STARTED',
        })
      }
    }
  }

  private async capacity(route: ManagedRoute, budget: StageBudget): Promise<CapacityAssessment> {
    const resident = await this.residency(route.target, budget)
    if (resident.kind === 'unknown') return { kind: 'unavailable', evidence: { reason: 'RESIDENCY_UNKNOWN' } }
    const current = resident.kind === 'resident' ? resident : undefined
    const exactResident = current?.route.id === route.id
      && current.route.revisionDigest === route.revisionDigest
    const telemetry = await this.remote(
      route.target,
      "awk '/MemAvailable:/{print \"MEM \" $2}' /proc/meminfo; printf 'GPUS\\n'; "
        + 'gpu_rows=$(nvidia-smi --query-gpu=index,uuid,memory.free --format=csv,noheader,nounits) || exit 78; '
        + 'while IFS=\',\' read -r index uuid free; do '
        + 'index=$(printf \'%s\' "$index" | xargs); uuid=$(printf \'%s\' "$uuid" | xargs); free=$(printf \'%s\' "$free" | xargs); '
        + 'recovery=$(nvidia-smi -q -i "$index" 2>/dev/null | awk -F: \'/^[[:space:]]*GPU Recovery Action[[:space:]]*:/{ value=$2; sub(/^[[:space:]]+/, "", value); sub(/[[:space:]]+$/, "", value); print value; exit }\') || exit 78; '
        + '[ -n "$recovery" ] || exit 78; printf \'%s, %s, %s, %s\\n\' "$index" "$uuid" "$recovery" "$free"; '
        + 'done <<< "$gpu_rows"; printf \'APPS\\n\'; '
        + 'nvidia-smi --query-compute-apps=pid,gpu_uuid,used_gpu_memory --format=csv,noheader,nounits',
      budget.remaining(),
    )
    if (telemetry.code !== 0) return { kind: 'unavailable', evidence: { reason: 'TELEMETRY_FAILED' } }
    const lines = telemetry.stdout.trim().split(/\r?\n/u)
    const memory = /^MEM\s+(\d+)$/u.exec(lines.shift() ?? '')
    if (memory === null) return { kind: 'unavailable', evidence: { reason: 'MEMORY_INVALID' } }
    const memoryKiB = Number(memory[1])
    if (!Number.isSafeInteger(memoryKiB)) return { kind: 'unavailable', evidence: { reason: 'MEMORY_INVALID' } }
    if (lines.shift() !== 'GPUS') return { kind: 'unavailable', evidence: { reason: 'GPU_HEADER_INVALID' } }

    const applicationMarker = lines.indexOf('APPS')
    if (applicationMarker < 1) return { kind: 'unavailable', evidence: { reason: 'GPU_TELEMETRY_INVALID' } }
    const gpuLines = lines.slice(0, applicationMarker)
    const applicationLines = lines.slice(applicationMarker + 1).filter(line => line.length > 0)
    const gpu = new Map<number, { readonly uuid: string; readonly freeMiB: number; readonly recoveryAction: string }>()
    const gpuByUuid = new Map<string, number>()
    for (const line of gpuLines) {
      const match = /^\s*(\d+)\s*,\s*(GPU-[A-Fa-f0-9-]+)\s*,\s*([^,]+?)\s*,\s*(\d+)\s*$/u.exec(line)
      if (match === null) return { kind: 'unavailable', evidence: { reason: 'GPU_ROW_INVALID' } }
      const index = Number(match[1])
      const uuid = match[2]
      const recoveryAction = match[3]
      const freeMiB = Number(match[4])
      if (uuid === undefined || recoveryAction === undefined) return { kind: 'unavailable', evidence: { reason: 'GPU_ROW_INVALID' } }
      if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(freeMiB) || freeMiB < 0
        || gpu.has(index) || gpuByUuid.has(uuid)) return { kind: 'unavailable', evidence: { reason: 'GPU_ROW_INVALID' } }
      gpu.set(index, { uuid, freeMiB, recoveryAction })
      gpuByUuid.set(uuid, index)
    }

    const applications: Array<{ readonly pid: number; readonly gpuIndex: number; readonly usedMiB: number }> = []
    for (const line of applicationLines) {
      if (/^\s*\[N\/A\]\s*,\s*GPU-[A-Fa-f0-9-]+\s*,\s*\[N\/A\]\s*$/u.test(line)) continue
      const match = /^\s*(\d+)\s*,\s*(GPU-[A-Fa-f0-9-]+)\s*,\s*(\d+)\s*$/u.exec(line)
      if (match === null) return { kind: 'unavailable', evidence: { reason: 'APPLICATION_ROW_INVALID' } }
      const pid = Number(match[1])
      const uuid = match[2]
      if (uuid === undefined) return { kind: 'unavailable', evidence: { reason: 'APPLICATION_ROW_INVALID' } }
      const gpuIndex = gpuByUuid.get(uuid)
      const usedMiB = Number(match[3])
      if (!Number.isSafeInteger(pid) || pid < 1 || gpuIndex === undefined
        || !Number.isSafeInteger(usedMiB) || usedMiB < 0) {
        return { kind: 'unavailable', evidence: { reason: 'APPLICATION_ROW_INVALID' } }
      }
      applications.push({ pid, gpuIndex, usedMiB })
    }

    const processResult = await this.remote(route.target, 'ps -eo pid=,pgid=,rss=', budget.remaining())
    if (processResult.code !== 0) return { kind: 'unavailable', evidence: { reason: 'PROCESS_TELEMETRY_FAILED' } }
    const processes = new Map<number, { readonly group: number; readonly rssKiB: number }>()
    for (const line of processResult.stdout.trim().split(/\r?\n/u)) {
      if (line.length === 0) continue
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(line)
      if (match === null) return { kind: 'unavailable', evidence: { reason: 'PROCESS_ROW_INVALID' } }
      const pid = Number(match[1])
      const group = Number(match[2])
      const rssKiB = Number(match[3])
      // Linux exposes kernel threads with PGID 0 in the full process table.
      // They cannot match a managed userspace process group, but remain valid telemetry rows.
      if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(group)
        || !Number.isSafeInteger(rssKiB) || rssKiB < 0 || processes.has(pid)) {
        return { kind: 'unavailable', evidence: { reason: 'PROCESS_ROW_INVALID' } }
      }
      processes.set(pid, { group, rssKiB })
    }
    if (applications.some(application => !processes.has(application.pid))) {
      return { kind: 'unavailable', evidence: { reason: 'APPLICATION_OWNER_UNKNOWN' } }
    }

    if (exactResident) {
      // Exact resident adoption does not allocate again. Keep telemetry and process
      // validation above, then leave endpoint ownership, health, and capability to
      // the following transaction stages. This also covers WSL drivers that report
      // aggregate VRAM but omit per-process compute attribution.
      return {
        kind: 'available',
        evidence: {
          reason: 'EXACT_RESIDENT_ADOPTION',
          routeId: route.id,
          target: route.target,
          processGroups: current.processGroups,
        },
      }
    }

    const currentGroups = new Set(current?.processGroups ?? [])
    const measuredRamMiB = Math.floor([...processes.values()]
      .filter(process => currentGroups.has(process.group))
      .reduce((total, process) => total + process.rssKiB, 0) / 1024)
    const reclaimableRamMiB = current === undefined
      ? 0
      : Math.min(measuredRamMiB, current.route.resources.reclaimableRamMiB)
    const availableRamMiB = Math.floor(memoryKiB / 1024) + reclaimableRamMiB
    if (availableRamMiB < route.resources.minimumFreeRamMiB) {
      return { kind: 'unavailable', evidence: { reason: 'RAM_INSUFFICIENT', availableRamMiB } }
    }

    const recoveryDevices: DeviceRecoveryRequirement[] = []
    for (const index of route.resources.gpuIndices) {
      const gpuState = gpu.get(index)
      if (gpuState === undefined) return { kind: 'unavailable', evidence: { reason: 'GPU_MISSING', index } }
      if (gpuState.recoveryAction !== 'None') {
        const occupied = applications.some(application => application.gpuIndex === index)
        if (route.target !== 'r5300' || gpuState.recoveryAction !== 'Reset' || occupied) {
          return {
            kind: 'unavailable',
            evidence: { reason: occupied ? 'RECOVERY_DEVICE_OCCUPIED' : 'RECOVERY_UNSUPPORTED', index },
          }
        }
        recoveryDevices.push({ index, uuid: gpuState.uuid, action: 'Reset' })
      }
      const measuredVramMiB = applications
        .filter((application) => {
          const process = processes.get(application.pid)
          return application.gpuIndex === index && process !== undefined && currentGroups.has(process.group)
        })
        .reduce((total, application) => total + application.usedMiB, 0)
      const configuredCeiling = current?.route.resources.reclaimableVramMiB[String(index)] ?? 0
      const minimumFreeVramMiB = route.resources.minimumFreeVramMiB[String(index)]
      if (minimumFreeVramMiB === undefined
        || gpuState.freeMiB + Math.min(measuredVramMiB, configuredCeiling) < minimumFreeVramMiB) {
        return { kind: 'unavailable', evidence: { reason: 'VRAM_INSUFFICIENT', index } }
      }
    }
    const stateEvidence = {
      routeId: route.id,
      target: route.target,
      availableRamMiB,
      devices: route.resources.gpuIndices.map((index) => {
        const state = gpu.get(index)
        if (state === undefined) throw new ManagerError('REMOTE_FAILURE')
        return { index, ...state }
      }),
      applications: applications.filter(application => route.resources.gpuIndices.includes(application.gpuIndex)),
    }
    if (recoveryDevices.length > 0) {
      const recoveryStateDigest = digest(stateEvidence)
      return {
        kind: 'recovery-required',
        recoveryStateDigest,
        devices: recoveryDevices,
        evidence: { ...stateEvidence, recovery_state_digest: recoveryStateDigest, recovery_devices: recoveryDevices },
      }
    }
    return { kind: 'available', evidence: stateEvidence }
  }

  private async residency(target: TargetClass, budget: StageBudget): Promise<Residency> {
    const found: Array<{ route: ManagedRoute; processGroups: readonly number[] }> = []
    let unresolved = false
    for (const route of this.registry.routes.filter(candidate => candidate.target === target)) {
      const presence = await this.processPresence(route, budget)
      if (presence.kind === 'unknown') unresolved = true
      else if (presence.kind === 'running') found.push({ route, processGroups: presence.processGroups })
    }
    if (found.length > 1 || unresolved) return { kind: 'unknown' }
    if (found.length === 0) return { kind: 'empty' }
    const resident = found[0]
    if (resident === undefined) return { kind: 'unknown' }
    return { kind: 'resident', route: resident.route, processGroups: resident.processGroups }
  }

  private async processPresence(route: ManagedRoute, budget: StageBudget): Promise<ProcessPresence> {
    if (route.runtime.kind === 'docker') {
      const result = await this.remote(
        route.target,
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
        const group = await this.remote(route.target, `ps -o pgid= -p ${pid}`, budget.remaining(10_000))
        if (group.code !== 0 || !/^\s*\d+\s*$/u.test(group.stdout)) return { kind: 'unknown' }
        return { kind: 'running', processGroups: [Number(group.stdout.trim())] }
      } catch { return { kind: 'unknown' } }
    }

    if (route.runtime.kind === 'systemd') {
      const result = await this.remote(route.target, systemdPresenceCommand(route.runtime), budget.remaining(15_000))
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
      + "if [ ! -e \"$pid_file\" ]; then printf 'PIDFILE MISSING\\n'; elif [ ! -r \"$pid_file\" ]; then printf 'PIDFILE UNREADABLE\\n'; else read -r tracked < \"$pid_file\" || tracked=; case \"$tracked\" in ''|*[!0-9]*) printf 'PIDFILE INVALID\\n' ;; *) if [ -r \"/proc/$tracked/environ\" ]; then if tr '\\000' '\\n' < \"/proc/$tracked/environ\" | grep -Fqx -- \"GCP_PROCESS_MARKER=$marker\"; then group=$(ps -o pgid= -p \"$tracked\" | tr -d ' '); printf 'PIDFILE MATCH %s %s\\n' \"$tracked\" \"$group\"; else printf 'PIDFILE MISMATCH %s\\n' \"$tracked\"; fi; elif [ -e \"/proc/$tracked\" ]; then printf 'PIDFILE UNREADABLE\\n'; else printf 'PIDFILE DEAD\\n'; fi ;; esac; fi; for environ in /proc/[0-9]*/environ; do [ -r \"$environ\" ] || continue; if tr '\\000' '\\n' < \"$environ\" | grep -Fqx -- \"GCP_PROCESS_MARKER=$marker\"; then pid=${environ#/proc/}; pid=${pid%/environ}; group=$(ps -o pgid= -p \"$pid\" | tr -d ' '); printf 'MATCH %s %s\\n' \"$pid\" \"$group\"; fi; done"
    const result = await this.remote(route.target, command, budget.remaining(15_000))
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
    if (before.kind !== 'running' || !await this.listenerOwnedByRoute(route, before, budget)) return false
    const result = await this.remote(
      route.target,
      `curl -fsS --max-time 5 http://127.0.0.1:${route.runtime.remotePort}/v1/models`, budget.remaining(10_000))
    if (result.code !== 0) return false
    try {
      const payload = record(JSON.parse(result.stdout) as unknown)
      if (!Array.isArray(payload.data) || !payload.data.some(entry => record(entry).id === route.runtime.expectedModel)) {
        return false
      }
      const after = await this.processPresence(route, budget)
      return after.kind === 'running' && await this.listenerOwnedByRoute(route, after, budget)
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
    const result = await this.remote(route.target, command, budget.remaining(10_000))
    if (result.code !== 0) return 'unknown'
    if (/^CLOSED\s*$/u.test(result.stdout)) return 'closed'
    if (/^LISTENING\s*$/u.test(result.stdout)) return 'listening'
    return 'unknown'
  }

  private async activeRequestCount(route: ManagedRoute, budget: StageBudget): Promise<number | undefined> {
    const presence = await this.processPresence(route, budget)
    if (presence.kind !== 'running' || !await this.listenerOwnedByRoute(route, presence, budget)) return undefined
    const result = await this.remote(
      route.target,
      `curl -fsS --max-time 5 http://127.0.0.1:${route.runtime.remotePort}${route.runtime.drain.path}`,
      budget.remaining(10_000),
    )
    if (result.code !== 0) return undefined
    if (route.runtime.drain.kind === 'sglang-load') {
      try {
        const payload = JSON.parse(result.stdout) as unknown
        if (!Array.isArray(payload) || payload.length === 0) return undefined
        let total = 0
        for (const value of Array.from<unknown>(payload)) {
          const entry = record(value)
          total += integerField(entry.num_reqs, 0) + integerField(entry.num_waiting_reqs, 0)
        }
        return total
      } catch { return undefined }
    }

    let running: number | undefined
    let waiting: number | undefined
    let swapped = 0
    if (route.runtime.drain.kind === 'llama-metrics') {
      for (const line of result.stdout.split(/\r?\n/u)) {
        const match = /^llamacpp:requests_(processing|deferred)\s+([0-9]+(?:\.[0-9]+)?)\s*$/u.exec(line)
        if (match === null) continue
        const value = Number(match[2])
        if (!Number.isSafeInteger(value) || value < 0) return undefined
        if (match[1] === 'processing') running = value
        else waiting = value
      }
      return running === undefined || waiting === undefined ? undefined : running + waiting
    }
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

  private async listenerOwnedByRoute(
    route: ManagedRoute,
    presence: Extract<ProcessPresence, { readonly kind: 'running' }>,
    budget: StageBudget,
  ): Promise<boolean> {
    const filter = shellQuote(`sport = :${route.runtime.remotePort}`)
    const prelude = 'set -euo pipefail; command -v ss >/dev/null 2>&1; '
      + `listener_pids=$(ss -H -ltnp ${filter} 2>/dev/null | grep -o 'pid=[0-9][0-9]*' | cut -d= -f2 | sort -n -u); `
      + '[ -n "$listener_pids" ]; '
    const ownership = route.runtime.kind === 'docker'
      ? `container_id=${shellQuote(route.runtime.containerId ?? '')}; container_pids=$(docker top "$container_id" -eo pid 2>/dev/null | awk 'NR > 1 { print $1 }'); [ -n "$container_pids" ]; for pid in $listener_pids; do printf '%s\n' "$container_pids" | grep -Fxq -- "$pid"; done; `
      : `allowed=${shellQuote(presence.processGroups.join(' '))}; for pid in $listener_pids; do group=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' '); case " $allowed " in *" $group "*) ;; *) exit 76 ;; esac; done; `
    const result = await this.remote(
      route.target,
      `${prelude}${ownership}printf 'GCP_LISTENER_OWNED\n'`,
      budget.remaining(10_000),
    )
    return result.code === 0 && /^GCP_LISTENER_OWNED\s*$/u.test(result.stdout)
  }

  private async waitHealthy(route: ManagedRoute, budget: StageBudget): Promise<boolean> {
    while (true) {
      if (await this.routeHealthy(route, budget)) return true
      const remaining = budget.remaining()
      await new Promise(resolve => setTimeout(resolve, Math.min(2_000, remaining)))
    }
  }

  private routeAllowed(transaction: TransactionState, stage: Stage, route: ManagedRoute): boolean {
    const key = deploymentKey(route.id, route.target)
    const allowed = transaction.allowedRoutes[stage]
    if (allowed === undefined || (!allowed.includes('*') && !allowed.includes(key))) return false
    if (stage === 'prestate' && transaction.destinationPrestateCaptured
      && transaction.destinationRouteId !== undefined) {
      const destination = this.routeByKey.get(transaction.destinationRouteId)
      if (destination === undefined || key === transaction.destinationRouteId
        || (transaction.sourceRouteId !== undefined && key !== transaction.sourceRouteId)
        || (route.target === destination.target && transaction.sourceRouteId !== key)) return false
    }
    return true
  }

  private setAllowed(transaction: TransactionState, entries: Readonly<Partial<Record<Stage, readonly string[]>>>): Stage[] {
    const allowedRoutes: Partial<Record<Stage, string[]>> = {}
    for (const stage of STAGES) {
      const routes = entries[stage]
      if (routes !== undefined) allowedRoutes[stage] = [...routes]
    }
    transaction.allowedRoutes = allowedRoutes
    return STAGES.filter(stage => (transaction.allowedRoutes[stage]?.length ?? 0) > 0)
  }

  private advanceTransaction(
    stage: Stage,
    route: ManagedRoute,
    outcome: { status: string; decision: string; evidence: unknown },
    transaction: TransactionState,
  ): Stage[] {
    const key = deploymentKey(route.id, route.target)
    if (outcome.status === 'QUARANTINED') return this.setAllowed(transaction, {})
    if (outcome.status !== 'PASS') {
      if (transaction.settlement === 'COMPENSATING') return this.setAllowed(transaction, {})
      if (stage === 'start' || stage === 'health' || stage === 'probe') {
        if ((stage === 'health' || stage === 'probe') && transaction.adoptedResidentRouteId === key) {
          return this.setAllowed(transaction, {})
        }
        if (key === transaction.destinationRouteId) transaction.recovery = true
        return this.setAllowed(transaction, { stop: [key] })
      }
      if (stage === 'stop') {
        return this.setAllowed(transaction, {})
      }
      return this.setAllowed(transaction, {})
    }

    if (stage === 'preflight') {
      if (outcome.decision !== 'AVAILABLE') return this.setAllowed(transaction, { preflight: ['*'] })
      transaction.destinationRouteId = key
      transaction.destinationPrestateCaptured = false
      transaction.recovery = false
      delete transaction.sourceRouteId
      delete transaction.startedRouteId
      delete transaction.adoptedResidentRouteId
      delete transaction.lastStoppedRouteId
      delete transaction.destinationPrestateDigest
      delete transaction.sourcePrestateDigest
      return this.setAllowed(transaction, { prestate: [key] })
    }

    if (stage === 'prestate') {
      const residency = outcome.evidence as Residency
      const residentKey = residency.kind === 'resident'
        ? deploymentKey(residency.route.id, residency.route.target)
        : undefined
      if (transaction.kind !== 'MODEL_ROUTE') {
        if (residentKey !== key) return this.setAllowed(transaction, {})
        transaction.sourceRouteId = key
        return this.setAllowed(transaction, { stop: [key] })
      }

      if (!transaction.destinationPrestateCaptured) {
        transaction.destinationPrestateCaptured = true
        if (key !== transaction.destinationRouteId) return this.setAllowed(transaction, {})
        if (residency.kind === 'resident') {
          if (residentKey === undefined) return this.setAllowed(transaction, {})
          transaction.sourceRouteId = residentKey
          if (residentKey === transaction.destinationRouteId) {
            transaction.adoptedResidentRouteId = key
          }
          return residentKey === transaction.destinationRouteId
            ? this.setAllowed(transaction, { health: [key] })
            : this.setAllowed(transaction, { prestate: [residentKey] })
        }
        return residency.kind === 'empty'
          ? this.setAllowed(transaction, { prestate: ['*'], start: [transaction.destinationRouteId] })
          : this.setAllowed(transaction, {})
      }

      if (residentKey !== key) return this.setAllowed(transaction, {})
      transaction.sourceRouteId = key
      return this.setAllowed(transaction, { drain: [key] })
    }

    if (stage === 'drain') return this.setAllowed(transaction, { stop: [key] })
    if (stage === 'stop') {
      transaction.lastStoppedRouteId = key
      return this.setAllowed(transaction, { 'verify-stopped': [key] })
    }
    if (stage === 'verify-stopped') {
      if (transaction.lastStoppedRouteId !== key || transaction.kind !== 'MODEL_ROUTE') {
        return this.setAllowed(transaction, {})
      }
      if (transaction.recovery) {
        return transaction.sourceRouteId !== undefined && transaction.sourceRouteId !== transaction.destinationRouteId
          ? this.setAllowed(transaction, { start: [transaction.sourceRouteId] })
          : this.setAllowed(transaction, {})
      }
      return transaction.destinationRouteId !== undefined && transaction.sourceRouteId === key
        ? this.setAllowed(transaction, { start: [transaction.destinationRouteId] })
        : this.setAllowed(transaction, {})
    }
    if (stage === 'start') {
      transaction.started = true
      transaction.startedRouteId = key
      delete transaction.adoptedResidentRouteId
      return this.setAllowed(transaction, { health: [key] })
    }
    if (stage === 'health') {
      return transaction.startedRouteId === key || transaction.adoptedResidentRouteId === key
        ? this.setAllowed(transaction, { probe: [key] })
        : this.setAllowed(transaction, {})
    }
    if (!transaction.recovery) {
      transaction.settlement = 'AWAITING_PUBLICATION'
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
      transaction_sequence: transaction.sequence, activation_settlement: transaction.settlement,
      ...(transaction.adoptedResidentRouteId === undefined ? {}
        : { adopted_resident_route_id: this.logicalRouteId(transaction.adoptedResidentRouteId) }),
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
        evidence_digest: digest(outcome.evidence), error_class: outcome.status === 'PASS' ? ''
          : outcome.decision === 'SOURCE_RESTORED'
            ? 'MODEL_STAGE_NOT_APPLIED_SOURCE_RESTORED'
            : 'MODEL_STAGE_FAILED',
        ...outcome.status !== 'PASS'
          && typeof outcome.evidence === 'object' && outcome.evidence !== null
          && 'failure_detail' in outcome.evidence
          ? { failure_detail: (outcome.evidence as { failure_detail: StageFailureDetail }).failure_detail }
          : {},
        ...stage === 'prestate' && outcome.decision === 'RESIDENT'
          ? { resident_route_id: (outcome.evidence as { route: ManagedRoute }).route.id,
            resident_revision_digest: (outcome.evidence as { route: ManagedRoute }).route.revisionDigest } : {},
        ...stage === 'preflight' && outcome.decision === 'RECOVERY_REQUIRED'
          ? {
            recovery_state_digest: (outcome.evidence as { recovery_state_digest: string }).recovery_state_digest,
            recovery_devices: (outcome.evidence as { recovery_devices: readonly DeviceRecoveryRequirement[] }).recovery_devices,
          }
          : {},
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
  const pending = new Set<Promise<void>>()
  let closing: Promise<void> | undefined
  let accepting = true
  const shutdown = (): Promise<void> => {
    accepting = false
    process.stdin.pause()
    process.stdin.destroy()
    closing ??= (async () => {
      while (pending.size > 0) await Promise.allSettled([...pending])
      await manager.shutdown()
    })()
    return closing
  }
  process.stdin.on('data', (chunk: Buffer) => {
    if (!accepting) return
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > MAX_FRAME_BYTES) process.exitCode = 2
    let end: number
    while ((end = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, end)
      buffer = buffer.subarray(end + 1)
      const operation = Promise.resolve().then(async () => {
        const frame = record(JSON.parse(line.toString('utf8')) as unknown)
        const id = stringField(frame.id)
        const operationName = stringField(frame.operation)
        try {
          const result = await manager.invoke(operationName, frame.envelope)
          process.stdout.write(`${JSON.stringify({ id, result })}\n`)
        } catch (error: unknown) {
          const code = error instanceof ManagerError ? error.code : 'REMOTE_FAILURE'
          process.stdout.write(`${JSON.stringify({ id, error: { code } })}\n`)
        }
      }).catch(() => { process.exitCode = 2 }).finally(() => pending.delete(operation))
      pending.add(operation)
    }
  })
  process.stdin.once('end', () => { void shutdown().catch(() => { process.exitCode = 2 }) })
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exitCode = 143) })
  process.once('SIGINT', () => { void shutdown().finally(() => process.exitCode = 130) })
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch(() => { process.exitCode = 2 })
}
