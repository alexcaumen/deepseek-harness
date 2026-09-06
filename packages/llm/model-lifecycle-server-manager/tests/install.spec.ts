import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Lifecycle, { type GovernedModelRoute, type ModelLifecycleAuthority } from '@deepseek-ai/dsh-model-lifecycle'
import { installServerManagerLifecycle, type ServerManagerAdapterOptions } from '../src/index.ts'

const bare = 'a'.repeat(64)
const route: GovernedModelRoute = {
  id: 'local-fixture', selection: { provider: 'local-fixture', model: 'test-model' },
  disposition: 'AVAILABLE', admissionReceiptDigest: `sha256:${bare}`, revisionDigest: `sha256:${bare}`,
  targets: ['r5300'], allowRamCpuOffload: false,
}
const authority: ModelLifecycleAuthority = {
  classifyProvider: () => 'GOVERNED_LOCAL',
  resolve: () => ({ kind: 'HELD', routeId: route.id, reason: 'Isolated deployment fixture' }),
  record: async () => {},
}
const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  // Paths come only from mkdtemp, never from runtime/model input.
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function boot() {
  const root = await mkdtemp(join(tmpdir(), 'cowork-controller-composition-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  const invoke = vi.fn(async (): Promise<unknown> => { throw new Error('No hardware operation allowed in this fixture') })
  const options: ServerManagerAdapterOptions = {
    transport: { invoke }, targets: { r5300: { identityDigest: bare, currentnessDigest: bare } },
    issuerRef: `giana:issuer:sha256:${bare}`, holderRef: `giana:holder:sha256:${bare}`,
    admissionDigest: bare, leaseTtlMs: 60_000, operationTimeoutMs: 10_000, maxClockSkewMs: 100,
  }
  let uninstall: (() => Promise<void>) | undefined
  const composition = {
    name: 'fixture-deployment', inject: ['modelLifecycle'],
    apply(context: Context) {
      context.effect(async () => {
        uninstall = await installServerManagerLifecycle(context.modelLifecycle, authority, [route], options)
        return uninstall
      }, 'fixture local model deployment')
    },
  }
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-model-lifecycle', Lifecycle],
    ['fixture-deployment', composition],
  ])
  const config = join(root, 'cordis.yml')
  await writeFile(config, [...modules.keys()].map(name => `- name: '${name}'`).join('\n'))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2', async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error('Unexpected fixture module')
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  expect(uninstall).toBeTypeOf('function')
  return { ctx, invoke, options, uninstall: uninstall! }
}

it('real Loader mounting/disposal is lazy and preserves both empty and preexisting external GPUs', async () => {
  const { ctx, invoke, uninstall } = await boot()
  ctx.sessions.create(SessionId('test'))
  expect(invoke).not.toHaveBeenCalled()
  await expect(ctx.modelLifecycle.acquireRoute({ sessionId: 'test', selection: route.selection }))
    .rejects.toMatchObject({ code: 'ROUTE_HELD' })
  expect(invoke).not.toHaveBeenCalled()
  await uninstall()
  await uninstall()
  expect(invoke).not.toHaveBeenCalled()
})

it('failed duplicate registration unwinds all registrations so the same runtime can be installed cleanly', async () => {
  const { ctx, options, uninstall, invoke } = await boot()
  await uninstall()
  await expect(installServerManagerLifecycle(ctx.modelLifecycle, authority, [route, route], options))
    .rejects.toThrow('duplicate governed route')
  const remove = await installServerManagerLifecycle(ctx.modelLifecycle, authority, [route], options)
  await remove()
  expect(invoke).not.toHaveBeenCalled()
})

it('does not synthesize fallback identities that the deployment never provided', async () => {
  const { ctx, options, uninstall, invoke } = await boot()
  await uninstall()
  await expect(installServerManagerLifecycle(ctx.modelLifecycle, authority, [{ ...route, targets: ['prdg'] }], options))
    .rejects.toThrow('explicit admitted target coverage')
  const remove = await installServerManagerLifecycle(ctx.modelLifecycle, authority, [route], options)
  await remove()
  expect(invoke).not.toHaveBeenCalled()
})

it('retains dependencies after a cleanup failure and retries only unfinished work', async () => {
  const { options } = await boot()
  const removeAuthority = vi.fn()
  const removeResources = vi.fn()
  const first = vi.fn(async () => {})
  const second = vi.fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error('Transient fixture failure'))
    .mockResolvedValue(undefined)
  const runtime = {
    installAuthority: () => removeAuthority,
    installResources: () => removeResources,
    register: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
  } as unknown as Lifecycle
  const dispose = await installServerManagerLifecycle(runtime, authority, [route, { ...route, id: 'second' }], options)
  await expect(dispose()).rejects.toThrow('cleanup is incomplete')
  expect(first).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalledTimes(1)
  expect(removeResources).not.toHaveBeenCalled()
  expect(removeAuthority).not.toHaveBeenCalled()
  await dispose()
  await dispose()
  expect(first).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalledTimes(2)
  expect(removeResources).toHaveBeenCalledTimes(1)
  expect(removeAuthority).toHaveBeenCalledTimes(1)
})
