import { createHmac } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createModelExecutionScopeDigest } from '@deepseek-ai/dsh-model-lifecycle'
import type {
  GovernedModelRoute, ModelEvictionConsentRequest, ModelLifecyclePrestateReceipt,
} from '@deepseek-ai/dsh-model-lifecycle'
import type { ServerManagerDeviceRecoveryRequest } from '@deepseek-ai/dsh-model-lifecycle-server-manager'
import { createDeviceRecoveryConsentRequester, createPreviewAuthority } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { canonicalJson } from '../src/manager.ts'

const digest = (digit: string): string => `sha256:${digit.repeat(64)}`
const key = Buffer.alloc(32, 7)
const route = (id: string, digit: string): GovernedModelRoute => ({
  id,
  selection: { provider: 'local', model: id },
  disposition: 'AVAILABLE',
  admissionReceiptDigest: digest('a'),
  revisionDigest: digest(digit),
  targets: ['r5300'],
  allowRamCpuOffload: false,
})

it('holds declared local variants without admitted routes while preserving external providers', () => {
  const ctx = {} as Context
  const authority = createPreviewAuthority(ctx, {
    workId: 'work', principalId: 'alex', tenantId: 'gcp', auditPath: 'N:/fixture/audit.jsonl',
    localProviderIds: ['local', 'glm-uncensored-local-r5300', 'deepseek-vision-local-r5300'],
  } as Config, [route('glm', 'c')], key)
  expect(authority.classifyProvider('local')).toBe('GOVERNED_LOCAL')
  expect(authority.classifyProvider('glm-uncensored-local-r5300')).toBe('GOVERNED_LOCAL')
  expect(authority.classifyProvider('deepseek-vision-local-r5300')).toBe('GOVERNED_LOCAL')
  expect(authority.resolve({
    selection: { provider: 'glm-uncensored-local-r5300', model: 'unadmitted' },
    sessionId: 'session-1',
  }, new AbortController().signal)).toMatchObject({ kind: 'HELD' })
  expect(authority.classifyProvider('deepseek-official')).toBe('UNMANAGED_EXTERNAL')
})

function consentRequest(): ModelEvictionConsentRequest {
  const scopeFields = { workId: 'work', principalId: 'alex', tenantId: 'gcp', sessionId: 'session-1' }
  const scope = { ...scopeFields, digest: createModelExecutionScopeDigest(scopeFields) }
  const transactionDigest = digest('e')
  const sourceRoute = route('qwen', 'b')
  const destinationRoute = route('glm', 'c')
  const prestate = (model: GovernedModelRoute, receiptDigit: string): ModelLifecyclePrestateReceipt => ({
    stage: 'prestate',
    routeId: model.id,
    target: 'r5300',
    revisionDigest: model.revisionDigest,
    scopeDigest: scope.digest,
    transactionDigest,
    fencingDigest: digest('f'),
    digest: digest(receiptDigit),
    residency: { kind: 'RESIDENT', routeId: sourceRoute.id, revisionDigest: sourceRoute.revisionDigest },
  })
  return {
    scope,
    transactionDigest,
    resourceLease: {
      fencingDigest: digest('f'), expiresAt: Date.now() + 600_000,
    } as ModelEvictionConsentRequest['resourceLease'],
    sourceRoute,
    sourceTarget: 'r5300',
    sourcePrestate: prestate(sourceRoute, '1'),
    destinationRoute,
    destinationTarget: 'r5300',
    destinationPrestate: prestate(destinationRoute, '2'),
  }
}

it.each(['rejected', 'unavailable', 'allowed-once'] as const)(
  'mints a signed transaction grant only after explicit %s', async (outcome) => {
    const requestWithReceipt = vi.fn(async (_request: unknown) => ({ id: 'approval-id', outcome }))
    const ctx = {
      agents: { get: () => ({ session: {} }) },
      approval: { requestWithReceipt },
    } as unknown as Context
    const authority = createPreviewAuthority(ctx, {
      workId: 'work', principalId: 'alex', tenantId: 'gcp', auditPath: 'N:/fixture/audit.jsonl',
    } as Config, [route('qwen', 'b'), route('glm', 'c')], key)
    const request = consentRequest()
    const grant = await authority.requestEvictionConsent!(request, new AbortController().signal)

    expect(requestWithReceipt).toHaveBeenCalledTimes(1)
    const approvalPrompt = requestWithReceipt.mock.calls[0]?.[0] as { toolName?: string; reason?: string } | undefined
    expect(approvalPrompt?.toolName).toBe('giana-cowork-preview:model-switch')
    expect(approvalPrompt?.reason).toContain('Stop resident qwen on r5300 and load glm on r5300')
    if (outcome !== 'allowed-once') {
      expect(grant).toBeNull()
      return
    }
    expect(grant).not.toBeNull()
    const signed = grant!
    const bare = (value: string): string => value.slice('sha256:'.length)
    const body = {
      id: signed.id,
      scope_digest: bare(signed.scope_digest),
      transaction_digest: bare(signed.transaction_digest),
      fencing_digest: bare(signed.fencing_digest),
      source_route_id: signed.source_route_id,
      source_revision_digest: bare(signed.source_revision_digest),
      source_target: signed.source_target,
      destination_route_id: signed.destination_route_id,
      destination_revision_digest: bare(signed.destination_revision_digest),
      destination_target: signed.destination_target,
      source_prestate_digest: bare(signed.source_prestate_digest),
      destination_prestate_digest: bare(signed.destination_prestate_digest),
      expires_at: signed.expires_at,
    }
    expect(signed.signature).toBe(createHmac('sha256', key).update(canonicalJson(body)).digest('hex'))
  },
)

it('bounds consent to the remaining resource lease and refuses a nearly expired lease', async () => {
  const ctx = {
    agents: { get: () => ({ session: {} }) },
    approval: { requestWithReceipt: async () => ({ id: 'approval-id', outcome: 'allowed-once' }) },
  } as unknown as Context
  const authority = createPreviewAuthority(ctx, {
    workId: 'work', principalId: 'alex', tenantId: 'gcp', auditPath: 'N:/fixture/audit.jsonl',
  } as Config, [route('qwen', 'b'), route('glm', 'c')], key)
  const request = consentRequest()
  const shortLease = { ...request.resourceLease, expiresAt: Date.now() + 10_000 }
  const grant = await authority.requestEvictionConsent!(
    { ...request, resourceLease: shortLease }, new AbortController().signal,
  )
  expect(grant).not.toBeNull()
  expect(grant!.expires_at).toBeLessThanOrEqual(shortLease.expiresAt)

  const expiringLease = { ...request.resourceLease, expiresAt: Date.now() + 1_000 }
  expect(await authority.requestEvictionConsent!(
    { ...request, resourceLease: expiringLease }, new AbortController().signal,
  )).toBeNull()
})

function recoveryRequest(): ServerManagerDeviceRecoveryRequest {
  const base = consentRequest()
  return {
    context: {
      route: base.destinationRoute,
      target: base.destinationTarget,
      scope: base.scope,
      transactionKind: 'MODEL_ROUTE',
      transactionDigest: base.transactionDigest,
      resourceLease: base.resourceLease,
      deadlineAt: Date.now() + 30_000,
      signal: new AbortController().signal,
    },
    preflightReceipt: {
      stage: 'preflight', routeId: base.destinationRoute.id, target: base.destinationTarget,
      revisionDigest: base.destinationRoute.revisionDigest, scopeDigest: base.scope.digest,
      transactionDigest: base.transactionDigest, fencingDigest: base.resourceLease.fencingDigest,
      digest: digest('4'),
    },
    recoveryStateDigest: digest('5'),
    devices: [{ index: 1, uuid: 'GPU-bdf65c79-5672-1627-b052-f16fef5e7a01', action: 'Reset' }],
  }
}

it.each(['rejected', 'unavailable', 'allowed-once'] as const)(
  'mints an exact GPU reset grant only after native %s', async (outcome) => {
    const requestWithReceipt = vi.fn(async (_request: unknown) => ({ id: 'gpu-approval', outcome }))
    const ctx = {
      agents: { get: () => ({ session: {} }) },
      approval: { requestWithReceipt },
    } as unknown as Context
    const request = recoveryRequest()
    const grant = await createDeviceRecoveryConsentRequester(ctx, key)(request, request.context.signal)

    expect(requestWithReceipt).toHaveBeenCalledTimes(1)
    expect(requestWithReceipt.mock.calls[0]?.[0]).toMatchObject({
      toolName: 'giana-cowork-preview:gpu-reset',
    })
    const prompt = requestWithReceipt.mock.calls[0]?.[0] as { reason?: string } | undefined
    expect(prompt?.reason).toContain('GPU1')
    if (outcome !== 'allowed-once') {
      expect(grant).toBeNull()
      return
    }
    expect(grant).toMatchObject({
      route_id: request.context.route.id,
      target: 'r5300',
      preflight_receipt_digest: request.preflightReceipt.digest,
      recovery_state_digest: request.recoveryStateDigest,
      devices: request.devices,
    })
    const signed = grant!
    const wire = {
      id: signed.id,
      fencing_digest: signed.fencing_digest.slice(7),
      scope_digest: signed.scope_digest.slice(7),
      transaction_digest: signed.transaction_digest.slice(7),
      route_id: signed.route_id,
      revision_digest: signed.revision_digest.slice(7),
      target: signed.target,
      preflight_receipt_digest: signed.preflight_receipt_digest.slice(7),
      recovery_state_digest: signed.recovery_state_digest.slice(7),
      devices: signed.devices,
      expires_at: signed.expires_at,
    }
    expect(signed.signature).toBe(createHmac('sha256', key).update(canonicalJson(wire)).digest('hex'))
  },
)
