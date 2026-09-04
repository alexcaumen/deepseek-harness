/** Keyless model and separate-process MCP transcript through the real headless Loader tree. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

interface Evidence {
  type: 'mcp-ptc'
  mode: string
  sessionId: string
  modelTools: ToolSchema[]
  sdk: string
  remote: {
    tools: { name: string; description: string; inputSchema: Record<string, unknown> }[]
    direct: { structuredContent: { result: ToolExecutionResult } }
    code: { structuredContent: { result: ToolExecutionResult } }
  }
}

const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/mcp-ptc.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

it('projects scoped native/code/both to a real model request and external MCP client', async () => {
  const modes: unknown[] = []
  let canonicalSdk = ''
  for (const mode of ['native', 'code', 'both'] as const) {
    let persisted: SessionEvent[] = []
    const env: NodeJS.ProcessEnv = {
      DSH_MCP_PTC_MODE: mode, DSH_SNAPSHOT: 'replay', TSX_DISABLE_CACHE: '1',
      NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
    }
    for (const key of Object.keys(process.env)) {
      if (/KEY|SECRET|TOKEN|PASSWORD|PROXY/i.test(key)) env[key] = ''
    }
    const { stdout, stderr } = await runLoaderSmoke({
      label: `headless MCP PTC ${mode}`, tempDirPrefix: 'mcp-ptc-',
      binScript, configPath, tsconfigPath, mode: 'src',
      binArgs: [configPath, 'Exercise the exact scoped echo.'], env,
      inspect: async (cwd) => {
        const files = await readdir(join(cwd, '.sessions'), { recursive: true })
        const logs = files.filter(file => file.endsWith('.jsonl'))
        expect(logs).toHaveLength(1)
        const lines = (await readFile(join(cwd, '.sessions', logs[0]!), 'utf8')).trim().split('\n')
        persisted = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
      },
    })
    expect(stderr).toBe('')
    const lines = stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const evidence = lines.find(line => line.type === 'mcp-ptc') as unknown as Evidence
    expect(evidence).toBeDefined()
    const events = lines.filter(line => line.type === 'session_event').map(line => line.event as SessionEvent)
    const expectedNames = mode === 'native' ? ['ptc_echo'] : mode === 'code' ? ['run_code'] : ['ptc_echo', 'run_code']
    expect(evidence.modelTools.map(tool => tool.name)).toEqual(expectedNames)
    expect(evidence.remote.tools.map(tool => tool.name)).toEqual(expectedNames)
    for (const tool of evidence.remote.tools) {
      const modelTool = evidence.modelTools.find(item => item.name === tool.name)!
      expect(tool.inputSchema).toEqual(modelTool.parameters)
      expect(tool.description).toBe(modelTool.description + (tool.name === 'run_code' ? `\n\n${evidence.sdk}` : ''))
    }
    if (mode === 'native') expect(evidence.sdk).toBe('')
    else {
      expect(evidence.sdk).toContain('message: string;')
      expect(evidence.sdk).toContain('count: number;')
      expect(evidence.sdk).toContain('echoed: string;')
      expect(evidence.sdk).not.toMatch(/ptc_hidden|run_code\s*:|\bunknown\b/)
      if (canonicalSdk) expect(evidence.sdk).toBe(canonicalSdk)
      canonicalSdk = evidence.sdk
    }
    const direct = evidence.remote.direct.structuredContent.result
    const code = evidence.remote.code.structuredContent.result
    expect(direct).toMatchObject(mode === 'code'
      ? { isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } }
      : { isError: false, value: { echoed: 'remote-native', count: 2 } })
    expect(code).toMatchObject(mode === 'native'
      ? { isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } }
      : { isError: false, value: { logs: [], result: { value: { echoed: 'remote-code', count: 3 }, bindings: ['ptc_echo'] } } })

    const header = events.find(event => event.type === 'request/header')
    expect(header?.type).toBe('request/header')
    if (header?.type === 'request/header') {
      expect(header.data.header.tools).toEqual(evidence.modelTools)
      if (mode !== 'native') expect(header.data.header.system).toContain(evidence.sdk)
    }
    const dispatches = events.filter(event => event.type === 'tool/code-dispatch')
    expect(dispatches).toHaveLength(mode === 'native' ? 0 : 2)
    for (const event of dispatches) {
      expect(event.data.name).toBe('ptc_echo')
      expect(event.data.isError).toBe(false)
    }
    expect(persisted.filter(event => event.type === 'request/header' || event.type === 'tool/code-dispatch'))
      .toEqual(events.filter(event => event.type === 'request/header' || event.type === 'tool/code-dispatch'))
    const result = lines.at(-1)!
    expect(result.type).toBe('result')
    expect(result.sessionId).toBe(evidence.sessionId)
    expect(JSON.parse(String(result.output))).toEqual({ echoed: 'model', count: 1 })
    modes.push({
      mode, modelTools: evidence.modelTools.map(tool => tool.name),
      remoteTools: evidence.remote.tools.map(tool => tool.name),
      direct, code,
      dispatches: dispatches.map(event => ({ name: event.data.name, arguments: event.data.arguments, content: event.data.content })),
      modelOutput: JSON.parse(String(result.output)) as unknown,
    })
  }
  expect({ sdk: canonicalSdk, modes }).toMatchInlineSnapshot(`
    {
      "modes": [
        {
          "code": {
            "content": [
              {
                "text": "Error: unknown tool "run_code"",
                "type": "text",
              },
            ],
            "error": {
              "info": {
                "code": "UNKNOWN_TOOL",
                "name": "ToolNotFoundError",
              },
              "message": "unknown tool "run_code"",
            },
            "isError": true,
          },
          "direct": {
            "content": [
              {
                "text": "{"echoed":"remote-native","count":2}",
                "type": "text",
              },
            ],
            "isError": false,
            "value": {
              "count": 2,
              "echoed": "remote-native",
            },
          },
          "dispatches": [],
          "mode": "native",
          "modelOutput": {
            "count": 1,
            "echoed": "model",
          },
          "modelTools": [
            "ptc_echo",
          ],
          "remoteTools": [
            "ptc_echo",
          ],
        },
        {
          "code": {
            "content": [
              {
                "text": "{
      "value": {
        "echoed": "remote-code",
        "count": 3
      },
      "bindings": [
        "ptc_echo"
      ]
    }",
                "type": "text",
              },
            ],
            "isError": false,
            "value": {
              "logs": [],
              "result": {
                "bindings": [
                  "ptc_echo",
                ],
                "value": {
                  "count": 3,
                  "echoed": "remote-code",
                },
              },
            },
          },
          "direct": {
            "content": [
              {
                "text": "Error: unknown tool "ptc_echo"",
                "type": "text",
              },
            ],
            "error": {
              "info": {
                "code": "UNKNOWN_TOOL",
                "name": "ToolNotFoundError",
              },
              "message": "unknown tool "ptc_echo"",
            },
            "isError": true,
          },
          "dispatches": [
            {
              "arguments": {
                "count": 3,
                "message": "remote-code",
              },
              "content": [
                {
                  "text": "{"echoed":"remote-code","count":3}",
                  "type": "text",
                },
              ],
              "name": "ptc_echo",
            },
            {
              "arguments": {
                "count": 1,
                "message": "model",
              },
              "content": [
                {
                  "text": "{"echoed":"model","count":1}",
                  "type": "text",
                },
              ],
              "name": "ptc_echo",
            },
          ],
          "mode": "code",
          "modelOutput": {
            "count": 1,
            "echoed": "model",
          },
          "modelTools": [
            "run_code",
          ],
          "remoteTools": [
            "run_code",
          ],
        },
        {
          "code": {
            "content": [
              {
                "text": "{
      "value": {
        "echoed": "remote-code",
        "count": 3
      },
      "bindings": [
        "ptc_echo"
      ]
    }",
                "type": "text",
              },
            ],
            "isError": false,
            "value": {
              "logs": [],
              "result": {
                "bindings": [
                  "ptc_echo",
                ],
                "value": {
                  "count": 3,
                  "echoed": "remote-code",
                },
              },
            },
          },
          "direct": {
            "content": [
              {
                "text": "{"echoed":"remote-native","count":2}",
                "type": "text",
              },
            ],
            "isError": false,
            "value": {
              "count": 2,
              "echoed": "remote-native",
            },
          },
          "dispatches": [
            {
              "arguments": {
                "count": 3,
                "message": "remote-code",
              },
              "content": [
                {
                  "text": "{"echoed":"remote-code","count":3}",
                  "type": "text",
                },
              ],
              "name": "ptc_echo",
            },
            {
              "arguments": {
                "count": 1,
                "message": "model",
              },
              "content": [
                {
                  "text": "{"echoed":"model","count":1}",
                  "type": "text",
                },
              ],
              "name": "ptc_echo",
            },
          ],
          "mode": "both",
          "modelOutput": {
            "count": 1,
            "echoed": "model",
          },
          "modelTools": [
            "ptc_echo",
            "run_code",
          ],
          "remoteTools": [
            "ptc_echo",
            "run_code",
          ],
        },
      ],
      "sdk": "## Writing code for run_code

    \`run_code\` takes two required arguments: \`code\` — the body of an async TypeScript function (erasable syntax only — no \`enum\` or namespaces; type annotations are advisory, the code runs type-stripped) — and \`description\`, a short summary of what the program does. Inside the program:

    - Call tools as \`await tools.name(args)\` — quoted access for exotic names: \`tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value. Tool arguments must be lossless JSON.
    - A FAILED tool call rejects with \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose \`message\` is human-readable — \`try/catch\` it to handle and continue.
    - Independent read-only calls MAY overlap under \`Promise.all\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
    - Emit results with \`return\` and/or \`console.log(...)\`. Only what you print or return is program output. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need.

    The available tools:

    \`\`\`ts
    type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

    interface ToolArgsMap {
      /** Echo the exact typed payload. */
      ptc_echo: {
        message: string;
        count: number;
      } & Record<string, JsonValue>;
    }

    interface ToolOutputMap {
      ptc_echo: {
        echoed: string;
        count: number;
      };
    }

    type ToolName = keyof ToolOutputMap

    declare class ToolCallError extends Error {
      readonly name: "ToolCallError";
      readonly toolName: ToolName;
    }

    declare const tools: {
      [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;
    }
    \`\`\`",
    }
  `)
})
