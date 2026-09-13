import { type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createServer as createHttpServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LoopbackEndpointController,
  type PreviewEndpointRoute,
  type PreviewEndpointProcessSpawner,
  type PreviewManagerArguments,
} from '../src/manager.ts'

const servers: Server[] = []
const controllers: LoopbackEndpointController[] = []

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing test address')
  return address.port
}

async function unusedPort(): Promise<number> {
  const server = createHttpServer()
  const port = await listen(server)
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
  servers.splice(servers.indexOf(server), 1)
  return port
}

function args(): PreviewManagerArguments {
  return {
    registryPath: 'C:\\gcp\\registry.json',
    statePath: 'C:\\gcp\\state.json',
    runners: [{
      target: 'prdg',
      kind: 'wsl',
      executable: 'C:\\Windows\\System32\\wsl.exe',
      distribution: 'Ubuntu-22.04',
    }],
  }
}

function sshArgs(): PreviewManagerArguments {
  return {
    registryPath: 'C:\\gcp\\registry.json',
    statePath: 'C:\\gcp\\state.json',
    runners: [{
      target: 'r5300',
      kind: 'ssh',
      executable: process.execPath,
      configPath: 'C:\\gcp\\ssh-config',
      host: 'r5300',
    }],
  }
}

function successfulSshSpawner(largeBody: string): PreviewEndpointProcessSpawner {
  return () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const child = new EventEmitter() as ChildProcess
    let exitCode: number | null = null
    let signalCode: NodeJS.Signals | null = null
    Object.defineProperties(child, {
      stdin: { value: input },
      stdout: { value: output },
      exitCode: { get: () => exitCode },
      signalCode: { get: () => signalCode },
    })
    child.kill = ((signal?: number | NodeJS.Signals): boolean => {
      signalCode = typeof signal === 'string' ? signal : 'SIGTERM'
      output.destroy()
      input.destroy()
      child.emit('close', null, signalCode)
      return true
    })
    let request = Buffer.alloc(0)
    input.on('data', (chunk: Buffer) => {
      request = Buffer.concat([request, chunk])
      if (!request.includes('\r\n\r\n')) return
      input.removeAllListeners('data')
      const path = request.toString('latin1').split(' ')[1]
      const body = path === '/v1/models'
        ? JSON.stringify({ data: [{ id: 'Qwen/Qwen3.8-27B' }] })
        : largeBody
      const response = Buffer.from(
        `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      )
      output.end(response, () => {
        exitCode = 0
        child.emit('close', 0, null)
      })
    })
    return child
  }
}

function route(
  localPort: number,
  upstreamLocalPort: number,
  expectedModel = 'Qwen/Qwen3.8-27B',
  target: 'r5300' | 'prdg' = 'prdg',
): PreviewEndpointRoute {
  return {
    id: 'qwen38-local',
    target,
    runtime: { localPort, upstreamLocalPort, remotePort: upstreamLocalPort, expectedModel },
  }
}

async function modelServer(model = 'Qwen/Qwen3.8-27B', reply = 'OK'): Promise<number> {
  return listen(createHttpServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/v1/models') {
      response.end(JSON.stringify({ data: [{ id: model }] }))
      return
    }
    if (request.url === '/v1/chat/completions') {
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }))
      return
    }
    response.statusCode = 404
    response.end('{}')
  }))
}

async function fragmentedRequest(port: number, first: Buffer, second: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    const response: Buffer[] = []
    socket.once('error', reject)
    socket.on('data', (chunk: Buffer) => { response.push(chunk) })
    socket.once('end', () => { resolve(Buffer.concat(response)) })
    socket.once('connect', () => {
      socket.write(first, () => { socket.end(second) })
    })
  })
}

afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.shutdown()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
  })))
})

describe('loopback endpoint controller', () => {
  it('binds a stable loopback route, verifies the exact model, probes chat, and releases it', async () => {
    const upstreamLocalPort = await modelServer()
    const localPort = await unusedPort()
    const controller = new LoopbackEndpointController(args())
    controllers.push(controller)
    const selected = route(localPort, upstreamLocalPort)

    await expect(controller.ensure(selected, 2_000)).resolves.toBe(true)
    await expect(controller.healthy(selected, 2_000)).resolves.toBe(true)
    await expect(controller.probe(selected, 2_000)).resolves.toBe(true)
    await expect(fetch(`http://127.0.0.1:${localPort}/v1/models`).then(response => response.json()))
      .resolves.toMatchObject({ data: [{ id: 'Qwen/Qwen3.8-27B' }] })
    await expect(controller.close(selected, 2_000)).resolves.toBe(true)
    await expect(controller.released(selected, 2_000)).resolves.toBe(true)
  })

  it('refuses to replace a foreign listener on the stable port', async () => {
    const upstreamLocalPort = await modelServer()
    const localPort = await modelServer('foreign-model')
    const controller = new LoopbackEndpointController(args())
    controllers.push(controller)

    await expect(controller.ensure(route(localPort, upstreamLocalPort), 2_000)).resolves.toBe(false)
    await expect(fetch(`http://127.0.0.1:${localPort}/v1/models`).then(response => response.json()))
      .resolves.toMatchObject({ data: [{ id: 'foreign-model' }] })
  })

  it('rebinds when the same logical route changes its upstream binding', async () => {
    const firstUpstream = await modelServer('Qwen/Qwen3.8-27B', 'FIRST')
    const secondUpstream = await modelServer('Qwen/Qwen3.8-27B', 'SECOND')
    const localPort = await unusedPort()
    const controller = new LoopbackEndpointController(args())
    controllers.push(controller)
    const first = route(localPort, firstUpstream)
    const second = route(localPort, secondUpstream)

    await expect(controller.ensure(first, 2_000)).resolves.toBe(true)
    await expect(controller.ensure(second, 2_000)).resolves.toBe(true)
    const payload = await fetch(`http://127.0.0.1:${localPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then(response => response.json()) as { choices: Array<{ message: { content: string } }> }
    expect(payload.choices[0]?.message.content).toBe('SECOND')
  })

  it('closes a newly created bridge when the upstream model identity is wrong', async () => {
    const upstreamLocalPort = await modelServer('wrong-model')
    const localPort = await unusedPort()
    const controller = new LoopbackEndpointController(args())
    controllers.push(controller)

    await expect(controller.ensure(route(localPort, upstreamLocalPort), 2_000)).resolves.toBe(false)
    await expect(controller.released(route(localPort, upstreamLocalPort), 2_000)).resolves.toBe(true)
  })

  it('does not reuse an unhealthy same-key endpoint state', async () => {
    const upstreamLocalPort = await modelServer()
    const localPort = await unusedPort()
    const controller = new LoopbackEndpointController(args())
    controllers.push(controller)
    const selected = route(localPort, upstreamLocalPort)
    await expect(controller.ensure(selected, 2_000)).resolves.toBe(true)
    const internal = controller as unknown as {
      states: Map<number, { unhealthy: boolean }>
    }
    const previous = internal.states.get(localPort)
    if (previous === undefined) throw new Error('missing endpoint state')
    previous.unhealthy = true

    await expect(controller.ensure(selected, 2_000)).resolves.toBe(true)
    expect(internal.states.get(localPort)).not.toBe(previous)
  })

  it('stops new admission without interrupting an accepted streamed response', async () => {
    let markAccepted: (() => void) | undefined
    const acceptedStarted = new Promise<void>((resolve) => { markAccepted = resolve })
    const upstreamLocalPort = await listen(createHttpServer((request, response) => {
      if (request.url === '/v1/models') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ data: [{ id: 'Qwen/Qwen3.8-27B' }] }))
        return
      }
      markAccepted?.()
      response.write('first')
      setTimeout(() => response.end('second'), 50)
    }))
    const localPort = await unusedPort()
    const controller = new LoopbackEndpointController(args())
    controllers.push(controller)
    const selected = route(localPort, upstreamLocalPort)
    await expect(controller.ensure(selected, 2_000)).resolves.toBe(true)
    const accepted = fetch(`http://127.0.0.1:${localPort}/stream`).then(response => response.text())
    await acceptedStarted

    await expect(controller.quiesce(selected, 2_000)).resolves.toBe(true)
    await expect(fetch(`http://127.0.0.1:${localPort}/v1/models`)).rejects.toThrow()
    await expect(accepted).resolves.toBe('firstsecond')
    await expect(controller.close(selected, 2_000)).resolves.toBe(true)
  })

  it('restores the same verified endpoint after a mutation-free quiesce', async () => {
    const upstreamLocalPort = await modelServer()
    const localPort = await unusedPort()
    const controller = new LoopbackEndpointController(args())
    controllers.push(controller)
    const selected = route(localPort, upstreamLocalPort)
    await expect(controller.ensure(selected, 2_000)).resolves.toBe(true)
    await expect(controller.quiesce(selected, 2_000)).resolves.toBe(true)
    await expect(fetch(`http://127.0.0.1:${localPort}/v1/models`)).rejects.toThrow()

    await expect(controller.resume(selected, 2_000)).resolves.toBe(true)
    await expect(fetch(`http://127.0.0.1:${localPort}/v1/models`).then(response => response.json()))
      .resolves.toMatchObject({ data: [{ id: 'Qwen/Qwen3.8-27B' }] })
  })

  it('contains early SSH channel termination without an unhandled pipe error', async () => {
    const localPort = await unusedPort()
    const controller = new LoopbackEndpointController(sshArgs())
    controllers.push(controller)
    const selected = route(localPort, 28_000, 'Qwen/Qwen3.8-27B', 'r5300')

    await expect(controller.ensure(selected, 2_000)).resolves.toBe(false)
    await expect(controller.released(selected, 2_000)).resolves.toBe(true)
  })

  it('flushes a successful SSH response before the forwarding child closes', async () => {
    const localPort = await unusedPort()
    const body = 'g'.repeat(2 * 1024 * 1024)
    const controller = new LoopbackEndpointController(sshArgs(), successfulSshSpawner(body))
    controllers.push(controller)
    const selected = route(localPort, 28_000, 'Qwen/Qwen3.8-27B', 'r5300')

    await expect(controller.ensure(selected, 5_000)).resolves.toBe(true)
    const response = await fetch(`http://127.0.0.1:${localPort}/large`)
    await expect(response.text()).resolves.toBe(body)
  })

  it('limits only fragmented HTTP headers when the request body exceeds 64 KiB', async () => {
    const localPort = await unusedPort()
    const controller = new LoopbackEndpointController(sshArgs(), successfulSshSpawner('OK'))
    controllers.push(controller)
    const selected = route(localPort, 28_000, 'Qwen/Qwen3.8-27B', 'r5300')
    await expect(controller.ensure(selected, 5_000)).resolves.toBe(true)
    const body = Buffer.alloc(128 * 1024, 0x61)
    const first = Buffer.from(
      `POST /large-request HTTP/1.1\r\nHost: 127.0.0.1:${localPort}\r\nContent-Length: ${body.length}\r\n`,
      'latin1',
    )
    const response = await fragmentedRequest(localPort, first, Buffer.concat([Buffer.from('\r\n'), body]))

    expect(response.toString('latin1')).toContain('HTTP/1.1 200 OK')
    expect(response.subarray(-2).toString()).toBe('OK')
  })

  it('attempts every endpoint cleanup before reporting shutdown failure', async () => {
    const firstUpstream = await modelServer()
    const secondUpstream = await modelServer()
    const firstPort = await unusedPort()
    const secondPort = await unusedPort()
    const controller = new LoopbackEndpointController(args())
    controllers.push(controller)
    await expect(controller.ensure(route(firstPort, firstUpstream), 2_000)).resolves.toBe(true)
    await expect(controller.ensure(route(secondPort, secondUpstream), 2_000)).resolves.toBe(true)
    type InternalState = { readonly localPort: number }
    const internal = controller as unknown as {
      states: Map<number, InternalState>
      closeState: (state: InternalState, timeoutMs: number) => Promise<boolean>
    }
    const closeState = internal.closeState.bind(controller)
    internal.closeState = async (state, timeoutMs) => state.localPort === firstPort
      ? false : closeState(state, timeoutMs)

    await expect(controller.shutdown()).rejects.toThrow('REMOTE_FAILURE')
    expect(internal.states.has(secondPort)).toBe(false)
    internal.closeState = closeState
  })
})
