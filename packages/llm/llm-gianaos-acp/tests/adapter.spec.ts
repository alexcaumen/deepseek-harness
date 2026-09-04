import { describe, expect, it } from 'vitest'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  AcpTurnBarrier,
  latestAcpBinding,
  latestUserPrompt,
  latestUserPromptContent,
  localSessionTitle,
  projectAcpTurnEvents,
  projectToolActivity,
} from '../src/index.ts'

describe('GianaOS ACP adapter helpers', () => {
  it('waits for remote cancellation settlement before dispatching the next turn', async () => {
    const barrier = new AcpTurnBarrier()
    const releaseFirst = await barrier.enter()
    let secondEntered = false
    const second = barrier.enter().then((release) => {
      secondEntered = true
      release()
    })

    await Promise.resolve()
    expect(secondEntered).toBe(false)
    releaseFirst()
    await second
    expect(secondEntered).toBe(true)
  })

  it('does not strand the ACP turn barrier when a waiting request is cancelled', async () => {
    const barrier = new AcpTurnBarrier()
    const releaseFirst = await barrier.enter()
    const controller = new AbortController()
    const cancelled = barrier.enter(controller.signal)
    controller.abort(new Error('cancelled while waiting'))
    releaseFirst()

    await expect(cancelled).rejects.toThrow('cancelled while waiting')
    const releaseThird = await barrier.enter()
    releaseThird()
  })

  it('forwards only the latest direct human message', () => {
    const first = createUserMessage({
      content: [{ type: 'text', text: 'first' }],
      source: { kind: 'user' },
    })
    const injected = createUserMessage({
      content: [{ type: 'text', text: 'shadow context' }],
      source: { kind: 'plugin', plugin: 'shadow-context' },
    })
    const latest = createUserMessage({
      content: [{ type: 'text', text: 'use every available tool' }],
      source: { kind: 'user' },
    })
    expect(latestUserPrompt([first, injected, latest])).toBe('use every available tool')
  })

  it('forwards image bytes and MIME type from the latest direct human message', async () => {
    const attachment = {
      attachmentId: 'image-1',
      mediaType: 'image/png',
      bytes: 4,
      width: 1,
      height: 1,
    } as ImageAttachmentRef
    const injected = createUserMessage({
      content: [{ type: 'text', text: 'shadow context' }],
      source: { kind: 'plugin', plugin: 'shadow-context' },
    })
    const latest = createUserMessage({
      content: [
        { type: 'text', text: 'What is in this image?' },
        { type: 'image', attachment },
      ],
      source: { kind: 'user' },
    })
    const readImage = async (ref: ImageAttachmentRef) => ({
      ref,
      data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    })
    const attachments = { readImage } as unknown as AttachmentStore

    await expect(latestUserPromptContent([injected, latest], attachments)).resolves.toEqual([
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', data: 'iVBORw==', mimeType: 'image/png' },
    ])
  })

  it('fails closed when an image cannot be resolved by the attachment store', async () => {
    const attachment = {
      attachmentId: 'image-1',
      mediaType: 'image/png',
      bytes: 4,
      width: 1,
      height: 1,
    } as ImageAttachmentRef
    const latest = createUserMessage({
      content: [{ type: 'image', attachment }],
      source: { kind: 'user' },
    })

    await expect(latestUserPromptContent([latest], undefined)).rejects.toMatchObject({
      code: 'MISSING_ATTACHMENT_STORE',
    })
  })

  it('stores and retrieves only a non-secret ACP pointer', () => {
    const session = Session.create(SessionId('local'))
    session.append('gianaos/acp-binding', {
      principalId: 'giana.putri',
      remoteSessionId: 'remote-1',
      routeRevision: 'v1',
    })
    expect(latestAcpBinding(session, 'giana.putri')).toEqual({
      principalId: 'giana.putri',
      remoteSessionId: 'remote-1',
      routeRevision: 'v1',
    })
    expect(JSON.stringify(session.events)).not.toMatch(/Bearer|credential|password/i)
  })

  it('generates deterministic local titles without a second model call', () => {
    const message = createUserMessage({
      content: [{ type: 'text', text: 'Build a complete coding workflow' }],
      source: { kind: 'user' },
    })
    expect(localSessionTitle({
      provider: 'gianaos',
      model: 'putri',
      messages: [message],
      purpose: 'session-title',
    }, 'Putri')).toBe('Build a complete coding workflow')
  })

  it('projects one tool label per ACP call without arguments or result payloads', () => {
    const seen = new Set<string>()
    expect(projectToolActivity('tool_call', 'call-1', seen)).toBe('Giana CoWork tool started.\n')
    expect(projectToolActivity('tool_call_update', 'call-1', seen)).toBe('')
    expect(projectToolActivity('tool_call_update', 'call-2', seen)).toBe('Giana CoWork tool activity updated.\n')
    expect(projectToolActivity('tool_call', 'call-2', seen)).toBe('')
  })

  it('projects interleaved fake ACP deltas exactly once into one block per kind', async () => {
    async function* fakeAcpStream() {
      yield { kind: 'reasoning' as const, text: 'Kal minta ' }
      yield { kind: 'text' as const, text: 'Jawaban ' }
      yield { kind: 'reasoning' as const, text: 'cek lanjut. ' }
      yield { kind: 'text' as const, text: 'final.' }
    }

    const chunks = []
    for await (const chunk of projectAcpTurnEvents(fakeAcpStream())) chunks.push(chunk)

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'Kal minta ' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Jawaban ' },
      { type: 'reasoning-delta', index: 0, text: 'cek lanjut. ' },
      { type: 'text-delta', index: 1, text: 'final.' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Kal minta cek lanjut. ' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Jawaban final.' } },
    ])
    expect(chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'text')).toHaveLength(1)

    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    assembler.push({ type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } })
    assembler.push({ type: 'finish', reason: { kind: 'stop' } })
    expect(assembler.message({ kind: 'model', provider: 'gianaos', model: 'putri' }).content).toEqual([
      { type: 'reasoning', text: 'Kal minta cek lanjut. ' },
      { type: 'text', text: 'Jawaban final.' },
    ])
  })

  it('resets projected text at each ACP turn boundary', async () => {
    async function collect(text: string) {
      async function* fakeAcpStream() {
        yield { kind: 'text' as const, text }
      }
      const chunks = []
      for await (const chunk of projectAcpTurnEvents(fakeAcpStream())) chunks.push(chunk)
      return chunks
    }

    const first = await collect('first answer')
    const second = await collect('second answer')
    expect(first.at(-1)).toEqual({
      type: 'block-end', index: 0, block: { type: 'text', text: 'first answer' },
    })
    expect(second.at(-1)).toEqual({
      type: 'block-end', index: 0, block: { type: 'text', text: 'second answer' },
    })
  })
})
