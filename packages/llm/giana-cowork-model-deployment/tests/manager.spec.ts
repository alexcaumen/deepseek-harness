import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  GovernedModelRoute,
  ModelExecutionScope,
  ModelLifecycleStageContext,
  ResourceLeaseGrant,
} from '@deepseek-ai/dsh-model-lifecycle/src/index.ts'
import {
  ServerManagerModelLifecycleAdapter,
  type ServerManagerOperation,
  type ServerManagerTransport,
} from '@deepseek-ai/dsh-model-lifecycle-server-manager/src/index.ts'
import {
  parsePreviewManagerRegistry,
  PreviewManager,
  PreviewManagerStateStore,
  type PreviewManagerArguments,
  type PreviewManagerRemoteResult,
} from '../src/manager.ts'

const bare = (digit: string): string => digit.repeat(64)
const prefixed = (digit: string): string => `sha256:${bare(digit)}`
const targetIdentity = { identityDigest: bare('6'), currentnessDigest: bare('7') }
const temporaryPaths: string[] = []

class FakeRemote {
  residentPort: number | undefined
  modelsError: number | undefined
  probeError: number | undefined
  statusError: number | undefined
  stalePidFile = false
  telemetry: string | undefined
  processTable: string | undefined
  startError: number | undefined
  onTelemetry: (() => void) | undefined
  activeRequestCounts: number[] = []
  malformedDrain = false
  hostFence = 0
  hostLease: { id: string; fence: number; expiresAt: number } | undefined
  hostLeaseBusy = false
  systemdIdentityMismatch = false
  systemdMutationReceiptMissing = false
  dockerIdentityMismatch = false
  dockerMutationIdentityMismatch = false
  dockerMutationReceiptMissing = false
  scriptMutationIdentityMismatch = false
  scriptMutationReceiptMissing = false
  foreignHealthyPort: number | undefined
  lingeringListener = false
  freeVramMiB = new Map([[0, 42_000], [1, 46_000]])
  readonly commands: string[] = []

  readonly run = async (command: string): Promise<PreviewManagerRemoteResult> => {
    this.commands.push(command)
    if (command.includes("printf 'ACQUIRED %s %s %s")) {
      if (this.hostLeaseBusy || (this.hostLease !== undefined && this.hostLease.expiresAt > Date.now())) {
        return { code: 75, stdout: 'BUSY\n' }
      }
      const lease = /requested_lease='([a-f0-9]{64})'/u.exec(command)
      const ttl = /ttl_ms=(\d+)/u.exec(command)
      if (lease === null || ttl === null) return { code: 76, stdout: '' }
      const recovered = this.hostLease === undefined ? 0 : 1
      this.hostFence += 1
      this.hostLease = { id: lease[1]!, fence: this.hostFence, expiresAt: Date.now() + Number(ttl[1]) }
      return { code: 0, stdout: `ACQUIRED ${this.hostFence} ${this.hostLease.expiresAt} ${recovered}\n` }
    }
    if (command.includes("printf 'RENEWED %s")) {
      const ttl = /ttl_ms=(\d+)/u.exec(command)
      const lease = /expected_lease='([a-f0-9]{64})'/u.exec(command)
      const fence = /expected_fence=(\d+)/u.exec(command)
      if (this.hostLease === undefined || ttl === null || lease === null || fence === null
        || this.hostLease.id !== lease[1] || this.hostLease.fence !== Number(fence[1])) return { code: 76, stdout: '' }
      this.hostLease.expiresAt = Date.now() + Number(ttl[1])
      return { code: 0, stdout: `RENEWED ${this.hostLease.expiresAt}\n` }
    }
    if (command.includes("printf 'RELEASED")) {
      const lease = /expected_lease='([a-f0-9]{64})'/u.exec(command)
      const fence = /expected_fence=(\d+)/u.exec(command)
      if (this.hostLease === undefined || lease === null || fence === null
        || this.hostLease.id !== lease[1] || this.hostLease.fence !== Number(fence[1])) return { code: 76, stdout: '' }
      this.hostLease = undefined
      return { code: 0, stdout: 'RELEASED\n' }
    }
    if (command.includes("printf 'CURRENT")) {
      const lease = /expected_lease='([a-f0-9]{64})'/u.exec(command)
      const fence = /expected_fence=(\d+)/u.exec(command)
      return this.hostLease === undefined || lease === null || fence === null
        || this.hostLease.id !== lease[1] || this.hostLease.fence !== Number(fence[1])
        ? { code: 76, stdout: '' } : { code: 0, stdout: 'CURRENT\n' }
    }
    if (command.includes('MemAvailable')) {
      this.onTelemetry?.()
      const applications = this.residentPort === 18_081
        ? '123, GPU-1, 41000\n'
        : this.residentPort === 8_000
          ? '456, GPU-0, 36000\n456, GPU-1, 36000\n'
          : ''
      return {
        code: 0,
        stdout: this.telemetry
          ?? `MEM 838860800\nGPUS\n0, GPU-0, ${this.freeVramMiB.get(0)}\n1, GPU-1, ${this.freeVramMiB.get(1)}\nAPPS\n${applications}`,
      }
    }
    if (command.includes('/get_load')) {
      if (this.malformedDrain) return { code: 0, stdout: '{bad-json' }
      const active = this.activeRequestCounts.shift() ?? 0
      return { code: 0, stdout: JSON.stringify([{ num_reqs: active, num_waiting_reqs: 0 }]) }
    }
    if (command.includes('/metrics')) {
      if (this.malformedDrain) return { code: 0, stdout: 'not-vllm-metrics\n' }
      const active = this.activeRequestCounts.shift() ?? 0
      return {
        code: 0,
        stdout: `vllm:num_requests_running ${active}\nvllm:num_requests_waiting 0\n`,
      }
    }
    if (command.startsWith('command -v ss')) {
      const port = command.includes(':18081') ? 18_081 : command.includes(':8000') ? 8_000 : 0
      return this.lingeringListener || this.residentPort === port
        ? { code: 0, stdout: 'LISTENING\n' }
        : { code: 0, stdout: 'CLOSED\n' }
    }
    if (command === 'ps -eo pid=,pgid=,rss=') {
      const current = this.residentPort === 18_081
        ? '123 123 430080000\n'
        : this.residentPort === 8_000
          ? '456 456 65536000\n'
          : ''
      return { code: 0, stdout: this.processTable ?? `${current}5010 5010 102400\n` }
    }
    if (command.includes('GCP_DOCKER_MUTATION_APPLIED')) {
      if (this.dockerMutationIdentityMismatch) return { code: 76, stdout: '' }
      if (command.includes('docker start "$container_id"')) {
        if (this.startError !== undefined) return { code: this.startError, stdout: '' }
        this.residentPort = 8_000
        this.freeVramMiB.set(0, 6_000)
        this.freeVramMiB.set(1, 6_000)
      } else if (command.includes('docker stop --time 30 "$container_id"')) {
        this.residentPort = undefined
        this.freeVramMiB.set(0, 42_000)
        this.freeVramMiB.set(1, 46_000)
      } else return { code: 76, stdout: '' }
      return { code: 0, stdout: this.dockerMutationReceiptMissing ? '' : 'GCP_DOCKER_MUTATION_APPLIED\n' }
    }
    if (command.includes('GCP_SCRIPT_MUTATION_APPLIED')) {
      if (this.scriptMutationIdentityMismatch) return { code: 76, stdout: '' }
      if (command.includes('\n"$start_path"\n')) {
        if (this.startError !== undefined) return { code: this.startError, stdout: '' }
        this.residentPort = 18_081
        this.freeVramMiB.set(1, 4_000)
      } else if (command.includes('\n"$stop_path"\n')) {
        this.residentPort = undefined
        this.freeVramMiB.set(1, 46_000)
      } else return { code: 76, stdout: '' }
      return { code: 0, stdout: this.scriptMutationReceiptMissing ? '' : 'GCP_SCRIPT_MUTATION_APPLIED\n' }
    }
    if (command.includes('docker inspect')) {
      if (this.statusError !== undefined) return { code: this.statusError, stdout: '' }
      const containerId = this.dockerIdentityMismatch ? bare('9') : bare('d')
      const imageId = this.dockerIdentityMismatch ? prefixed('9') : prefixed('e')
      return {
        code: 0,
        stdout: `${containerId} ${imageId} /qwen38-vllm-server ${JSON.stringify({
          Running: this.residentPort === 8_000, Restarting: false, Paused: false,
          Pid: this.residentPort === 8_000 ? 456 : 0,
        })}\n`,
      }
    }
    if (command.includes('PIDFILE')) {
      if (this.statusError !== undefined) return { code: this.statusError, stdout: '' }
      return this.residentPort === 18_081
        ? { code: 0, stdout: this.stalePidFile
          ? 'PIDFILE MISMATCH 999\nMATCH 123 123\n'
          : 'PIDFILE MATCH 123 123\nMATCH 123 123\n' }
        : { code: 0, stdout: 'PIDFILE MISSING\n' }
    }
    if (command.includes('unique_groups=$(printf')) {
      if (this.statusError !== undefined) return { code: this.statusError, stdout: '' }
      if (this.systemdIdentityMismatch) return { code: 0, stdout: 'SYSTEMD UNKNOWN\n' }
      return this.residentPort === 18_081
        ? { code: 0, stdout: 'SYSTEMD RUNNING 123\n' }
        : { code: 0, stdout: 'SYSTEMD STOPPED\n' }
    }
    if (command.includes('ps -o pgid=')) return { code: 0, stdout: '456\n' }
    if (command.includes('/v1/models')) {
      if (this.modelsError !== undefined) return { code: this.modelsError, stdout: '' }
      const port = command.includes(':18081/') ? 18_081 : command.includes(':8000/') ? 8_000 : 0
      if (this.residentPort !== port && this.foreignHealthyPort !== port) return { code: 7, stdout: '' }
      const id = port === 18_081 ? 'GLM-5.3-Flash-official-fp8-canary' : 'Qwen/Qwen3.8-27B'
      return { code: 0, stdout: JSON.stringify({ data: [{ id }] }) }
    }
    if (command.includes('/v1/chat/completions')) {
      if (this.probeError !== undefined) return { code: this.probeError, stdout: '' }
      return this.residentPort === undefined && this.foreignHealthyPort === undefined
        ? { code: 7, stdout: '' }
        : { code: 0, stdout: JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) }
    }
    if (command.includes('start-glm')) {
      if (this.startError !== undefined) return { code: this.startError, stdout: '' }
      this.residentPort = 18_081
      this.freeVramMiB.set(1, 4_000)
      return { code: 0, stdout: '' }
    }
    if (command.includes('stop-glm')) {
      this.residentPort = undefined
      this.freeVramMiB.set(1, 46_000)
      return { code: 0, stdout: '' }
    }
    if (command.includes('systemd-run --unit="$unit"')) {
      if (this.startError !== undefined) return { code: this.startError, stdout: '' }
      this.residentPort = 18_081
      this.freeVramMiB.set(1, 4_000)
      return { code: 0, stdout: this.systemdMutationReceiptMissing ? '' : 'Running as unit.\nGCP_SYSTEMD_MUTATION_APPLIED\n' }
    }
    if (command.includes('systemctl stop "$unit"')) {
      this.residentPort = undefined
      this.freeVramMiB.set(1, 46_000)
      return { code: 0, stdout: this.systemdMutationReceiptMissing ? '' : 'GCP_SYSTEMD_MUTATION_APPLIED\n' }
    }
    if (command.includes('docker start')) {
      this.residentPort = 8_000
      this.freeVramMiB.set(0, 6_000)
      this.freeVramMiB.set(1, 6_000)
      return { code: 0, stdout: '' }
    }
    if (command.includes('docker stop')) {
      this.residentPort = undefined
      this.freeVramMiB.set(0, 42_000)
      this.freeVramMiB.set(1, 46_000)
      return { code: 0, stdout: '' }
    }
    return { code: 127, stdout: '' }
  }
}

function scriptRuntime(): Record<string, unknown> {
  return {
    kind: 'script', startPath: '/opt/start-glm.sh', stopPath: '/opt/stop-glm.sh',
    startSha256: bare('8'), stopSha256: bare('9'),
    pidFile: '/opt/glm.pid', processMarker: 'GLM-5.3-Flash-official-fp8-canary',
    remotePort: 18_081, expectedModel: 'GLM-5.3-Flash-official-fp8-canary',
    drain: { kind: 'sglang-load', path: '/get_load', pollIntervalMs: 1 },
    release: { pollIntervalMs: 1, maximumSamples: 6 },
  }
}

function systemdRuntime(): Record<string, unknown> {
  return {
    kind: 'systemd', unit: 'gcp-glm53-official-fp8-preview-r1.service',
    launcherPath: '/opt/gcp/launcher-context64k.sh', launcherSha256: bare('c'),
    processMarker: 'GLM-5.3-Flash-official-fp8-canary', remotePort: 18_081,
    expectedModel: 'GLM-5.3-Flash-official-fp8-canary',
    drain: { kind: 'sglang-load', path: '/get_load', pollIntervalMs: 1 },
    release: { pollIntervalMs: 1, maximumSamples: 6 },
  }
}

function registry(glmRuntime: Record<string, unknown> = scriptRuntime()) {
  return parsePreviewManagerRegistry({
    schema: 'giana.cowork.preview.model-registry.v1',
    issuerRef: `giana:issuer:sha256:${bare('1')}`,
    holderRef: `giana:holder:sha256:${bare('2')}`,
    admissionDigest: bare('3'),
    renewAfterMs: 10_000,
    slot: {
      id: 'gcp-slot-01', lockPath: '/run/lock/gcp-slot.state.lock',
      operationLockPath: '/run/lock/gcp-slot.operation.lock',
      statePath: '/var/lib/gcp-slot/state', counterPath: '/var/lib/gcp-slot/counter',
    },
    targets: [{ class: 'r5300', identity_digest: bare('6'), currentness_digest: bare('7') }],
    routes: [
      {
        id: 'glm-official', revisionDigest: bare('a'), target: 'r5300', exclusiveEndpoint: true,
        runtime: glmRuntime,
        resources: {
          gpuIndices: [1], minimumFreeVramMiB: { 1: 35_000 }, reclaimableVramMiB: { 1: 41_000 },
          minimumFreeRamMiB: 420_000, reclaimableRamMiB: 420_000,
        },
      },
      {
        id: 'qwen-local', revisionDigest: bare('b'), target: 'r5300', exclusiveEndpoint: true,
        runtime: {
          kind: 'docker', container: 'qwen38-vllm-server', containerId: bare('d'), imageId: prefixed('e'),
          remotePort: 8_000,
          expectedModel: 'Qwen/Qwen3.8-27B',
          drain: { kind: 'vllm-metrics', path: '/metrics', pollIntervalMs: 1 },
          release: { pollIntervalMs: 1, maximumSamples: 6 },
        },
        resources: {
          gpuIndices: [0, 1], minimumFreeVramMiB: { 0: 36_000, 1: 36_000 },
          reclaimableVramMiB: { 0: 36_000, 1: 36_000 }, minimumFreeRamMiB: 64_000, reclaimableRamMiB: 64_000,
        },
      },
    ],
  })
}

async function fixture(remote: FakeRemote, configuredRegistry = registry()) {
  const directory = await mkdtemp(join(tmpdir(), 'gcp-manager-'))
  temporaryPaths.push(directory)
  const statePath = join(directory, 'state.json')
  const store = new PreviewManagerStateStore(statePath)
  await store.load()
  const args: PreviewManagerArguments = {
    registryPath: join(directory, 'registry.json'), statePath,
    sshExecutable: process.execPath, sshConfigPath: join(directory, 'ssh-config'), sshHost: 'test-host',
  }
  const manager = new PreviewManager(configuredRegistry, store, args, remote.run)
  const transport: ServerManagerTransport = {
    invoke: (operation: ServerManagerOperation, request) => manager.invoke(operation, request),
  }
  let key = 0
  const adapter = new ServerManagerModelLifecycleAdapter({
    transport, targets: { r5300: targetIdentity },
    issuerRef: `giana:issuer:sha256:${bare('1')}`,
    holderRef: `giana:holder:sha256:${bare('2')}`,
    admissionDigest: bare('3'), leaseTtlMs: 60_000,
    operationTimeoutMs: 30_000, maxClockSkewMs: 1_000,
    idempotencyKey: () => (++key).toString(16).padStart(64, '0'),
  })
  return { adapter, args, manager, statePath, store }
}

function route(id: 'glm-official' | 'qwen-local'): GovernedModelRoute {
  return id === 'glm-official'
    ? {
      id, selection: { provider: 'glm-local-r5300', model: 'GLM-5.3-Flash-official-fp8-canary' },
      disposition: 'AVAILABLE', admissionReceiptDigest: prefixed('c'), revisionDigest: prefixed('a'),
      targets: ['r5300'], allowRamCpuOffload: false,
    }
    : {
      id, selection: { provider: 'qwen-local-r5300', model: 'Qwen/Qwen3.8-27B' },
      disposition: 'AVAILABLE', admissionReceiptDigest: prefixed('d'), revisionDigest: prefixed('b'),
      targets: ['r5300'], allowRamCpuOffload: false,
    }
}

function scope(): ModelExecutionScope {
  return {
    workId: 'work', principalId: 'alex', tenantId: 'giana', sessionId: 'session', digest: prefixed('e'),
  }
}

function context(grant: ResourceLeaseGrant, selected: GovernedModelRoute, transaction: string): ModelLifecycleStageContext {
  return {
    route: selected, target: 'r5300', scope: scope(), transactionKind: 'MODEL_ROUTE',
    transactionDigest: prefixed(transaction), resourceLease: grant,
    deadlineAt: Date.now() + 30_000, signal: new AbortController().signal,
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Giana CoWork Preview model manager', () => {
  it.each([7, 22, 28, 124, 255])('does not treat process ownership failure %i as free resources', async (code) => {
    const remote = new FakeRemote()
    remote.statusError = code
    const { adapter } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    await expect(adapter.preflight(context(grant, route('glm-official'), 'f'))).resolves.toMatchObject({ ok: false })
    expect(remote.commands.some(command => command.includes('start-glm'))).toBe(false)
  })

  it('recognizes a booting owned process as resident when its HTTP endpoint is unavailable', async () => {
    const remote = new FakeRemote()
    remote.residentPort = 18_081
    remote.modelsError = 7
    const { adapter } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const ctx = context(grant, route('glm-official'), 'f')
    await expect(adapter.preflight(ctx)).resolves.toMatchObject({ ok: true })
    await expect(adapter.capturePrestate(ctx)).resolves.toMatchObject({
      residency: { kind: 'RESIDENT', routeId: 'glm-official' },
    })
    await expect(adapter.health(ctx)).resolves.toMatchObject({ ok: false })
    await expect(adapter.release(grant, 'SETTLED', new AbortController().signal)).resolves.toBeUndefined()
    expect(remote.residentPort).toBe(18_081)
    expect(remote.hostLease).toBeUndefined()
    expect(remote.commands.some(command => command.includes('stop-glm'))).toBe(false)
  })

  it('recognizes an exact orphan process when the PID file is stale', async () => {
    const remote = new FakeRemote()
    remote.residentPort = 18_081
    remote.stalePidFile = true
    const { adapter } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const ctx = context(grant, route('glm-official'), 'f')
    await expect(adapter.preflight(ctx)).resolves.toMatchObject({ ok: true })
    await expect(adapter.capturePrestate(ctx)).resolves.toMatchObject({
      residency: { kind: 'RESIDENT', routeId: 'glm-official' },
    })
  })

  it('recognizes an exact systemd-owned GLM process group', async () => {
    const remote = new FakeRemote()
    remote.residentPort = 18_081
    const { adapter } = await fixture(remote, registry(systemdRuntime()))
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const ctx = context(grant, route('glm-official'), 'f')

    await expect(adapter.preflight(ctx)).resolves.toMatchObject({ ok: true })
    await expect(adapter.capturePrestate(ctx)).resolves.toMatchObject({
      residency: { kind: 'RESIDENT', routeId: 'glm-official' },
    })
  })

  it('fails closed when systemd unit, launcher, cgroup, or marker identity does not match', async () => {
    const remote = new FakeRemote()
    remote.residentPort = 18_081
    remote.systemdIdentityMismatch = true
    const { adapter } = await fixture(remote, registry(systemdRuntime()))
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)

    await expect(adapter.preflight(context(grant, route('glm-official'), 'f'))).resolves.toMatchObject({ ok: false })
    expect(remote.commands.some(command => command.includes('systemctl stop "$unit"'))).toBe(false)
  })

  it('rejects an invalid systemd launcher digest during registry parsing', () => {
    expect(() => registry({ ...systemdRuntime(), launcherSha256: 'not-a-digest' })).toThrow('INVALID_REQUEST')
  })

  it('rejects overlapping host slot control paths during registry parsing', () => {
    const parsed = registry()
    expect(() => parsePreviewManagerRegistry({
      ...parsed,
      slot: { ...parsed.slot, operationLockPath: parsed.slot.lockPath },
    })).toThrow('INVALID_REQUEST')
  })

  it('fails closed when the registered Docker identity does not match', async () => {
    const remote = new FakeRemote()
    remote.dockerIdentityMismatch = true
    const { adapter } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)

    await expect(adapter.preflight(context(grant, route('qwen-local'), 'f')))
      .resolves.toMatchObject({ ok: false })
    expect(remote.commands.some(command => command.includes('GCP_DOCKER_MUTATION_APPLIED'))).toBe(false)
  })

  it.each([
    'MEM 838860800\nGPUS\n0, GPU-0, 42000\nAPPS\n',
    'MEM 838860800\nGPUS\n0, GPU-0, 42000\n1, GPU-1, 4000\n1, GPU-2, 42000\nAPPS\n',
  ])
  ('rejects missing or duplicate GPU telemetry even with reclaimable VRAM', async (telemetry) => {
    const remote = new FakeRemote()
    remote.residentPort = 18_081
    remote.telemetry = telemetry
    const { adapter } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    await expect(adapter.preflight(context(grant, route('qwen-local'), 'f'))).resolves.toMatchObject({ ok: false })
    expect(remote.commands.some(command => command.includes('stop-glm'))).toBe(false)
  })

  it('does not treat configured reclaim ceilings as measured resources', async () => {
    const remote = new FakeRemote()
    remote.residentPort = 18_081
    remote.telemetry = 'MEM 838860800\nGPUS\n0, GPU-0, 42000\n1, GPU-1, 4000\nAPPS\n123, GPU-1, 100\n'
    const { adapter } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)

    await expect(adapter.preflight(context(grant, route('qwen-local'), 'f'))).resolves.toMatchObject({ ok: false })
    expect(remote.commands.some(command => command.includes('stop-glm'))).toBe(false)
  })

  it('fails closed when a GPU application is absent from the process snapshot', async () => {
    const remote = new FakeRemote()
    remote.residentPort = 18_081
    remote.processTable = '5010 5010 102400\n'
    const { adapter } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)

    await expect(adapter.preflight(context(grant, route('qwen-local'), 'f'))).resolves.toMatchObject({ ok: false })
    expect(remote.commands.some(command => command.includes('stop-glm'))).toBe(false)
  })

  it('rechecks free capacity at start after a successful preflight', async () => {
    const remote = new FakeRemote()
    const { adapter } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const ctx = context(grant, route('glm-official'), 'f')
    await adapter.preflight(ctx)
    await adapter.capturePrestate(ctx)
    remote.freeVramMiB.set(1, 100)
    await expect(adapter.start(ctx)).rejects.toThrow()
    expect(remote.commands.some(command => command.includes('start-glm'))).toBe(false)
  })

  it('shares one absolute deadline across all capacity subchecks', async () => {
    const remote = new FakeRemote()
    const startedAt = Date.now()
    remote.onTelemetry = () => { vi.spyOn(Date, 'now').mockReturnValue(startedAt + 45_000) }
    const { adapter } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)

    await expect(adapter.preflight(context(grant, route('glm-official'), 'f'))).rejects.toThrow()
    expect(remote.commands.some(command => command === 'ps -eo pid=,pgid=,rss=')).toBe(false)
    expect(remote.commands.some(command => command.includes('start-glm') || command.includes('stop-glm'))).toBe(false)
  })

  it('keeps an uncertain mutation quarantined even after a settled release request', async () => {
    const remote = new FakeRemote()
    remote.startError = 255
    const { adapter, manager, statePath } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const ctx = context(grant, route('glm-official'), 'f')
    await adapter.preflight(ctx)
    await adapter.capturePrestate(ctx)
    await expect(adapter.start(ctx)).rejects.toThrow()
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    const released = await manager.invoke('release', {
      idempotency_key: bare('8'), lease_id: state.lease.leaseId, fence: state.lease.fence, outcome: 'SETTLED',
    })
    expect(released.state).toBe('QUARANTINED')
    expect(JSON.parse(await readFile(statePath, 'utf8')).lease.quarantined).toBe(true)
    await expect(manager.invoke('begin', {
      idempotency_key: bare('9'), lease_id: state.lease.leaseId, fence: state.lease.fence,
      transaction_digest: bare('a'), scope_digest: bare('e'), transaction_kind: 'MODEL_ROUTE',
    })).rejects.toThrow('LEASE_MISMATCH')
  })

  it('preserves unresolved ownership when the lease expires during a stage', async () => {
    const remote = new FakeRemote()
    const { adapter, manager, statePath } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const future = Date.now() + 120_000
    remote.onTelemetry = () => { vi.spyOn(Date, 'now').mockReturnValue(future) }
    await expect(adapter.preflight(context(grant, route('glm-official'), 'f'))).rejects.toThrow()
    expect(JSON.parse(await readFile(statePath, 'utf8')).lease.quarantined).toBe(true)
    await expect(manager.invoke('acquire', {
      idempotency_key: bare('8'), ttl_ms: 60_000, targets: registry().targets,
    })).rejects.toThrow('BUSY')
  })

  it('rejects a second transaction while the first remains unsettled', async () => {
    const remote = new FakeRemote()
    const { adapter, manager, statePath } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    await adapter.preflight(context(grant, route('glm-official'), 'f'))
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    await expect(manager.invoke('begin', {
      idempotency_key: bare('8'), lease_id: state.lease.leaseId, fence: state.lease.fence,
      transaction_digest: bare('a'), scope_digest: bare('e'), transaction_kind: 'MODEL_ROUTE',
    })).rejects.toThrow('BUSY')
  })

  it('rejects a stage target identity outside its lease before dispatch', async () => {
    const remote = new FakeRemote()
    const { adapter, manager, statePath } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    await adapter.preflight(context(grant, route('glm-official'), 'f'))
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    const count = remote.commands.length
    await expect(manager.invoke('stage', {
      idempotency_key: bare('8'), lease_id: state.lease.leaseId, fence: state.lease.fence,
      transaction_digest: bare('f'), stage: 'prestate', route_id: 'glm-official', exact_revision_digest: bare('a'),
      target: { ...registry().targets[0], identity_digest: bare('9') }, timeout_ms: 30_000,
    })).rejects.toThrow('LEASE_MISMATCH')
    expect(remote.commands).toHaveLength(count)
  })

  it('does not replay an in-memory success after persistence fails', async () => {
    const { manager, store } = await fixture(new FakeRemote())
    Object.defineProperty(store, 'writeState', {
      value: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) },
    })
    const request = { idempotency_key: bare('8'), ttl_ms: 60_000, targets: registry().targets }
    await expect(manager.invoke('acquire', request)).rejects.toThrow()
    await expect(manager.invoke('acquire', request)).rejects.toThrow('STATE_CONFLICT')
  })

  it('rejects a nested transaction state that disagrees with its allowed routes', async () => {
    const remote = new FakeRemote()
    const { adapter, statePath } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    await adapter.preflight(context(grant, route('glm-official'), 'f'))
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    state.transactions[bare('f')].allowedRoutes = { stop: ['qwen-local'] }
    await writeFile(statePath, `${JSON.stringify(state)}\n`, 'utf8')
    const restarted = new PreviewManagerStateStore(statePath)

    await expect(restarted.load()).rejects.toThrow('STATE_CONFLICT')
  })

  it.each([
    ['recovery', true],
    ['lastStoppedRouteId', 'glm-official'],
    ['nextAllowed', ['stop']],
  ])('rejects a mutation-capable adopted resident state via %s', async (field, value) => {
    const remote = new FakeRemote()
    remote.residentPort = 18_081
    const { adapter, statePath } = await fixture(remote, registry(systemdRuntime()))
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const ctx = context(grant, route('glm-official'), 'f')
    await adapter.preflight(ctx)
    await adapter.capturePrestate(ctx)
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    const transaction = state.transactions[bare('f')]
    transaction[field] = value
    if (field === 'nextAllowed') transaction.allowedRoutes = { stop: ['glm-official'] }
    await writeFile(statePath, `${JSON.stringify(state)}\n`, 'utf8')

    await expect(new PreviewManagerStateStore(statePath).load()).rejects.toThrow('STATE_CONFLICT')
  })

  it('rejects an adopted resident state when its adoption marker is removed', async () => {
    const remote = new FakeRemote()
    remote.residentPort = 18_081
    const { adapter, statePath } = await fixture(remote, registry(systemdRuntime()))
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const ctx = context(grant, route('glm-official'), 'f')
    await adapter.preflight(ctx)
    await adapter.capturePrestate(ctx)
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      transactions: Record<string, Record<string, unknown>>
    }
    const transaction = state.transactions[bare('f')]
    expect(transaction).toBeDefined()
    delete transaction!.adoptedResidentRouteId
    transaction!.nextAllowed = ['stop']
    transaction!.allowedRoutes = { stop: ['glm-official'] }
    await writeFile(statePath, `${JSON.stringify(state)}\n`, 'utf8')

    await expect(new PreviewManagerStateStore(statePath).load()).rejects.toThrow('STATE_CONFLICT')
  })

  it('rejects malformed durable JSON rather than silently starting empty', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gcp-manager-corrupt-'))
    temporaryPaths.push(directory)
    const statePath = join(directory, 'state.json')
    await writeFile(statePath, '{not-json', 'utf8')

    await expect(new PreviewManagerStateStore(statePath).load()).rejects.toThrow('STATE_CONFLICT')
  })

  it('binds a completed idempotency key to the exact request', async () => {
    const { manager } = await fixture(new FakeRemote())
    const request = { idempotency_key: bare('8'), ttl_ms: 60_000, targets: registry().targets }
    const first = await manager.invoke('acquire', request)
    await expect(manager.invoke('acquire', request)).resolves.toEqual(first)
    await expect(manager.invoke('acquire', { ...request, ttl_ms: 70_000 })).rejects.toThrow('STATE_CONFLICT')
  })

  it('executes one lease acquisition for concurrent retries across manager instances', async () => {
    const remote = new FakeRemote()
    const { args, manager, statePath } = await fixture(remote)
    const secondStore = new PreviewManagerStateStore(statePath)
    await secondStore.load()
    const second = new PreviewManager(registry(), secondStore, args, remote.run)
    const request = { idempotency_key: bare('8'), ttl_ms: 60_000, targets: registry().targets }
    const results = await Promise.allSettled([manager.invoke('acquire', request), second.invoke('acquire', request)])
    const fulfilled = results.filter(result => result.status === 'fulfilled').map(result => result.value)
    expect(fulfilled.length).toBeGreaterThan(0)
    expect(new Set(fulfilled.map(result => result.lease_id))).toHaveLength(1)
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ message: 'BUSY' })
    }
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    expect(state.nextFence).toBe(2)
    expect(state.replay).toHaveLength(1)
    expect(state.replay[0]).toMatchObject({ status: 'COMPLETE' })
  })

  it('uses the host slot lease to fence managers with independent local state', async () => {
    const remote = new FakeRemote()
    const first = await fixture(remote)
    const second = await fixture(remote)
    const firstGrant = await first.adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)

    await expect(second.adapter.acquire({ targets: ['r5300'] }, new AbortController().signal))
      .rejects.toThrow()
    expect(remote.hostFence).toBe(1)

    await first.adapter.release(firstGrant, 'SETTLED', new AbortController().signal)
    await expect(second.adapter.acquire({ targets: ['r5300'] }, new AbortController().signal))
      .resolves.toMatchObject({
        leaseRef: expect.any(String),
        fencingDigest: expect.any(String),
      })
    expect(remote.hostFence).toBe(2)
  })

  it('does not let a stale local holder mutate or release after host-lease takeover', async () => {
    const remote = new FakeRemote()
    const first = await fixture(remote)
    const grant = await first.adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    remote.hostFence += 1
    remote.hostLease = { id: bare('f'), fence: remote.hostFence, expiresAt: Date.now() + 60_000 }

    await expect(first.adapter.preflight(context(grant, route('glm-official'), 'e'))).rejects.toThrow()
    await expect(first.adapter.release(grant, 'SETTLED', new AbortController().signal)).rejects.toThrow()
    expect(remote.hostLease).toMatchObject({ id: bare('f'), fence: 2 })
    expect(remote.commands.some(command => command.includes('\n"$start_path"\n'))).toBe(false)
  })

  it('cold-loads GLM through validated lifecycle receipts without touching DOTS', async () => {
    const remote = new FakeRemote()
    const { adapter } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const ctx = context(grant, route('glm-official'), 'f')

    await expect(adapter.preflight(ctx)).resolves.toMatchObject({ ok: true })
    await expect(adapter.capturePrestate(ctx)).resolves.toMatchObject({ residency: { kind: 'EMPTY' } })
    await expect(adapter.start(ctx)).resolves.toMatchObject({ stage: 'start' })
    await expect(adapter.health(ctx)).resolves.toMatchObject({ ok: true })
    await expect(adapter.probe(ctx)).resolves.toMatchObject({ ok: true })
    await adapter.release(grant, 'SETTLED', new AbortController().signal)

    expect(remote.residentPort).toBe(18_081)
    expect(remote.commands.some(command => command.includes('17302'))).toBe(false)
  })

  it('adopts an exact resident GLM through health and probe without a start or stop mutation', async () => {
    const remote = new FakeRemote()
    remote.residentPort = 18_081
    const { adapter } = await fixture(remote, registry(systemdRuntime()))
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const ctx = context(grant, route('glm-official'), 'f')

    await expect(adapter.preflight(ctx)).resolves.toMatchObject({ ok: true })
    await expect(adapter.capturePrestate(ctx)).resolves.toMatchObject({
      residency: { kind: 'RESIDENT', routeId: 'glm-official' },
    })
    await expect(adapter.health(ctx)).resolves.toMatchObject({ ok: true })
    await expect(adapter.probe(ctx)).resolves.toMatchObject({ ok: true })
    await expect(adapter.release(grant, 'SETTLED', new AbortController().signal)).resolves.toBeUndefined()

    expect(remote.residentPort).toBe(18_081)
    expect(remote.hostLease).toBeUndefined()
    expect(remote.commands.some(command => command.includes('systemd-run --unit="$unit"'))).toBe(false)
    expect(remote.commands.some(command => command.includes('systemctl stop "$unit"'))).toBe(false)
  })

  it('accepts repeated exact-resident health and probe transactions without becoming busy', async () => {
    const remote = new FakeRemote()
    remote.residentPort = 18_081
    const { adapter } = await fixture(remote, registry(systemdRuntime()))
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)

    for (const transaction of ['f', 'e']) {
      const ctx = context(grant, route('glm-official'), transaction)
      await expect(adapter.preflight(ctx)).resolves.toMatchObject({ ok: true })
      await expect(adapter.capturePrestate(ctx)).resolves.toMatchObject({
        residency: { kind: 'RESIDENT', routeId: 'glm-official' },
      })
      await expect(adapter.health(ctx)).resolves.toMatchObject({ ok: true })
      await expect(adapter.probe(ctx)).resolves.toMatchObject({ ok: true })
    }
    await expect(adapter.release(grant, 'SETTLED', new AbortController().signal)).resolves.toBeUndefined()

    expect(remote.residentPort).toBe(18_081)
    expect(remote.hostLease).toBeUndefined()
  })

  it('leaves an adopted resident GLM unchanged when its capability probe fails', async () => {
    const remote = new FakeRemote()
    remote.residentPort = 18_081
    remote.probeError = 7
    const { adapter } = await fixture(remote, registry(systemdRuntime()))
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const ctx = context(grant, route('glm-official'), 'f')

    await expect(adapter.preflight(ctx)).resolves.toMatchObject({ ok: true })
    await expect(adapter.capturePrestate(ctx)).resolves.toMatchObject({
      residency: { kind: 'RESIDENT', routeId: 'glm-official' },
    })
    await expect(adapter.health(ctx)).resolves.toMatchObject({ ok: true })
    await expect(adapter.probe(ctx)).resolves.toMatchObject({ ok: false })
    await expect(adapter.release(grant, 'SETTLED', new AbortController().signal)).resolves.toBeUndefined()

    expect(remote.residentPort).toBe(18_081)
    expect(remote.hostLease).toBeUndefined()
    expect(remote.commands.some(command => command.includes('systemd-run --unit="$unit"'))).toBe(false)
    expect(remote.commands.some(command => command.includes('systemctl stop "$unit"'))).toBe(false)
  })

  it('switches from GLM to Qwen only after drain, stop, and verified release', async () => {
    const remote = new FakeRemote()
    const { adapter } = await fixture(remote, registry(systemdRuntime()))
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const glm = context(grant, route('glm-official'), 'f')
    await adapter.preflight(glm)
    await adapter.capturePrestate(glm)
    await adapter.start(glm)
    await adapter.health(glm)
    await adapter.probe(glm)

    const qwen = context(grant, route('qwen-local'), '9')
    await expect(adapter.preflight(qwen)).resolves.toMatchObject({ ok: true })
    await expect(adapter.capturePrestate(qwen)).resolves.toMatchObject({ residency: { kind: 'RESIDENT', routeId: 'glm-official' } })
    await adapter.drain({ ...glm, transactionDigest: qwen.transactionDigest, nextRoute: qwen.route, nextTarget: 'r5300' })
    await adapter.stop({ ...glm, transactionDigest: qwen.transactionDigest })
    await adapter.verifyStopped({ ...glm, transactionDigest: qwen.transactionDigest })
    await adapter.start(qwen)
    await adapter.health(qwen)
    await adapter.probe(qwen)
    await adapter.release(grant, 'SETTLED', new AbortController().signal)

    expect(remote.residentPort).toBe(8_000)
    const stopIndex = remote.commands.findIndex(command => command.includes('systemctl stop "$unit"'))
    const startIndex = remote.commands.findIndex(command => command.includes('docker start'))
    expect(remote.commands.filter(command => command.includes('/get_load'))).toHaveLength(3)
    expect(remote.commands.filter(command => command.startsWith('command -v ss') && command.includes(':18081'))).toHaveLength(3)
    expect(stopIndex).toBeGreaterThan(-1)
    expect(startIndex).toBeGreaterThan(stopIndex)
  })

  it('quarantines the lease when the stopped source port still listens', async () => {
    const remote = new FakeRemote()
    remote.residentPort = 18_081
    remote.freeVramMiB.set(1, 4_000)
    const { adapter, manager, statePath } = await fixture(remote, registry(systemdRuntime()))
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const glm = context(grant, route('glm-official'), '9')
    const qwen = context(grant, route('qwen-local'), '9')
    await adapter.preflight(qwen)
    await adapter.capturePrestate(qwen)
    await adapter.drain({ ...glm, nextRoute: qwen.route, nextTarget: 'r5300' })
    await adapter.stop(glm)
    remote.lingeringListener = true

    await expect(adapter.verifyStopped(glm)).rejects.toThrow()
    expect(remote.commands.some(command => command.includes('docker start'))).toBe(false)
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    expect(state.lease.quarantined).toBe(true)
    const released = await manager.invoke('release', {
      idempotency_key: bare('8'), lease_id: state.lease.leaseId, fence: state.lease.fence, outcome: 'SETTLED',
    })
    expect(released.state).toBe('QUARANTINED')
    await expect(manager.invoke('acquire', {
      idempotency_key: bare('7'), ttl_ms: 60_000, targets: registry().targets,
    })).rejects.toThrow('BUSY')
  })

  it('quarantines a script start when an admitted script hash changes at mutation time', async () => {
    const remote = new FakeRemote()
    const { adapter, statePath } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const glm = context(grant, route('glm-official'), 'f')
    await adapter.preflight(glm)
    await adapter.capturePrestate(glm)
    remote.scriptMutationIdentityMismatch = true

    await expect(adapter.start(glm)).rejects.toThrow()
    expect(remote.residentPort).toBeUndefined()
    expect(JSON.parse(await readFile(statePath, 'utf8')).lease.quarantined).toBe(true)
  })

  it('rejects a healthy foreign endpoint when the managed process is absent', async () => {
    const remote = new FakeRemote()
    const { adapter } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const glm = context(grant, route('glm-official'), 'f')
    await adapter.preflight(glm)
    await adapter.capturePrestate(glm)
    await adapter.start(glm)
    await expect(adapter.health(glm)).resolves.toMatchObject({ ok: true })
    remote.residentPort = undefined
    remote.foreignHealthyPort = 18_081

    await expect(adapter.probe(glm)).resolves.toMatchObject({ ok: false })
  })

  it('quarantines a systemd start that returns no mutation receipt', async () => {
    const remote = new FakeRemote()
    remote.systemdMutationReceiptMissing = true
    const { adapter, statePath } = await fixture(remote, registry(systemdRuntime()))
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const glm = context(grant, route('glm-official'), 'f')
    await adapter.preflight(glm)
    await adapter.capturePrestate(glm)

    await expect(adapter.start(glm)).rejects.toThrow()
    expect(JSON.parse(await readFile(statePath, 'utf8')).lease.quarantined).toBe(true)
  })

  it('quarantines a Docker start when identity changes inside the fenced mutation', async () => {
    const remote = new FakeRemote()
    const { adapter, statePath } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const qwen = context(grant, route('qwen-local'), 'f')
    await adapter.preflight(qwen)
    await adapter.capturePrestate(qwen)
    remote.dockerMutationIdentityMismatch = true

    await expect(adapter.start(qwen)).rejects.toThrow()
    expect(remote.residentPort).toBeUndefined()
    expect(JSON.parse(await readFile(statePath, 'utf8')).lease.quarantined).toBe(true)
  })

  it('quarantines a Docker start that returns no mutation receipt', async () => {
    const remote = new FakeRemote()
    remote.dockerMutationReceiptMissing = true
    const { adapter, statePath } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const qwen = context(grant, route('qwen-local'), 'f')
    await adapter.preflight(qwen)
    await adapter.capturePrestate(qwen)

    await expect(adapter.start(qwen)).rejects.toThrow()
    expect(JSON.parse(await readFile(statePath, 'utf8')).lease.quarantined).toBe(true)
  })

  it('requires three consecutive zero active-request samples before stopping a resident route', async () => {
    const remote = new FakeRemote()
    remote.residentPort = 18_081
    remote.freeVramMiB.set(1, 4_000)
    remote.activeRequestCounts = [2, 0, 0, 0]
    const { adapter } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const glm = context(grant, route('glm-official'), '9')
    const qwen = context(grant, route('qwen-local'), '9')
    await adapter.preflight(qwen)
    await adapter.capturePrestate(qwen)

    await expect(adapter.drain({ ...glm, nextRoute: qwen.route, nextTarget: 'r5300' }))
      .resolves.toMatchObject({ stage: 'drain' })
    expect(remote.commands.filter(command => command.includes('/get_load'))).toHaveLength(4)
    expect(remote.commands.some(command => command.includes('stop-glm'))).toBe(false)
  })

  it('keeps the resident route running when active-request telemetry is unavailable', async () => {
    const remote = new FakeRemote()
    remote.residentPort = 18_081
    remote.freeVramMiB.set(1, 4_000)
    remote.malformedDrain = true
    const { adapter } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const glm = context(grant, route('glm-official'), '9')
    const qwen = context(grant, route('qwen-local'), '9')
    await adapter.preflight(qwen)
    await adapter.capturePrestate(qwen)

    await expect(adapter.drain({ ...glm, nextRoute: qwen.route, nextTarget: 'r5300' })).rejects.toThrow()
    expect(remote.commands.some(command => command.includes('stop-glm'))).toBe(false)
    expect(remote.residentPort).toBe(18_081)
  })

  it('rejects stopping the destination route before the resident source is drained', async () => {
    const remote = new FakeRemote()
    remote.residentPort = 18_081
    remote.freeVramMiB.set(1, 4_000)
    const { adapter } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const glm = context(grant, route('glm-official'), '9')
    const qwen = context(grant, route('qwen-local'), '9')
    await adapter.preflight(qwen)
    await adapter.capturePrestate(qwen)
    const count = remote.commands.length

    await expect(adapter.stop(qwen)).rejects.toThrow()
    expect(remote.commands).toHaveLength(count)
    await adapter.drain({ ...glm, nextRoute: qwen.route, nextTarget: 'r5300' })
    await expect(adapter.stop(glm)).resolves.toMatchObject({ stage: 'stop', routeId: 'glm-official' })
  })

  it('cleans up a failed destination and restores only the recorded source route', async () => {
    const remote = new FakeRemote()
    remote.residentPort = 18_081
    remote.freeVramMiB.set(1, 4_000)
    const { adapter } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const glm = context(grant, route('glm-official'), '9')
    const qwen = context(grant, route('qwen-local'), '9')
    await adapter.preflight(qwen)
    await adapter.capturePrestate(qwen)
    await adapter.drain({ ...glm, nextRoute: qwen.route, nextTarget: 'r5300' })
    await adapter.stop(glm)
    await adapter.verifyStopped(glm)
    await adapter.start(qwen)
    remote.modelsError = 7
    await expect(adapter.health(qwen)).resolves.toMatchObject({ ok: false })
    remote.modelsError = undefined

    await adapter.stop(qwen)
    await adapter.verifyStopped(qwen)
    await adapter.start(glm)
    await expect(adapter.health(glm)).resolves.toMatchObject({ ok: true })
    await expect(adapter.probe(glm)).resolves.toMatchObject({ ok: true })
    await adapter.release(grant, 'SETTLED', new AbortController().signal)

    expect(remote.residentPort).toBe(18_081)
    const stopTarget = remote.commands.findIndex(command => command.includes('docker stop'))
    const restoreSource = remote.commands.findIndex(command => command.includes('\n"$start_path"\n'))
    expect(stopTarget).toBeGreaterThan(-1)
    expect(restoreSource).toBeGreaterThan(stopTarget)
  })

  it('settles cleanup after a definite cold-start rejection with no previous route', async () => {
    const remote = new FakeRemote()
    const { adapter, statePath } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const glm = context(grant, route('glm-official'), 'f')
    await adapter.preflight(glm)
    await adapter.capturePrestate(glm)
    remote.freeVramMiB.set(1, 100)
    await expect(adapter.start(glm)).rejects.toThrow()
    await adapter.stop(glm)
    await adapter.verifyStopped(glm)
    await adapter.release(grant, 'SETTLED', new AbortController().signal)

    expect(JSON.parse(await readFile(statePath, 'utf8')).lease).toBeUndefined()
    expect(remote.residentPort).toBeUndefined()
  })

  it('reports unavailable capacity without stopping or starting a model', async () => {
    const remote = new FakeRemote()
    remote.freeVramMiB = new Map([[0, 100], [1, 100]])
    const { adapter } = await fixture(remote)
    const grant = await adapter.acquire({ targets: ['r5300'] }, new AbortController().signal)
    const qwen = context(grant, route('qwen-local'), '8')

    await expect(adapter.preflight(qwen)).resolves.toEqual({
      ok: false, reason: 'Selected compute target is unavailable',
    })
    await adapter.release(grant, 'SETTLED', new AbortController().signal)

    expect(remote.commands.some(command => command.includes('docker start') || command.includes('docker stop'))).toBe(false)
  })
})
