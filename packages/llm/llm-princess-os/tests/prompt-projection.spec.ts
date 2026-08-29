import type { Message } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import { AcpTurnEventQueue, projectConversation } from '../src/index'

function message(id: string, role: Message['role'], text: string): Message {
  return {
    id,
    role,
    content: [{ type: 'text', text }],
    source: { type: 'user' },
  } as unknown as Message
}

describe('Princess OS conversation projection', () => {
  it('forwards human conversation without Harness system/context injection', () => {
    const projected = projectConversation([
      message('system', 'system', 'HARNESS SYSTEM CONTEXT'),
      message('user', 'user', 'hello'),
      message('assistant', 'assistant', 'ready'),
    ])

    expect(projected).toBe('USER: hello\n\nASSISTANT: ready')
    expect(projected).not.toContain('HARNESS SYSTEM CONTEXT')
  })

  it('drops empty system-only projections', () => {
    expect(projectConversation([
      message('system', 'system', 'SKILL CATALOG'),
    ])).toBe('')
  })
})

describe('Princess OS ACP streaming queue', () => {
  it('delivers the first chunk before the producer closes', async () => {
    const queue = new AcpTurnEventQueue()
    const iterator = queue[Symbol.asyncIterator]()
    const first = iterator.next()

    queue.push({ kind: 'text', text: 'first' })

    await expect(first).resolves.toEqual({
      done: false,
      value: { kind: 'text', text: 'first' },
    })
    queue.close()
  })

  it('preserves event order and ignores empty chunks', async () => {
    const queue = new AcpTurnEventQueue()
    queue.push({ kind: 'reasoning', text: 'think' })
    queue.push({ kind: 'text', text: '' })
    queue.push({ kind: 'text', text: 'answer' })
    queue.close()

    const received = []
    for await (const event of queue) received.push(event)

    expect(received).toEqual([
      { kind: 'reasoning', text: 'think' },
      { kind: 'text', text: 'answer' },
    ])
  })
})
