/** Keyless cross-repository wire check. Executes only the owner's in-memory test fixture. */
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import assert from 'node:assert/strict'
import { ServerManagerModelLifecycleAdapter, ServerManagerStdioTransport } from '../packages/llm/model-lifecycle-server-manager/src/index.ts'
import type { ModelLifecycleStageContext } from '../packages/llm/model-lifecycle/src/index.ts'

const { values } = parseArgs({ options: { 'owner-root': { type: 'string' }, python: { type: 'string' } } })
if (!values['owner-root'] || !values.python) throw new Error('Pass --owner-root and --python for the isolated fixture')
const root = resolve(values['owner-root'])
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
const target = { identityDigest: digest('fixture-target'), currentnessDigest: digest('fixture-current') }
const admission = {
  status: 'ADMITTED', audience: 'fixture-audience', currentness_digest: digest('fixture-admission'),
  monotonic_epoch_digest: digest('fixture-epoch'), max_ttl_ms: 300000, max_operation_timeout_ms: 600000,
  renew_after_ms: 1000, transaction_kinds: ['MODEL_ROUTE', 'IDLE_UNLOAD', 'SHUTDOWN', 'ROLLBACK_RESTORE'],
  target_coverage: { r5300: { identity_digest: target.identityDigest, currentness_digest: target.currentnessDigest } },
}
const transport = new ServerManagerStdioTransport({
  executable: resolve(values.python), args: [join(root, 'tests/server_manager/lifecycle_stdio_fixture.py'), '--delay-ms', '2500'],
  cwd: root, env: { PYTHONPATH: join(root, 'src'), PYTHONDONTWRITEBYTECODE: '1',
    ...process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {} },
  maxOperationMs: 10000, closeTimeoutMs: 2000,
})
const adapter = new ServerManagerModelLifecycleAdapter({
  transport, targets: { r5300: target },
  issuerRef: `giana:issuer:sha256:${digest('fixture-issuer')}`,
  holderRef: `giana:holder:sha256:${digest('fixture-principal')}`,
  admissionDigest: digest(admission), leaseTtlMs: 60000, operationTimeoutMs: 5000, maxClockSkewMs: 1000,
})
const signal = new AbortController().signal
try {
  const resourceLease = await adapter.acquire({ targets: ['r5300'] }, signal)
  console.log('fixture: acquire PASS')
  const context: ModelLifecycleStageContext = {
    route: {
      id: 'fixture-route', selection: { provider: 'fixture', model: 'fixture-model' }, disposition: 'AVAILABLE',
      admissionReceiptDigest: `sha256:${digest(admission)}`, revisionDigest: `sha256:${digest('fixture-revision')}`,
      targets: ['r5300'], allowRamCpuOffload: false,
    }, target: 'r5300',
    scope: { workId: 'fixture', principalId: 'fixture', tenantId: 'fixture', sessionId: 'fixture', digest: `sha256:${digest('fixture-scope')}` },
    transactionKind: 'MODEL_ROUTE', transactionDigest: `sha256:${digest('fixture-tx')}`,
    resourceLease, deadlineAt: Date.now() + 10000, signal,
  }
  assert.equal((await adapter.preflight(context)).ok, true)
  console.log('fixture: preflight PASS')
  assert.equal((await adapter.capturePrestate(context)).residency.kind, 'EMPTY')
  console.log('fixture: prestate PASS')
  let started = false
  const start = adapter.start(context).then((value) => { started = true; return value })
  // Exercise the owner-returned renew schedule, not an invalid same-millisecond renewal.
  await new Promise(resolve => setTimeout(resolve, resourceLease.renewAfterMs))
  const renewed = await adapter.renew(resourceLease, signal)
  console.log('fixture: concurrent renewal PASS')
  assert.equal(started, false, 'Renew must not wait behind the start stage')
  await start
  console.log('fixture: start PASS')
  const renewedContext = { ...context, resourceLease: renewed, deadlineAt: Date.now() + 10000 }
  assert.equal((await adapter.health(renewedContext)).ok, true)
  assert.equal((await adapter.probe(renewedContext)).ok, true)
  await adapter.release(renewed, 'SETTLED', signal)
  console.log(JSON.stringify({ state: 'PASS_CROSS_LANGUAGE_FIXTURE_ONLY',
    stages: ['acquire', 'preflight', 'prestate', 'start-with-concurrent-renew', 'health', 'probe', 'release'],
    liveModel: false, productionGreen: false }))
} finally { await transport.close() }
