/** Real child process that holds one live session's JSONL write lease. */

import { createInterface } from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '../../src/index.ts'

const [root, rawId] = process.argv.slice(2)
if (root === undefined || rawId === undefined) throw new Error('expected root and session id')
const id = SessionId(rawId)

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })

let session: Session | undefined
const owner = await ctx.plugin(Object.assign((inner: Context) => {
  session = inner.sessions.create(id, { meta: { cwd: '/work' } })
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}, { inject: ['sessions'] }))
if (session === undefined) throw new Error('session owner did not create its session')
await ctx.sessions.flush(session)
process.stdout.write(`holding:${session.events.length}\n`)

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  if (line !== 'close') continue
  await owner.dispose()
  // load waits for the coordinator's asynchronous retirement to finish.
  await ctx.sessionPersistence.load(id)
  process.stdout.write('closed\n')
}

await ctx.fiber.dispose()
