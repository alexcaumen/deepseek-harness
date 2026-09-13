import { afterEach, expect, it } from 'vitest'
import { ServerManagerStdioTransport } from '../src/stdio-transport.ts'

const transports: ServerManagerStdioTransport[] = []
afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.close()
})

const echo = `
const readline = require('node:readline');
const input = readline.createInterface({input:process.stdin});
input.on('line', line => {
  const r = JSON.parse(line);
  if (r.envelope.lostReply) return;
  if (r.envelope.crash) process.exit(1);
  if (r.envelope.invalid) { process.stdout.write('private malformed diagnostic\\n'); return; }
  if (r.envelope.oversize) { process.stdout.write('x'.repeat(300000)); return; }
  if (r.envelope.error) { console.log(JSON.stringify({id:r.id,error:{code:r.envelope.errorCode || 'private diagnostic'}})); return; }
  setTimeout(() => console.log(JSON.stringify({id:r.id,result:{
    operation:r.operation, key:r.envelope.idempotency_key,
    leaked: process.env.SERVER_MANAGER_TRANSPORT_TEST_SECRET !== undefined
  }})), r.envelope.delay || 0);
});`

function fixture(script = echo, overrides = {}) {
  const transport = new ServerManagerStdioTransport({
    executable: process.execPath, args: ['-e', script], env: {},
    maxOperationMs: 5_000, closeTimeoutMs: 100, ...overrides,
  })
  transports.push(transport)
  return transport
}

const request = (extra = {}) => ({ timeout_ms: 3_000, idempotency_key: 'same-key', ...extra })
const signal = () => new AbortController().signal

it('construction/close are inert and never start a missing executable', async () => {
  const transport = fixture('', { executable: `${process.execPath}.not-installed` })
  await expect(transport.close()).resolves.toBeUndefined()
})

it('keeps request identity and does not inherit ambient credentials', async () => {
  process.env.SERVER_MANAGER_TRANSPORT_TEST_SECRET = 'must-not-leak'
  try {
    await expect(fixture().invoke('acquire', request(), signal())).resolves.toEqual({
      operation: 'acquire', key: 'same-key', leaked: false,
    })
  } finally { delete process.env.SERVER_MANAGER_TRANSPORT_TEST_SECRET }
})

it('allows renew to finish during a slow start and routes out-of-order replies', async () => {
  const transport = fixture()
  let startFinished = false
  const start = transport.invoke('stage', request({ delay: 300 }), signal()).then((value) => {
    startFinished = true
    return value
  })
  await expect(transport.invoke('renew', request(), signal())).resolves.toMatchObject({ operation: 'renew' })
  expect(startFinished).toBe(false)
  await expect(start).resolves.toMatchObject({ operation: 'stage' })
})

it('pre-abort does not start the controller', async () => {
  const transport = fixture('', { executable: `${process.execPath}.not-installed` })
  await expect(transport.invoke('stage', request(), AbortSignal.abort())).rejects.toMatchObject({ code: 'ABORTED' })
})

it('bounds time, does not retry, and does not misassign a late response', async () => {
  const transport = fixture()
  await expect(transport.invoke('stage', request({ timeout_ms: 20, delay: 200 }), signal()))
    .rejects.toMatchObject({ code: 'TIMEOUT' })
  await expect(transport.invoke('renew', request(), signal())).resolves.toMatchObject({ operation: 'renew' })
  await new Promise(resolve => setTimeout(resolve, 250))
  await expect(transport.invoke('release', request(), signal())).resolves.toMatchObject({ operation: 'release' })
})

it.each(['invalid', 'oversize', 'crash', 'error'])('sanitizes %s backend responses', async (kind) => {
  const error = await fixture().invoke('stage', request({ [kind]: true }), signal()).catch((value: unknown) => value)
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).not.toMatch(/private|diagnostic|same-key/)
})

it('surfaces only the exact target-unavailable wire code', async () => {
  const transport = fixture()
  await expect(transport.invoke('acquire', request({ error: true, errorCode: 'TARGET_UNAVAILABLE' }), signal()))
    .rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' })
  for (const errorCode of ['BUSY', 'LEASE_MISMATCH', 'STATE_CONFLICT', 'REMOTE_FAILURE']) {
    await expect(transport.invoke('acquire', request({ error: true, errorCode }), signal()))
      .rejects.toMatchObject({ code: 'UNAVAILABLE' })
  }
})

it('bounds outstanding operations and awaits shutdown of a hung transport child', async () => {
  const transport = fixture('process.stdin.resume(); setInterval(()=>{},1000)', { maxPendingRequests: 1 })
  const pending = transport.invoke('stage', request(), signal()).catch((error: unknown) => error)
  await expect(transport.invoke('stage', request(), signal())).rejects.toMatchObject({ code: 'QUEUE_FULL' })
  await transport.close()
  expect(await pending).toMatchObject({ code: 'UNAVAILABLE' })
  await expect(transport.invoke('renew', request(), signal())).rejects.toMatchObject({ code: 'UNAVAILABLE' })
})

it('reserves bounded renewal and release lanes even when all normal replies are lost', async () => {
  const transport = fixture(echo, { maxPendingRequests: 1 })
  await expect(transport.invoke('stage', request({ lostReply: true, timeout_ms: 20 }), signal()))
    .rejects.toMatchObject({ code: 'TIMEOUT' })
  await expect(transport.invoke('stage', request(), signal())).rejects.toMatchObject({ code: 'QUEUE_FULL' })
  await expect(transport.invoke('renew', request(), signal())).resolves.toMatchObject({ operation: 'renew' })
  await expect(transport.invoke('release', request(), signal())).resolves.toMatchObject({ operation: 'release' })
})

it('refuses oversized outgoing frames and unknown operation deadlines before spawn', async () => {
  const transport = fixture('', { executable: `${process.execPath}.not-installed`, maxFrameBytes: 256 })
  await expect(transport.invoke('stage', request({ value: 'x'.repeat(256) }), signal()))
    .rejects.toMatchObject({ code: 'PROTOCOL_INVALID' })
  await expect(transport.invoke('stage', request({ timeout_ms: 5001 }), signal()))
    .rejects.toMatchObject({ code: 'INVALID_CONFIG' })
})
