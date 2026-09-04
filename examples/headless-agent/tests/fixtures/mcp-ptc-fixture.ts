/** Loader-owned scripted provider and scoped echo tools for the assembled MCP regression. */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolPresentationMode } from '@deepseek-ai/dsh-tools'
import type {} from '../../../../packages/mcp/mcp-server-tool-runtime/src/index.ts'

const clientPath = fileURLToPath(new URL('./mcp-ptc-client.mjs', import.meta.url))

class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly ctx: Context, private readonly mode: ToolPresentationMode) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const toolResult = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
    if (toolResult !== undefined) {
      const text = toolResult.content.filter(block => block.type === 'text').map(block => block.text).join('')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    const agent = this.ctx.agents.requireInitiator()
    assert.equal(options.sessionId, agent.session.id)
    assert.equal(this.ctx.agents.get(agent.id), agent)
    assert.equal(this.ctx.sessions.get(agent.session.id), agent.session)
    assert.equal(this.ctx.codeRuntime.isolation, 'worker-thread')
    const capability = this.ctx.mcpToolRuntime.issue(agent)
    let remote: unknown
    try {
      const result = await execa(process.execPath, [clientPath], {
        input: JSON.stringify({ endpoint: capability.endpoint, token: capability.token }),
        timeout: 20000,
        killSignal: 'SIGKILL',
      })
      assert.equal(result.stderr, '')
      remote = JSON.parse(result.stdout) as unknown
    } finally {
      await capability.revoke()
    }
    const sdk = this.ctx.tools.codeSdk(agent)
    assert.equal((options.system ?? '').includes(sdk), true)
    process.stdout.write(`${JSON.stringify({
      type: 'mcp-ptc', mode: this.mode, sessionId: agent.session.id,
      modelTools: options.tools ?? [], sdk, remote,
    })}\n`)

    const name = this.mode === 'native' ? 'ptc_echo' : 'run_code'
    const args = this.mode === 'native'
      ? { message: 'model', count: 1 }
      : { code: 'return await tools.ptc_echo({ message: "model", count: 1 });', description: 'Echo through the model worker call' }
    const argumentsText = JSON.stringify(args)
    const id = CallId('model-echo')
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export const name = 'mcp-ptc-fixture'
export const inject = ['llm', 'tools', 'agents', 'sessions', 'mcpToolRuntime', 'codeRuntime']

/** Install scoped policy on the real agent, regardless of concurrent Loader entry activation order. */
export function apply(ctx: Context): void {
  const mode = process.env.DSH_MCP_PTC_MODE
  assert.ok(mode === 'native' || mode === 'code' || mode === 'both')
  ctx.llm.registerAdapter(['mcp-ptc-script'], new ScriptedAdapter(ctx, mode))
  ctx.tools.register(defineTool({
    name: 'ptc_hidden', description: 'Must not reach the scoped SDK.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { throw new Error('hidden tool must never execute') },
  }))
  const configured = new WeakSet<Agent>()
  const configure = (agent: Agent): void => {
    if (configured.has(agent)) return
    configured.add(agent)
    agent.ctx.tools.register(defineTool({
      name: 'ptc_echo', description: 'Echo the exact typed payload.',
      parameters: {
        message: { type: 'string', required: true },
        count: { type: 'integer', required: true },
      },
      output: {
        schema: {
          type: 'object',
          properties: { echoed: { type: 'string', required: true }, count: { type: 'integer', required: true } },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        assert.equal(exec.agent, agent)
        assert.equal(ctx.agents.requireInitiator(), agent)
        assert.equal(ctx.sessions.get(agent.session.id), agent.session)
        return { echoed: args.message, count: args.count }
      },
    }))
    agent.ctx.tools.restrict({ allow: [] })
    agent.ctx.tools.presentAs(mode)
  }
  ctx.on('agent/created', ({ agent }) => { configure(agent) })
  for (const agent of ctx.agents.roots()) configure(agent)
}
