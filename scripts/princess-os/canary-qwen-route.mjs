import { readFile } from 'node:fs/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
  const separator = entry.indexOf('=')
  if (separator === -1) return [entry.replace(/^--/, ''), 'true']
  return [entry.slice(0, separator).replace(/^--/, ''), entry.slice(separator + 1)]
}))

const baseURL = (args.url ?? 'http://127.0.0.1:18000/v1').replace(/\/$/, '')
const model = args.model ?? 'Qwen/Qwen3.8-27B'
const imagePath = resolve(args.image
  ?? 'N:\\PrincessOS\\workbench\\dsh-capability-parity\\execution-20260823\\heqa-packaged-final\\desktop-details-open.png')
const outputRoot = resolve(args.output
  ?? 'N:\\PrincessOS\\workbench\\dsh-capability-parity\\qwen-route-canary')
const receiptPath = resolve(outputRoot, 'qwen-route-canary.json')

await mkdir(outputRoot, { recursive: true })

const models = await request('/models')
const listedModel = models.data?.find((entry) => entry.id === model)

const text = await request('/chat/completions', {
  model,
  messages: [{ role: 'user', content: 'Jawab persis: GIANA_QWEN_TEXT_PASS' }],
  max_tokens: 64,
})

const singleTool = await request('/chat/completions', {
  model,
  messages: [{ role: 'user', content: 'Panggil tool add dengan a=2 dan b=3. Jangan jawab sendiri.' }],
  tools: [{
    type: 'function',
    function: {
      name: 'add',
      description: 'Add two numbers.',
      parameters: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
    },
  }],
  tool_choice: { type: 'function', function: { name: 'add' } },
  max_tokens: 128,
})

const multiTool = await request('/chat/completions', {
  model,
  messages: [{
    role: 'user',
    content: 'Panggil dua tool secara paralel: add dengan a=2,b=3 dan multiply dengan a=4,b=5. Jangan hitung sendiri.',
  }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'add',
        description: 'Add two numbers.',
        parameters: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'multiply',
        description: 'Multiply two numbers.',
        parameters: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
        },
      },
    },
  ],
  tool_choice: 'auto',
  max_tokens: 192,
})

const imageBytes = await readFile(imagePath)
const imageMime = extname(imagePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'
const vision = await request('/chat/completions', {
  model,
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'Baca screenshot ini. Sebut nama aplikasi yang terlihat dan apakah panel Files terlihat.' },
      { type: 'image_url', image_url: { url: `data:${imageMime};base64,${imageBytes.toString('base64')}` } },
    ],
  }],
  max_tokens: 192,
})

const streamResponse = await fetch(`${baseURL}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Jawab singkat: STREAM_PASS' }],
    stream: true,
    max_tokens: 32,
  }),
})
const streamText = await streamResponse.text()

const cancellation = await cancellationCanary()
const textContent = messageContent(text)
const visionContent = messageContent(vision)
const singleCalls = toolCalls(singleTool)
const multiCalls = toolCalls(multiTool)
const checks = {
  modelDiscovered: Boolean(listedModel),
  exactRevisionPathObserved: listedModel?.root === '/models/Qwen3.8-27B',
  textResponsePassed: textContent.includes('GIANA_QWEN_TEXT_PASS'),
  singleToolCallPassed: singleCalls.length === 1 && singleCalls[0]?.function?.name === 'add',
  multiToolCallPassed: new Set(multiCalls.map(call => call.function?.name)).size === 2,
  visionPassed: /Giana(?: Code| Windows)?/i.test(visionContent) && /Files/i.test(visionContent),
  streamingPassed: streamResponse.ok && streamText.includes('data:') && streamText.includes('[DONE]'),
  cancellationPassed: cancellation.aborted,
}
const receipt = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  baseURL,
  model,
  modelEvidence: listedModel,
  runtimeFingerprint: text.system_fingerprint,
  checks,
  pass: Object.values(checks).every(Boolean),
  evidence: {
    text: textContent,
    singleToolCalls: singleCalls,
    multiToolCalls: multiCalls,
    vision: visionContent,
    streamChunkCount: streamText.split('\n').filter(line => line.startsWith('data:')).length,
    cancellation,
    imagePath,
  },
}

await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
if (!receipt.pass) process.exitCode = 1

async function request(path, body) {
  const response = await fetch(`${baseURL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${JSON.stringify(payload)}`)
  }
  return payload
}

function messageContent(response) {
  const content = response.choices?.[0]?.message?.content
  return typeof content === 'string' ? content : JSON.stringify(content ?? '')
}

function toolCalls(response) {
  return response.choices?.[0]?.message?.tool_calls ?? []
}

async function cancellationCanary() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25)
  try {
    await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Tulis analisis sangat panjang tentang sistem industri.' }],
        max_tokens: 4096,
      }),
    })
    return { aborted: false, reason: 'request-completed-before-abort' }
  } catch (error) {
    return { aborted: error?.name === 'AbortError', reason: error?.name ?? String(error) }
  } finally {
    clearTimeout(timer)
  }
}
