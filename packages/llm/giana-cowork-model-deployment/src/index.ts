/** Giana CoWork Preview deployment binding for governed local models. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { open, mkdir } from 'node:fs/promises'
import { isAbsolute, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  createModelExecutionScopeDigest,
  type AcquireModelRouteRequest,
  type GovernedModelRoute,
  type ModelComputeTarget,
  type ModelExecutionScope,
  type ModelLifecycleAuditRecord,
  type ModelLifecycleAuthority,
  type ModelRouteDisposition,
} from '@deepseek-ai/dsh-model-lifecycle'
import {
  installServerManagerLifecycle,
  ServerManagerStdioTransport,
  type ServerManagerTargetIdentity,
} from '@deepseek-ai/dsh-model-lifecycle-server-manager'

const DIGEST = /^sha256:[a-f0-9]{64}$/u
const BARE_DIGEST = /^[a-f0-9]{64}$/u
const TARGETS = ['r5300', 'prdg', 'ram-cpu'] as const
const DISPOSITIONS = ['HIDDEN_HELD', 'VISIBLE_DISABLED', 'AVAILABLE'] as const
const MANAGER_ENVIRONMENT_NAMES = [
  'SystemRoot', 'WINDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'TEMP', 'TMP',
] as const

/** Minimal non-secret Windows environment required by the fixed OpenSSH executable. */
export function managerEnvironment(environment: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(MANAGER_ENVIRONMENT_NAMES.flatMap((name) => {
    const value = environment[name]
    return value === undefined ? [] : [[name, value]]
  })))
}

/** One target identity issued for this preview deployment. */
export interface TargetConfig {
  readonly class: ModelComputeTarget
  readonly identityDigest: string
  readonly currentnessDigest: string
}

/** One exact provider/model route available to the lifecycle authority. */
export interface RouteConfig {
  readonly id: string
  readonly provider: string
  readonly model: string
  readonly disposition: ModelRouteDisposition
  readonly admissionReceiptDigest: string
  readonly revisionDigest: string
  readonly targets: ModelComputeTarget[]
  readonly allowRamCpuOffload: boolean
  readonly supportedReasoningEfforts?: string[]
  readonly stageTimeoutsMs?: Readonly<Record<string, number>>
}

/** Deployment values supplied by the isolated GCP profile. */
export interface Config {
  readonly admissionReceiptPath: string
  readonly registryPath: string
  readonly statePath: string
  readonly auditPath: string
  readonly sshExecutable: string
  readonly sshConfigPath: string
  readonly sshHost: string
  readonly workId: string
  readonly principalId: string
  readonly tenantId: string
  readonly issuerRef: string
  readonly holderRef: string
  readonly admissionDigest: string
  readonly leaseTtlMs: number
  readonly operationTimeoutMs: number
  readonly maxClockSkewMs: number
  readonly targets: TargetConfig[]
  readonly routes: RouteConfig[]
  readonly managerScript?: string
}

const targetSchema = z.object({
  class: z.union([...TARGETS]),
  identityDigest: z.string(),
  currentnessDigest: z.string(),
})

const routeSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  disposition: z.union([...DISPOSITIONS]),
  admissionReceiptDigest: z.string(),
  revisionDigest: z.string(),
  targets: z.array(z.union([...TARGETS])).min(1),
  allowRamCpuOffload: z.boolean(),
  supportedReasoningEfforts: z.array(z.string().min(1)).default(undefined as unknown as string[]),
  stageTimeoutsMs: z.dict(z.number().step(1).min(1)).default(undefined as unknown as Record<string, number>),
})

/** Loader schema for the explicit preview deployment. */
export const Config: z<Config> = z.object({
  admissionReceiptPath: z.string().min(1),
  registryPath: z.string().min(1),
  statePath: z.string().min(1),
  auditPath: z.string().min(1),
  sshExecutable: z.string().min(1),
  sshConfigPath: z.string().min(1),
  sshHost: z.string().min(1),
  workId: z.string().min(1),
  principalId: z.string().min(1),
  tenantId: z.string().min(1),
  issuerRef: z.string().min(1),
  holderRef: z.string().min(1),
  admissionDigest: z.string(),
  leaseTtlMs: z.number().step(1).min(2),
  operationTimeoutMs: z.number().step(1).min(1),
  maxClockSkewMs: z.number().step(1).min(0),
  targets: z.array(targetSchema).min(1),
  routes: z.array(routeSchema).min(1),
  managerScript: z.string().default(undefined as unknown as string),
})

export const name = 'giana-cowork-model-deployment'
export const inject = ['modelLifecycle']

function validate(config: Config): void {
  for (const [label, value] of [
    ['admissionReceiptPath', config.admissionReceiptPath],
    ['registryPath', config.registryPath], ['statePath', config.statePath],
    ['auditPath', config.auditPath], ['sshExecutable', config.sshExecutable], ['sshConfigPath', config.sshConfigPath],
    ...config.managerScript === undefined ? [] : [['managerScript', config.managerScript]],
  ] as const) {
    if (!isAbsolute(value)) throw new Error(`GCP model deployment ${label} must be absolute`)
  }
  if (new Set([
    config.admissionReceiptPath,
    config.registryPath,
    config.statePath,
    config.auditPath,
  ]).size !== 4) throw new Error('GCP model deployment control paths must be distinct')
  if (!BARE_DIGEST.test(config.admissionDigest)) throw new Error('GCP model deployment admission digest is invalid')
  let receipt: Buffer
  try {
    receipt = readFileSync(config.admissionReceiptPath)
  } catch {
    throw new Error('GCP model deployment admission receipt is unavailable')
  }
  const receiptDigest = createHash('sha256').update(receipt).digest('hex')
  if (receiptDigest !== config.admissionDigest) {
    throw new Error('GCP model deployment admission receipt digest does not match')
  }
  const targetClasses = new Set<ModelComputeTarget>()
  for (const target of config.targets) {
    if (targetClasses.has(target.class) || !BARE_DIGEST.test(target.identityDigest)
      || !BARE_DIGEST.test(target.currentnessDigest)) {
      throw new Error('GCP model deployment target identity is invalid or duplicated')
    }
    targetClasses.add(target.class)
  }
  const ids = new Set<string>()
  const selections = new Set<string>()
  for (const route of config.routes) {
    const key = `${route.provider}\u0000${route.model}`
    if (ids.has(route.id) || selections.has(key)
      || !DIGEST.test(route.admissionReceiptDigest) || !DIGEST.test(route.revisionDigest)
      || route.targets.some(target => !targetClasses.has(target))) {
      throw new Error('GCP model deployment route identity is invalid, duplicated, or uncovered')
    }
    ids.add(route.id)
    selections.add(key)
    if (route.disposition === 'AVAILABLE'
      && route.admissionReceiptDigest !== `sha256:${config.admissionDigest}`) {
      throw new Error('GCP model deployment available route is not bound to this admission receipt')
    }
  }
}

function governedRoutes(config: Config): readonly GovernedModelRoute[] {
  return Object.freeze(config.routes.map(route => Object.freeze({
    id: route.id,
    selection: Object.freeze({ provider: route.provider, model: route.model }),
    disposition: route.disposition,
    admissionReceiptDigest: route.admissionReceiptDigest,
    revisionDigest: route.revisionDigest,
    targets: Object.freeze([...route.targets]),
    allowRamCpuOffload: route.allowRamCpuOffload,
    ...route.supportedReasoningEfforts === undefined
      ? {} : { supportedReasoningEfforts: Object.freeze([...route.supportedReasoningEfforts]) },
    ...route.stageTimeoutsMs === undefined ? {} : { stageTimeoutsMs: Object.freeze({ ...route.stageTimeoutsMs }) },
  } as GovernedModelRoute)))
}

class DurableAuditWriter {
  private pending = Promise.resolve()
  constructor(private readonly path: string) {}

  append(record: ModelLifecycleAuditRecord): Promise<void> {
    const line = `${JSON.stringify({ schema: 'giana.cowork.preview.model-lifecycle-audit.v1', at: new Date().toISOString(), record })}\n`
    const write = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const handle = await open(this.path, 'a')
      try {
        await handle.writeFile(line, 'utf8')
        await handle.sync()
      } finally { await handle.close() }
    })
    this.pending = write.catch(() => {})
    return write
  }
}

function authority(config: Config, routes: readonly GovernedModelRoute[]): ModelLifecycleAuthority {
  const providers = new Set(routes.map(route => route.selection.provider))
  const bySelection = new Map(routes.map(route => [`${route.selection.provider}\u0000${route.selection.model}`, route]))
  const audit = new DurableAuditWriter(config.auditPath)
  return {
    classifyProvider(provider: string) {
      return providers.has(provider) ? 'GOVERNED_LOCAL' : 'UNMANAGED_EXTERNAL'
    },
    resolve(request: AcquireModelRouteRequest) {
      const route = bySelection.get(`${request.selection.provider}\u0000${request.selection.model}`)
      if (route === undefined) return {
        kind: 'HELD', routeId: `unknown:${request.selection.provider}`,
        reason: 'The selected local model is not admitted by this Giana CoWork Preview deployment',
      }
      if (route.disposition !== 'AVAILABLE') return {
        kind: 'HELD', routeId: route.id,
        reason: 'The selected local model remains held by its current preview admission',
      }
      if (request.sessionId === undefined || request.sessionId.trim().length === 0) return {
        kind: 'HELD', routeId: route.id, reason: 'A durable session is required for local model execution',
      }
      const scopeWithoutDigest = {
        workId: config.workId, principalId: config.principalId,
        tenantId: config.tenantId, sessionId: request.sessionId,
      }
      const scope: ModelExecutionScope = {
        ...scopeWithoutDigest,
        digest: createModelExecutionScopeDigest(scopeWithoutDigest),
      }
      return { kind: 'GOVERNED', route, scope }
    },
    record: (record: ModelLifecycleAuditRecord) => audit.append(record),
  }
}

/** Install the preview-only lifecycle deployment without touching a model at mount time. */
export function apply(ctx: Context, input: Config): void {
  const config = Config(input)
  validate(config)
  const routes = governedRoutes(config)
  const managerScript = config.managerScript ?? fileURLToPath(new URL('./manager.js', import.meta.url))
  const transport = new ServerManagerStdioTransport({
    executable: process.execPath,
    args: [managerScript, '--registry', config.registryPath, '--state', config.statePath,
      '--ssh', config.sshExecutable, '--ssh-config', config.sshConfigPath, '--host', config.sshHost],
    env: managerEnvironment(), maxOperationMs: config.operationTimeoutMs,
  })
  const targets = Object.fromEntries(config.targets.map((target: TargetConfig) => [target.class, {
    identityDigest: target.identityDigest,
    currentnessDigest: target.currentnessDigest,
  }])) as Readonly<Partial<Record<ModelComputeTarget, ServerManagerTargetIdentity>>>
  ctx.effect(async () => {
    const uninstall = await installServerManagerLifecycle(
      ctx.modelLifecycle, authority(config, routes), routes, {
        transport, targets, issuerRef: config.issuerRef, holderRef: config.holderRef,
        admissionDigest: config.admissionDigest, leaseTtlMs: config.leaseTtlMs,
        operationTimeoutMs: config.operationTimeoutMs, maxClockSkewMs: config.maxClockSkewMs,
      },
    )
    return async () => {
      await uninstall()
      await transport.close()
    }
  }, 'Giana CoWork Preview local-model deployment')
}
