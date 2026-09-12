import { createHash } from 'node:crypto'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Lifecycle, { type ModelLifecycleRuntime } from '@deepseek-ai/dsh-model-lifecycle'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as Deployment from '../src/index.ts'
import type { Config as DeploymentConfig } from '../src/index.ts'

const bare = (digit: string): string => digit.repeat(64)
const prefixed = (digit: string): string => 'sha256:' + bare(digit)
let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  try {
    await ctx?.fiber.dispose()
  } finally {
    ctx = undefined
    if (root !== undefined) {
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('fixture cleanup escaped temp root')
      await rm(root, { recursive: true, force: true })
      root = undefined
    }
  }
})

it('passes only the non-secret Windows environment required by OpenSSH', () => {
  expect(Deployment.managerEnvironment({
    SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\fixture', TEMP: 'N:\\tmp',
    PATH: 'private-path', GLM_CANARY_API_KEY: 'private-key', SSH_AUTH_SOCK: 'private-agent',
  })).toEqual({
    SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\fixture', TEMP: 'N:\\tmp',
  })
})

it('boots from Loader while a held route remains inert at mount and dispatch', async () => {
  root = await mkdtemp(join(tmpdir(), 'gcp-deployment-loader-'))
  const statePath = join(root, 'manager-state.json')
  const auditPath = join(root, 'lifecycle-audit.jsonl')
  const managerScript = join(root, 'must-not-start.mjs')
  const configPath = join(root, 'cordis.yml')
  const admissionReceiptPath = join(root, 'preview-admission.json')
  const admissionReceipt = '{"scope":"test-held-preview-route"}\n'
  const admissionDigest = createHash('sha256').update(admissionReceipt).digest('hex')
  await writeFile(admissionReceiptPath, admissionReceipt)
  let lifecycle: ModelLifecycleRuntime | undefined
  const consumer = {
    name: 'test-deployment-consumer',
    inject: ['modelLifecycle', 'sessions'],
    apply(inner: Context) {
      lifecycle = inner.modelLifecycle
      inner.sessions.create(SessionId('durable-session'))
    },
  }
  const config: DeploymentConfig = {
    admissionReceiptPath, registryPath: join(root, 'registry.json'), statePath, auditPath,
    sshExecutable: process.execPath, sshConfigPath: join(root, 'ssh-config'), sshHost: 'test-r5300',
    workId: 'gcp-loader-fixture', principalId: 'fixture-user', tenantId: 'fixture-tenant',
    issuerRef: 'giana:issuer:sha256:' + bare('1'), holderRef: 'giana:holder:sha256:' + bare('2'),
    admissionDigest, leaseTtlMs: 60_000, operationTimeoutMs: 30_000, maxClockSkewMs: 1_000,
    targets: [{ class: 'r5300', identityDigest: bare('4'), currentnessDigest: bare('5') }],
    routes: [{
      id: 'held-local', provider: 'fixture-local', model: 'fixture-model',
      disposition: 'VISIBLE_DISABLED', admissionReceiptDigest: prefixed('6'), revisionDigest: prefixed('7'),
      targets: ['r5300'], allowRamCpuOffload: false,
    }],
    managerScript,
  }
  const mismatchedConfig = Object.assign({}, config, { admissionDigest: bare('3') })
  expect(() => {
    Deployment.apply({} as Context, mismatchedConfig)
  }).toThrow('admission receipt digest does not match')
  const availableRoute = Object.assign({}, config.routes[0]!, { disposition: 'AVAILABLE' as const })
  const unboundConfig = Object.assign({}, config, { routes: [availableRoute] })
  expect(() => {
    Deployment.apply({} as Context, unboundConfig)
  }).toThrow('available route is not bound to this admission receipt')
  await writeFile(configPath, [
    '- id: sessions',
    "  name: '@deepseek-ai/dsh-session'",
    '- id: model-lifecycle',
    "  name: '@deepseek-ai/dsh-model-lifecycle'",
    '- id: gcp-deployment',
    "  name: '@deepseek-ai/dsh-giana-cowork-model-deployment'",
    '  config: ' + JSON.stringify(config),
    '- id: consumer',
    "  name: 'test-deployment-consumer'",
    '',
  ].join('\n'))

  ctx = new Context()
  ctx.provide('agents', { get: () => undefined } as never)
  ctx.provide('approval', { requestWithReceipt: () => Promise.resolve({ id: 'fixture', outcome: 'unavailable' }) } as never)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-model-lifecycle', Lifecycle],
    ['@deepseek-ai/dsh-giana-cowork-model-deployment', Deployment],
    ['test-deployment-consumer', consumer],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error('unexpected Loader import: ' + specifier)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()

  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  await vi.waitFor(() => { expect(lifecycle).toBeDefined() })
  await vi.waitFor(async () => {
    await expect(lifecycle!.acquireRoute({
      sessionId: 'durable-session', selection: { provider: 'fixture-local', model: 'fixture-model' },
    })).rejects.toMatchObject({ code: 'ROUTE_HELD' })
  })
  await expect(access(managerScript)).rejects.toThrow()
  await expect(access(statePath)).rejects.toThrow()
  await expect(access(auditPath)).rejects.toThrow()
})
