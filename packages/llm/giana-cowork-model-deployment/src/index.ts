/** Giana CoWork Preview deployment binding for governed local models. */

import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { open, mkdir, readFile } from 'node:fs/promises'
import { isAbsolute, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import z from '@deepseek-ai/schemastery'
import {
  createModelExecutionScopeDigest,
  type AcquireModelRouteRequest,
  type GovernedModelRoute,
  type ModelComputeTarget,
  type ModelExecutionScope,
  type ModelLifecycleAuditRecord,
  type ModelLifecycleAuthority,
  type ModelEvictionConsentRequest,
  type ModelRouteDisposition,
} from '@deepseek-ai/dsh-model-lifecycle'
import {
  installServerManagerLifecycle,
  ServerManagerStdioTransport,
  type ServerManagerDeviceRecoveryConsentGrant,
  type ServerManagerDeviceRecoveryRequest,
  type ServerManagerTargetIdentity,
} from '@deepseek-ai/dsh-model-lifecycle-server-manager'
import { canonicalJson } from './manager.js'

const DIGEST = /^sha256:[a-f0-9]{64}$/u
const BARE_DIGEST = /^[a-f0-9]{64}$/u
const TARGETS = ['r5300', 'prdg', 'ram-cpu'] as const
const DISPOSITIONS = ['HIDDEN_HELD', 'VISIBLE_DISABLED', 'AVAILABLE'] as const
const PROMPT_PROFILES = ['compact-4k'] as const
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
  readonly allowExactResidentAdoption?: boolean
  readonly supportedReasoningEfforts?: string[]
  readonly stageTimeoutsMs?: Readonly<Record<string, number>>
  /** Explicit prompt budget for constrained local serving contexts. */
  readonly promptProfile?: typeof PROMPT_PROFILES[number]
}

/** One fixed command runner for an admitted compute target. */
export type RunnerConfig =
  | {
    readonly target: ModelComputeTarget
    readonly kind: 'ssh'
    readonly executable: string
    readonly configPath: string
    readonly host: string
  }
  | {
    readonly target: ModelComputeTarget
    readonly kind: 'wsl'
    readonly executable: string
    readonly distribution: string
  }

/** Deployment values supplied by the isolated GCP profile. */
export interface Config {
  readonly admissionReceiptPath: string
  readonly registryPath: string
  readonly statePath: string
  readonly auditPath: string
  readonly runners: RunnerConfig[]
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
  /** Known local provider namespaces, including variants held before route admission. */
  readonly localProviderIds?: string[]
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
  allowExactResidentAdoption: z.boolean().default(false),
  supportedReasoningEfforts: z.array(z.string().min(1)).default(undefined as unknown as string[]),
  stageTimeoutsMs: z.dict(z.number().step(1).min(1)).default(undefined as unknown as Record<string, number>),
  promptProfile: z.const('compact-4k').default(undefined as unknown as typeof PROMPT_PROFILES[number]),
})

const runnerSchema = z.union([
  z.object({
    target: z.union([...TARGETS]),
    kind: z.const('ssh'),
    executable: z.string().min(1),
    configPath: z.string().min(1),
    host: z.string().min(1),
  }),
  z.object({
    target: z.union([...TARGETS]),
    kind: z.const('wsl'),
    executable: z.string().min(1),
    distribution: z.string().min(1),
  }),
])

/** Loader schema for the explicit preview deployment. */
export const Config: z<Config> = z.object({
  admissionReceiptPath: z.string().min(1),
  registryPath: z.string().min(1),
  statePath: z.string().min(1),
  auditPath: z.string().min(1),
  runners: z.array(runnerSchema).min(1),
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
  localProviderIds: z.array(z.string().min(1)).default(undefined as unknown as string[]),
  managerScript: z.string().default(undefined as unknown as string),
})

export const name = 'giana-cowork-model-deployment'
export const inject = ['llm', 'modelLifecycle', 'agents', 'approval', 'systemPrompt', 'tools']

function selectionKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

const TOOL_SECTION_FAMILIES: Readonly<Record<string, RegExp>> = Object.freeze({
  'tool:cordis': /^cordis_/u,
  'tool:goal': /^(?:get|create|update)_goal$/u,
  'tool:jobs': /^job_/u,
  'tool:pty': /^terminal_/u,
  'tool:report': /^report$/u,
  'tool:session-query': /^session_/u,
})

/** Exact route selections whose static prompt must fit a 4K serving window. */
export function compactPromptSelections(config: Pick<Config, 'routes'>): ReadonlySet<string> {
  return new Set(config.routes
    .filter(route => route.promptProfile === 'compact-4k')
    .map(route => selectionKey(route.provider, route.model)))
}

/** Replace only static prose; tool schemas, runtime context, and variables remain authoritative. */
export function applyPromptBudget(
  assembly: PromptAssembly,
  selections: ReadonlySet<string>,
  selected: Pick<ModelSelection, 'provider' | 'model'> | undefined,
  requestTools = assembly.tools,
): PromptAssembly {
  if (selected === undefined || !selections.has(selectionKey(selected.provider, selected.model))) {
    return assembly
  }
  // Code Mode reaches non-wire tools through the generated SDK, so every
  // registered tool instruction remains relevant even when only run_code is wired.
  const codeMode = requestTools.some(tool => tool.name === 'run_code')
    && assembly.sections.some(section => section.name === 'tools:sdk' && section.text.length > 0)
  if (codeMode) return assembly
  const knownTools = new Set(assembly.tools.map(tool => tool.name))
  const visibleTools = new Set(requestTools.map(tool => tool.name))
  const sections = assembly.sections.filter((section) => {
    if (!section.name.startsWith('tool:')) return true
    const family = TOOL_SECTION_FAMILIES[section.name]
    if (family !== undefined) {
      const familyKnown = [...knownTools].some(name => family.test(name))
      return !familyKnown || [...visibleTools].some(name => family.test(name))
    }
    const exact = section.name.slice('tool:'.length)
    // Unknown/custom naming is preserved. Only an exact registered capability
    // may be removed after the native request projection proves it is hidden.
    return !knownTools.has(exact) || visibleTools.has(exact)
  })
  if (sections.length === assembly.sections.length) return assembly
  return {
    ...assembly,
    sections,
  }
}

function validate(config: Config): void {
  for (const [label, value] of [
    ['admissionReceiptPath', config.admissionReceiptPath],
    ['registryPath', config.registryPath], ['statePath', config.statePath],
    ['auditPath', config.auditPath],
    ...config.runners.flatMap(runner => runner.kind === 'ssh'
      ? [['runner.executable', runner.executable], ['runner.configPath', runner.configPath]] as const
      : [['runner.executable', runner.executable]] as const),
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
  const runnerTargets = new Set(config.runners.map(runner => runner.target))
  if (runnerTargets.size !== config.runners.length
    || [...targetClasses].some(target => !runnerTargets.has(target))) {
    throw new Error('GCP model deployment runners are duplicated or omit a target')
  }
  const ids = new Set<string>()
  const selections = new Set<string>()
  if (config.localProviderIds !== undefined) {
    const localProviders = new Set(config.localProviderIds)
    if (localProviders.size !== config.localProviderIds.length
      || config.routes.some(route => !localProviders.has(route.provider))) {
      throw new Error('GCP model deployment local provider identities are duplicated or omit a route')
    }
  }
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
    allowExactResidentAdoption: route.allowExactResidentAdoption === true,
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

async function evictionSigningKey(statePath: string): Promise<Buffer> {
  const file = `${statePath}.eviction-key`
  await mkdir(dirname(file), { recursive: true })
  try {
    const handle = await open(file, 'wx', 0o600)
    try {
      await handle.writeFile(randomBytes(32))
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const key = await readFile(file)
  if (key.length !== 32) throw new Error('GCP eviction signing key is unavailable')
  return key
}

function bare(value: string): string {
  if (!DIGEST.test(value)) throw new Error('Invalid GCP consent digest')
  return value.slice('sha256:'.length)
}

/** Build the preview-scoped authority after its private signing key is ready. */
export function createPreviewAuthority(
  ctx: Context,
  config: Config,
  routes: readonly GovernedModelRoute[],
  key: Buffer,
): ModelLifecycleAuthority {
  const providers = new Set([
    ...routes.map(route => route.selection.provider),
    ...(config.localProviderIds ?? []),
  ])
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
    async requestEvictionConsent(request: ModelEvictionConsentRequest, signal: AbortSignal) {
      const agent = ctx.agents.get(request.scope.sessionId as SessionId)
      if (agent === undefined) return null
      const from = `${request.sourceRoute.selection.model} on ${request.sourceTarget}`
      const to = `${request.destinationRoute.selection.model} on ${request.destinationTarget}`
      const decision = await ctx.approval.requestWithReceipt({
        agent,
        toolName: 'giana-cowork-preview:model-switch',
        reason: `Stop resident ${from} and load ${to}? Rejecting keeps the current model running.`,
        signal,
      })
      if (decision.outcome !== 'allowed-once' || signal.aborted) return null
      const id = createHash('sha256').update([
        decision.id, request.scope.digest, request.transactionDigest,
        request.sourcePrestate.digest, request.destinationPrestate.digest,
      ].join('\u0000')).digest('hex')
      const fencingDigest = request.resourceLease.fencingDigest
      const now = Date.now()
      const expiresAt = Math.min(now + 300_000, request.resourceLease.expiresAt)
      if (expiresAt <= now + 2_000) return null
      const wire = {
        id,
        scope_digest: bare(request.scope.digest),
        transaction_digest: bare(request.transactionDigest),
        fencing_digest: bare(fencingDigest),
        source_route_id: request.sourceRoute.id,
        source_revision_digest: bare(request.sourceRoute.revisionDigest),
        source_target: request.sourceTarget,
        destination_route_id: request.destinationRoute.id,
        destination_revision_digest: bare(request.destinationRoute.revisionDigest),
        destination_target: request.destinationTarget,
        source_prestate_digest: bare(request.sourcePrestate.digest),
        destination_prestate_digest: bare(request.destinationPrestate.digest),
        expires_at: expiresAt,
      }
      return {
        id,
        fencing_digest: fencingDigest,
        signature: createHmac('sha256', key).update(canonicalJson(wire)).digest('hex'),
        scope_digest: request.scope.digest,
        transaction_digest: request.transactionDigest,
        source_route_id: request.sourceRoute.id,
        source_revision_digest: request.sourceRoute.revisionDigest,
        source_target: request.sourceTarget,
        destination_route_id: request.destinationRoute.id,
        destination_revision_digest: request.destinationRoute.revisionDigest,
        destination_target: request.destinationTarget,
        source_prestate_digest: request.sourcePrestate.digest,
        destination_prestate_digest: request.destinationPrestate.digest,
        expires_at: expiresAt,
      }
    },
  }
}

/** Bind one exact hardware reset to the native approval receipt and active resource lease. */
export function createDeviceRecoveryConsentRequester(ctx: Context, key: Buffer) {
  return async (
    request: ServerManagerDeviceRecoveryRequest,
    signal: AbortSignal,
  ): Promise<ServerManagerDeviceRecoveryConsentGrant | null> => {
    const { context } = request
    const agent = ctx.agents.get(context.scope.sessionId as SessionId)
    if (agent === undefined) return null
    const devices = request.devices.map(device => `GPU${device.index} (${device.uuid})`).join(', ')
    const decision = await ctx.approval.requestWithReceipt({
      agent,
      toolName: 'giana-cowork-preview:gpu-reset',
      reason: `Reset ${devices} on ${context.target} before loading ${context.route.selection.model}? The reset is limited to idle GPUs; rejecting leaves hardware and resident models unchanged.`,
      signal,
    })
    if (decision.outcome !== 'allowed-once' || signal.aborted) return null
    const id = createHash('sha256').update([
      decision.id,
      context.scope.digest,
      context.transactionDigest,
      request.preflightReceipt.digest,
      request.recoveryStateDigest,
      canonicalJson(request.devices),
    ].join('\u0000')).digest('hex')
    const now = Date.now()
    const expiresAt = Math.min(now + 300_000, context.resourceLease.expiresAt)
    if (expiresAt <= now + 2_000) return null
    const wire = {
      id,
      fencing_digest: bare(context.resourceLease.fencingDigest),
      scope_digest: bare(context.scope.digest),
      transaction_digest: bare(context.transactionDigest),
      route_id: context.route.id,
      revision_digest: bare(context.route.revisionDigest),
      target: context.target,
      preflight_receipt_digest: bare(request.preflightReceipt.digest),
      recovery_state_digest: bare(request.recoveryStateDigest),
      devices: request.devices,
      expires_at: expiresAt,
    }
    return {
      ...wire,
      fencing_digest: context.resourceLease.fencingDigest,
      scope_digest: context.scope.digest,
      transaction_digest: context.transactionDigest,
      revision_digest: context.route.revisionDigest,
      preflight_receipt_digest: request.preflightReceipt.digest,
      recovery_state_digest: request.recoveryStateDigest,
      signature: createHmac('sha256', key).update(canonicalJson(wire)).digest('hex'),
    }
  }
}

/** Install the preview-only lifecycle deployment without touching a model at mount time. */
export function apply(ctx: Context, input: Config): void {
  const config = Config(input)
  validate(config)
  const routes = governedRoutes(config)
  ctx.llm.registerModelOwnership(routes.map(route => route.selection))
  const promptSelections = compactPromptSelections(config)
  if (promptSelections.size > 0) {
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      const options = context.agent?.options
      const selected = context.modelSelection ?? (
        options?.provider === undefined || options.model === undefined
          ? undefined
          : { provider: options.provider, model: options.model }
      )
      const requestTools = selected === undefined || context.agent === undefined
        ? assembled.tools
        : ctx.tools.schemasForRequest(assembled.tools, context.agent, selected.provider)
      return applyPromptBudget(assembled, promptSelections, selected, requestTools)
    })
  }
  const managerScript = config.managerScript ?? fileURLToPath(new URL('./manager.js', import.meta.url))
  const transport = new ServerManagerStdioTransport({
    executable: process.execPath,
    args: [managerScript, '--registry', config.registryPath, '--state', config.statePath,
      '--runners', JSON.stringify(config.runners)],
    env: managerEnvironment(), maxOperationMs: config.operationTimeoutMs,
  })
  const targets = Object.fromEntries(config.targets.map((target: TargetConfig) => [target.class, {
    identityDigest: target.identityDigest,
    currentnessDigest: target.currentnessDigest,
  }])) as Readonly<Partial<Record<ModelComputeTarget, ServerManagerTargetIdentity>>>
  ctx.effect(async () => {
    const key = await evictionSigningKey(config.statePath)
    const uninstall = await installServerManagerLifecycle(
      ctx.modelLifecycle, createPreviewAuthority(ctx, config, routes, key), routes, {
        transport, targets, issuerRef: config.issuerRef, holderRef: config.holderRef,
        admissionDigest: config.admissionDigest, leaseTtlMs: config.leaseTtlMs,
        operationTimeoutMs: config.operationTimeoutMs, maxClockSkewMs: config.maxClockSkewMs,
        requestDeviceRecoveryConsent: createDeviceRecoveryConsentRequester(ctx, key),
      },
    )
    return async () => {
      await uninstall()
      await transport.close()
    }
  }, 'Giana CoWork Preview local-model deployment')
}
