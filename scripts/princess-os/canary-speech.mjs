import { readFile } from 'node:fs/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
  const separator = entry.indexOf('=')
  if (separator === -1) return [entry.replace(/^--/, ''), 'true']
  return [entry.slice(0, separator).replace(/^--/, ''), entry.slice(separator + 1)]
}))

const baseURL = (args.url ?? 'http://127.0.0.1:17302').replace(/\/$/, '')
const outputRoot = resolve(args.output
  ?? 'N:\\PrincessOS\\workbench\\dsh-capability-parity\\speech-canary')
const receiptPath = resolve(outputRoot, 'speech-canary.json')
const audioPath = resolve(outputRoot, 'speech-roundtrip.mp3')
const phrase = 'Selamat pagi, Giana Code siap membantu pekerjaan dalam bahasa Indonesia.'

await mkdir(outputRoot, { recursive: true })
const health = await getJSON('/health')
const compute = await getJSON('/v1/compute')

const ttsStartedAt = performance.now()
const ttsResponse = await fetch(`${baseURL}/v1/tts/synthesize`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: phrase, voice: 'id-ID-GadisNeural' }),
})
if (!ttsResponse.ok) throw new Error(`TTS returned ${ttsResponse.status}: ${await ttsResponse.text()}`)
const ttsEngine = ttsResponse.headers.get('x-giana-speech-engine') ?? 'unknown'
const audio = Buffer.from(await ttsResponse.arrayBuffer())
const ttsDurationMs = Math.round(performance.now() - ttsStartedAt)
await writeFile(audioPath, audio)

const form = new FormData()
form.append('language', 'id')
form.append('audio', new Blob([await readFile(audioPath)], { type: 'audio/mpeg' }), 'speech-roundtrip.mp3')
const sttStartedAt = performance.now()
const sttResponse = await fetch(`${baseURL}/v1/stt/transcribe`, { method: 'POST', body: form })
const stt = await sttResponse.json().catch(() => ({}))
const sttDurationMs = Math.round(performance.now() - sttStartedAt)
if (!sttResponse.ok) throw new Error(`STT returned ${sttResponse.status}: ${JSON.stringify(stt)}`)
const postHealth = await getJSON('/health')

const transcript = String(stt.text ?? '')
const checks = {
  serviceReady: health.state === 'ready',
  qwenComputeRouteReady: compute.routes?.['qwen-3.8-27b'] === 'ready',
  localGpuObserved: compute.local?.state === 'ready' && compute.local?.gpus?.length > 0,
  r5300Observed: compute.r5300?.state === 'ready',
  ttsReturnedAudio: audio.length > 1000,
  indonesianTtsEngineSelected: /DOTS|Indonesian/i.test(ttsEngine),
  sttReturnedText: transcript.length > 10,
  sttLanguageIndonesian: stt.language === 'id',
  gianaVocabularyPreserved: /Giana Code/i.test(transcript),
  postInferenceDeviceBound: postHealth.stt?.device !== 'unloaded',
}
const dots = {
  state: compute.routes?.['dots-tts'] ?? health.tts?.state ?? 'unknown',
  active: ttsEngine === 'DOTS',
  finitePredicate: ttsEngine === 'DOTS'
    ? undefined
    : 'CURRENT_READY_DOTS_TTS_RUNTIME_ROUTE_ENDPOINT_WITH_ROUTE_ADMISSION_AND_HEALTH_PROOF_MISSING',
}
const receipt = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  baseURL,
  checks,
  pass: Object.values(checks).every(Boolean),
  health,
  postHealth,
  compute,
  tts: { engine: ttsEngine, bytes: audio.length, durationMs: ttsDurationMs, audioPath },
  stt: { ...stt, durationMs: sttDurationMs },
  dots,
}

await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
if (!receipt.pass) process.exitCode = 1

async function getJSON(path) {
  const response = await fetch(`${baseURL}${path}`)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(payload)}`)
  return payload
}
