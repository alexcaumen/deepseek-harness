// @vitest-environment jsdom
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  ConversationSnapshot, SessionId, SessionListState, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import type { RpcReceipt } from '@deepseek-ai/dsh-api-remotes/client'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { PendingQuestion, type QuestionComposerProps } from '../src/client/contract/slots.ts'
import { QuestionComposer, parseRecommendedLabel } from '../src/client/QuestionComposer.tsx'
import { en, zh } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  FakeMediaRecorder.instances.length = 0
})

const SID = 's1' as SessionId

/** Seat stub over a dictionary pair mirroring the real lookup chain: package dictionary, then common vocabulary, then the key. */
const seatOver = (dict: Record<string, string>, common: Record<string, string>): QuestionComposerProps['t'] =>
  ((key, params) => Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    dict[key] ?? common[key] ?? key,
  ))

/** Deferred operation used to hold permission and transcription phases visibly in tests. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Install one test-owned mediaDevices facade and restore the native descriptor afterwards. */
function installMediaDevices(getUserMedia: () => Promise<MediaStream>): void {
  const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  })
  onTestFinished(() => {
    if (original === undefined) delete (navigator as { mediaDevices?: MediaDevices }).mediaDevices
    else Object.defineProperty(navigator, 'mediaDevices', original)
  })
}

/** MediaRecorder fixture that emits one audio chunk synchronously when stopped. */
class FakeMediaRecorder {
  static readonly instances: FakeMediaRecorder[] = []
  static isTypeSupported = vi.fn(() => true)
  readonly mimeType = 'audio/webm;codecs=opus'
  state: RecordingState = 'inactive'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onstop: (() => void) | null = null
  constructor(readonly stream: MediaStream, readonly options?: MediaRecorderOptions) {
    FakeMediaRecorder.instances.push(this)
  }
  start(): void { this.state = 'recording' }
  stop(): void {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['audio']) } as BlobEvent)
    this.onstop?.()
  }
}

/** Recorder fixture whose already-queued stop callback runs after an error. */
class ErrorThenStopMediaRecorder extends FakeMediaRecorder {
  override stop(): void {
    this.state = 'inactive'
    const queuedStop = this.onstop
    this.onerror?.({ error: new DOMException('capture lost', 'UnknownError') } as unknown as Event)
    queuedStop?.()
  }
}

/** Framework standard-kit stubs: the composer consumes only the locale seat;
 *  the composed props type mandates delivery of the rest (framework hooks are
 *  plain stubs per the client testing discipline). */
const kit = {
  session: undefined,
  sessionId: SID,
  useSession: (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<ConversationSnapshot>,
  useSessions: (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<SessionListState>,
  useWorkspaces: (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<WorkspaceListState>,
  useProjection: (() => undefined) as never,
  useInput: (() => { throw new Error('unused') }) as never,
  inputActions: { setDraft: () => { throw new Error('unused') }, submit: () => { throw new Error('unused') } } as never,
  // The seat's key domain is question ∪ common.
  t: seatOver(zh, commonZh),
}

const QUESTIONS = [
  {
    id: 'profile', header: '偏好', question: '选择候选人类型',
    detail: '按当前空缺岗位的优先级选择。',
    options: [
      { label: '工程落地型 (Recommended)', description: '优先工程交付。' },
      { label: '研究潜力型', description: '优先研究能力。' },
    ],
  },
  {
    id: 'detail', question: '补充你的要求',
  },
  {
    id: 'signals', question: '选择重要信号（可多选）', multiSelect: true,
    options: [{ label: '系统设计' }, { label: '代码质量' }, { label: '产品判断' }],
  },
]

/** Carrier fixture: a real PendingWait over a scripted respond carrier. */
function wait(rpcId = 'question-1', respond = vi.fn(() => Promise.resolve<RpcReceipt>({ accepted: true }))) {
  const carrier = new PendingWait(
    'question', RpcId(rpcId), SID, { questions: QUESTIONS }, respond)
  return { carrier, respond }
}

/** The client-response envelope respond must have received for an answer batch. */
function answeredEnvelope(rpcId: string, answers: object[]) {
  return {
    type: 'client-response', rpcId: RpcId(rpcId),
    result: { ok: true, value: { sessionId: SID, answer: { answers } } },
  }
}

describe('QuestionComposer', () => {
  it('dictates a custom answer through permission, recording, transcription, and success', async () => {
    const permission = deferred<MediaStream>()
    const transcription = deferred<Response>()
    const stopTrack = vi.fn()
    installMediaDevices(() => permission.promise)
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('__GIANA_WINDOWS_RUNTIME__', {
      routes: { 'speech.transcribe.id-ID': 'http://127.0.0.1:18444/speech/transcribe' },
    })
    const fetchMock = vi.fn(() => transcription.promise)
    vi.stubGlobal('fetch', fetchMock)

    const { carrier } = wait()
    render(<QuestionComposer matched={carrier} interactions={[carrier]} {...kit} />)
    const answer = screen.getByPlaceholderText<HTMLTextAreaElement>('输入你的答案')
    fireEvent.change(answer, { target: { value: '已有要求' } })
    fireEvent.click(screen.getByRole('button', { name: zh['custom.dictation.start'] }))
    expect(screen.getByText(zh['custom.dictation.requestingPermission'])).toBeTruthy()

    permission.resolve({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream)
    const stop = await screen.findByRole('button', { name: zh['custom.dictation.stop'] })
    expect(stop.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(`${zh['custom.dictation.recording']} 00:00`)).toBeTruthy()

    fireEvent.click(stop)
    expect(await screen.findByText(zh['custom.dictation.transcribing'])).toBeTruthy()
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:18444/speech/transcribe')
    expect(init.method).toBe('POST')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const form = init.body as FormData
    expect(form.get('language')).toBe('auto')
    expect(form.get('audio')).toBeInstanceOf(Blob)

    transcription.resolve({
      ok: true,
      json: () => Promise.resolve({ text: 'jawaban lewat suara' }),
    } as Response)
    expect(await screen.findByText(zh['custom.dictation.success'])).toBeTruthy()
    expect(answer.value).toBe('已有要求 jawaban lewat suara')
    expect(document.activeElement).toBe(answer)
  })

  it('retries microphone permission and a failed transcription without losing the audio', async () => {
    const stopTrack = vi.fn()
    const getUserMedia = vi.fn()
      .mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
      .mockResolvedValueOnce({ getTracks: () => [{ stop: stopTrack }] })
    installMediaDevices(getUserMedia)
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ text: 'coba lagi' }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const { carrier } = wait()
    render(<QuestionComposer matched={carrier} interactions={[carrier]} {...kit} />)
    fireEvent.click(screen.getByRole('button', { name: zh['custom.dictation.start'] }))
    expect((await screen.findByRole('alert')).textContent).toContain('听写失败：NotAllowedError: denied')

    fireEvent.click(screen.getByRole('button', { name: zh['custom.dictation.retry'] }))
    const stop = await screen.findByRole('button', { name: zh['custom.dictation.stop'] })
    fireEvent.click(stop)
    expect((await screen.findByRole('alert')).textContent).toContain('听写失败：HTTP 503')

    fireEvent.click(screen.getByRole('button', { name: zh['custom.dictation.retry'] }))
    expect(await screen.findByText(zh['custom.dictation.success'])).toBeTruthy()
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>('输入你的答案').value).toBe('coba lagi')
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(stopTrack).toHaveBeenCalledOnce()
  })

  it('cancels a pending permission request and releases a late microphone stream', async () => {
    const permission = deferred<MediaStream>()
    const stopTrack = vi.fn()
    installMediaDevices(() => permission.promise)
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { carrier } = wait()
    render(<QuestionComposer matched={carrier} interactions={[carrier]} {...kit} />)
    const answer = screen.getByPlaceholderText('输入你的答案')
    fireEvent.click(screen.getByRole('button', { name: zh['custom.dictation.start'] }))
    expect(screen.getByText(zh['custom.dictation.requestingPermission'])).toBeTruthy()
    fireEvent.keyDown(answer, { key: 'Escape' })
    expect(screen.queryByText(zh['custom.dictation.requestingPermission'])).toBeNull()

    permission.resolve({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream)
    await vi.waitFor(() => { expect(stopTrack).toHaveBeenCalledOnce() })
    expect(FakeMediaRecorder.instances).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores an onstop callback already queued behind a recorder error', async () => {
    const stopTrack = vi.fn()
    installMediaDevices(() => Promise.resolve({
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream))
    vi.stubGlobal('MediaRecorder', ErrorThenStopMediaRecorder)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { carrier } = wait()
    render(<QuestionComposer matched={carrier} interactions={[carrier]} {...kit} />)
    fireEvent.click(screen.getByRole('button', { name: zh['custom.dictation.start'] }))
    const stop = await screen.findByRole('button', { name: zh['custom.dictation.stop'] })
    fireEvent.click(stop)

    expect((await screen.findByRole('alert')).textContent).toContain('听写失败：capture lost')
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stops an active recording when navigation replaces the answer field', async () => {
    const stopTrack = vi.fn()
    installMediaDevices(() => Promise.resolve({
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream))
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { carrier } = wait()
    render(<QuestionComposer matched={carrier} interactions={[carrier]} {...kit} />)
    fireEvent.click(screen.getByRole('button', { name: zh['custom.dictation.start'] }))
    await screen.findByRole('button', { name: zh['custom.dictation.stop'] })
    fireEvent.click(screen.getByRole('radio', { name: /工程落地型/ }))

    expect(screen.getByText('2 / 3')).toBeTruthy()
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(FakeMediaRecorder.instances[0]?.state).toBe('inactive')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts an in-flight transcription when the question composer unmounts', async () => {
    const stopTrack = vi.fn()
    installMediaDevices(() => Promise.resolve({
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream))
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    let requestSignal: AbortSignal | undefined
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    })
    vi.stubGlobal('fetch', fetchMock)

    const { carrier } = wait()
    const view = render(<QuestionComposer matched={carrier} interactions={[carrier]} {...kit} />)
    fireEvent.click(screen.getByRole('button', { name: zh['custom.dictation.start'] }))
    const stop = await screen.findByRole('button', { name: zh['custom.dictation.stop'] })
    fireEvent.click(stop)
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledOnce() })
    expect(requestSignal?.aborted).toBe(false)

    view.unmount()
    expect(requestSignal?.aborted).toBe(true)
    expect(stopTrack).toHaveBeenCalledOnce()
  })

  it('collects single, custom, and multi-select answers before one batch submit', () => {
    const { carrier, respond } = wait()
    render(<QuestionComposer matched={carrier} interactions={[carrier]} {...kit} />)

    expect(screen.getByText('偏好')).toBeTruthy()
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(screen.getByText('推荐')).toBeTruthy()
    expect(screen.getByText('工程落地型')).toBeTruthy()
    const detail = screen.getByText('按当前空缺岗位的优先级选择。')
    const scrollRegion = detail.closest('[data-question-scroll]')
    expect(scrollRegion).toBeTruthy()
    expect(scrollRegion?.contains(screen.getByRole('radio', { name: /工程落地型/ }))).toBe(true)
    expect(scrollRegion?.contains(screen.getByText('下一题').closest('button'))).toBe(false)
    fireEvent.keyDown(screen.getByRole('radio', { name: /工程落地型/ }), { key: 'Enter' })
    expect(respond).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: /工程落地型/ }))

    expect(screen.getByText('2 / 3')).toBeTruthy()
    // detail is per-question: the second question carries none.
    expect(screen.queryByText('按当前空缺岗位的优先级选择。')).toBeNull()
    expect(screen.queryByRole('button', { name: '填写答案' })).toBeNull()
    const custom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.change(custom, { target: { value: '要能独立排查线上问题' } })
    fireEvent.keyDown(custom, { key: 'Enter' })

    expect(screen.getByText('3 / 3')).toBeTruthy()
    // The model's question text renders verbatim — no marker filtering.
    expect(screen.getByText('选择重要信号（可多选）')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '代码质量' }))
    const multiCustom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.change(multiCustom, { target: { value: '沟通能力' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '产品判断' }))
    expect(screen.getByRole('checkbox', { name: '系统设计' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('checkbox', { name: '代码质量' }).getAttribute('aria-checked')).toBe('true')
    expect((multiCustom as HTMLInputElement).value).toBe('沟通能力')
    fireEvent.keyDown(multiCustom, { key: 'Enter' })

    // The domain face encoded the whole batch into one carrier envelope.
    expect(respond).toHaveBeenCalledWith(answeredEnvelope('question-1', [
      { id: 'profile', selected: ['工程落地型 (Recommended)'] },
      { id: 'detail', selected: [], custom: '要能独立排查线上问题' },
      { id: 'signals', selected: ['系统设计', '代码质量', '产品判断'], custom: '沟通能力' },
    ]))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '正在提交…' }).disabled).toBe(true)
  })

  it('renders plan detail through the shared assistant Markdown primitive', () => {
    const carrier = new PendingWait(
      'question',
      RpcId('markdown-plan'),
      SID,
      {
        questions: [{
          id: 'plan',
          question: '批准这个计划吗？',
          detail: '# 实施计划\n\n- **先验证**现状\n- 修改 `QuestionComposer`',
          options: [{ label: '批准' }],
        }],
      },
      vi.fn(),
    )
    const view = render(<QuestionComposer matched={carrier} interactions={[carrier]} {...kit} />)

    expect(screen.getByRole('heading', { level: 1, name: '实施计划' })).toBeTruthy()
    expect(view.container.querySelector('strong')?.textContent).toBe('先验证')
    expect(view.container.querySelector('code')?.textContent).toBe('QuestionComposer')
    expect(view.container.querySelectorAll('li')).toHaveLength(2)
  })

  it('skips individual questions without discarding earlier answers', () => {
    const { carrier, respond } = wait()
    render(<QuestionComposer matched={carrier} interactions={[carrier]} {...kit} />)

    expect((screen.getByText('下一题').closest('button') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: '研究潜力型' }))
    expect(screen.getByText('2 / 3')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '跳过本题' }))
    expect(screen.getByText('3 / 3')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '跳过本题' }))

    expect(respond).toHaveBeenCalledWith(answeredEnvelope('question-1', [
      { id: 'profile', selected: ['研究潜力型'] },
      { id: 'detail', selected: [] },
      { id: 'signals', selected: [] },
    ]))
  })

  it('keeps IME Enter inside the custom input until composition finishes', () => {
    const { carrier, respond } = wait()
    render(<QuestionComposer matched={carrier} interactions={[carrier]} {...kit} />)

    fireEvent.click(screen.getByRole('radio', { name: '研究潜力型' }))
    const custom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.change(custom, { target: { value: '中文输入' } })

    fireEvent.keyDown(custom, { key: 'Enter', isComposing: true })
    expect(screen.getByText('2 / 3')).toBeTruthy()
    expect(respond).not.toHaveBeenCalled()

    fireEvent.keyDown(custom, { key: 'Enter', keyCode: 229 })
    expect(screen.getByText('2 / 3')).toBeTruthy()
    expect(respond).not.toHaveBeenCalled()

    fireEvent.keyDown(custom, { key: 'Enter' })
    expect(screen.getByText('3 / 3')).toBeTruthy()
  })

  it('shows the inline custom input, reports missing answers, and supports pager navigation', () => {
    const { carrier, respond } = wait()
    render(<QuestionComposer matched={carrier} interactions={[carrier]} {...kit} />)

    expect(screen.getByPlaceholderText('输入你的答案')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: '工程落地型' }))
    const emptyCustom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.keyDown(emptyCustom, { key: 'Enter', shiftKey: true })
    expect(screen.getByText('2 / 3')).toBeTruthy()
    fireEvent.keyDown(emptyCustom, { key: 'Enter' })
    expect(screen.getByText('请选择一个选项或填写自定义答案。')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('下一题'))
    fireEvent.click(screen.getByRole('checkbox', { name: '产品判断' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(screen.getByText('请先完成这道问题。')).toBeTruthy()
    expect(screen.getByText('2 / 3')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('上一题'))
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(respond).not.toHaveBeenCalled()
  })

  it('answers over multiple lines: both fields grow with the draft and keep Shift+Enter a newline', () => {
    const { carrier, respond } = wait()
    render(<QuestionComposer matched={carrier} interactions={[carrier]} {...kit} />)

    // Both question shapes answer into a textarea, so the engine soft-wraps a
    // long answer and Shift+Enter breaks the line natively.
    const inline = screen.getByPlaceholderText('输入你的答案')
    expect(inline.tagName).toBe('TEXTAREA')

    const multiline = '第一行\n第二行'
    fireEvent.change(inline, { target: { value: multiline } })
    // The hidden height ruler carries the draft plus the trailing newline the
    // textarea's own last line needs, so the box is as tall as the answer.
    expect(inline.previousElementSibling?.textContent).toBe(`${multiline}\n`)
    // Shift+Enter belongs to the field, never to the flow.
    fireEvent.keyDown(inline, { key: 'Enter', shiftKey: true })
    expect(screen.getByText('1 / 3')).toBeTruthy()

    fireEvent.keyDown(inline, { key: 'Enter' })
    const optionless = screen.getByPlaceholderText('输入你的答案')
    expect(optionless.tagName).toBe('TEXTAREA')
    fireEvent.change(optionless, { target: { value: multiline } })
    expect(optionless.previousElementSibling?.textContent).toBe(`${multiline}\n`)
    fireEvent.keyDown(optionless, { key: 'Enter', shiftKey: true })
    expect(screen.getByText('2 / 3')).toBeTruthy()

    fireEvent.keyDown(optionless, { key: 'Enter' })
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    // Line breaks reach the model verbatim: nothing along the way flattens them.
    expect(respond).toHaveBeenCalledWith(answeredEnvelope('question-1', [
      { id: 'profile', selected: [], custom: multiline },
      { id: 'detail', selected: [], custom: multiline },
      { id: 'signals', selected: ['系统设计'] },
    ]))
  })

  it('surfaces cancellation failures: rejected receipt text and raw transport reasons', async () => {
    const respond = vi.fn()
      .mockResolvedValueOnce({ accepted: false, reason: 'bad-response' })
      .mockRejectedValueOnce(new Error('第二次取消失败'))
    const { carrier } = wait('question-1', respond)
    render(<QuestionComposer matched={carrier} interactions={[carrier]} {...kit} />)

    // Receipt rejection surfaces through the domain face's thrown message.
    fireEvent.click(screen.getByRole('button', { name: '放弃整组问题' }))
    expect(await screen.findByText('question cancellation rejected: bad-response')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '跳过本题' }).disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '放弃整组问题' }))
    expect(await screen.findByText('第二次取消失败')).toBeTruthy()
  })

  it('surfaces transport rejection and resets local drafts for a different request', async () => {
    const respond = vi.fn()
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockRejectedValueOnce('字符串错误')
    const first = wait('first', respond)
    const view = render(<QuestionComposer matched={first.carrier} interactions={[first.carrier]} {...kit} />)

    fireEvent.click(screen.getByRole('radio', { name: /研究潜力型/ }))
    expect(screen.getByText('2 / 3')).toBeTruthy()
    const second = wait('second', respond)
    view.rerender(<QuestionComposer matched={second.carrier} interactions={[second.carrier]} {...kit} />)
    expect(screen.getByRole('radio', { name: /研究潜力型/ }).getAttribute('aria-checked')).toBe('false')

    fireEvent.click(screen.getByRole('radio', { name: /工程落地型/ }))
    const custom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.change(custom, { target: { value: 'x' } })
    fireEvent.keyDown(custom, { key: 'Enter' })
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(respond).toHaveBeenNthCalledWith(1, answeredEnvelope('second', [
      { id: 'profile', selected: ['工程落地型 (Recommended)'] },
      { id: 'detail', selected: [], custom: 'x' },
      { id: 'signals', selected: ['系统设计'] },
    ]))
    expect(await screen.findByText('网络中断')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '提交' }).disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(await screen.findByText('字符串错误')).toBeTruthy()
  })

  it('renders chrome copy through the English dictionary', () => {
    const respond = vi.fn(() => Promise.resolve<RpcReceipt>({ accepted: true }))
    const carrier = new PendingWait(
      'question', RpcId('solo'), SID, { questions: [{ id: 'detail', question: '补充你的要求' }] }, respond)
    render(<QuestionComposer matched={carrier} interactions={[carrier]} {...kit} t={seatOver(en, commonEn)} />)
    expect(screen.getByLabelText('Dismiss all questions')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Skip this question' })).toBeTruthy()
    expect(screen.getByPlaceholderText('Type your answer')).toBeTruthy()
  })

  it('same-key carrier replacement (baseline replay) keeps drafts', () => {
    const first = wait('same-id')
    const view = render(<QuestionComposer matched={first.carrier} interactions={[first.carrier]} {...kit} />)
    fireEvent.click(screen.getByRole('radio', { name: /研究潜力型/ }))
    expect(screen.getByText('2 / 3')).toBeTruthy()
    // Replay mints a NEW carrier for the same request; same key = no remount.
    const replayed = wait('same-id')
    view.rerender(<QuestionComposer matched={replayed.carrier} interactions={[replayed.carrier]} {...kit} />)
    expect(screen.getByText('2 / 3')).toBeTruthy()
  })
})

describe('PendingQuestion domain face', () => {
  it('encodes the answer batch into the ok envelope and throws on a rejected receipt', async () => {
    const respond = vi.fn()
      .mockResolvedValueOnce({ accepted: true })
      .mockResolvedValueOnce({ accepted: false, reason: 'not-pending' })
    const question = new PendingQuestion(wait('rq', respond).carrier)
    const batch = { answers: [{ id: 'mode', selected: ['Fast'] }] }
    await expect(question.answer(batch)).resolves.toBeUndefined()
    expect(respond).toHaveBeenCalledWith(answeredEnvelope('rq', batch.answers))
    await expect(question.answer(batch)).rejects.toThrow(/question response rejected: not-pending/)
  })

  it('encodes cancellation as the cancelled error envelope and throws on a rejected receipt', async () => {
    const respond = vi.fn()
      .mockResolvedValueOnce({ accepted: true })
      .mockResolvedValueOnce({ accepted: false, reason: 'bad-response' })
    const question = new PendingQuestion(wait('rc', respond).carrier)
    await expect(question.cancel()).resolves.toBeUndefined()
    expect(respond).toHaveBeenCalledWith({
      type: 'client-response', rpcId: RpcId('rc'),
      result: {
        ok: false,
        error: { code: 'cancelled', message: 'the user closed this question request', details: {} },
      },
    })
    await expect(question.cancel()).rejects.toThrow(/question cancellation rejected: bad-response/)
  })

  it('forwards key and questions from the carrier', () => {
    const question = new PendingQuestion(wait('rk').carrier)
    expect(question.key).toBe('q:rk')
    expect(question.questions).toBe(wait('rk').carrier.payload.questions)
  })

  it('collapses the card to the header strip and expands it back', () => {
    const { carrier } = wait()
    render(<QuestionComposer matched={carrier} interactions={[carrier]} {...kit} />)
    // Expanded: the option list is visible.
    expect(screen.getByRole('radiogroup')).toBeTruthy()
    // Collapse: options leave the tree; the title and minimize toggle stay.
    fireEvent.click(screen.getByLabelText(zh['nav.minimize']))
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByText('选择候选人类型')).toBeTruthy()
    // Expand: the options return (the toggle label flips while collapsed).
    fireEvent.click(screen.getByLabelText(zh['nav.maximize']))
    expect(screen.getByRole('radiogroup')).toBeTruthy()
    // Expanded again: the toggle reports expanded and the option list is back.
    expect(screen.getByLabelText(zh['nav.minimize']).getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps the collapse toggle out of the cancel path and preserves drafts across collapse', () => {
    const { carrier, respond } = wait()
    render(<QuestionComposer matched={carrier} interactions={[carrier]} {...kit} />)
    fireEvent.click(screen.getByRole('radio', { name: /工程落地型/ }))
    // Single-select auto-advances to the second question; collapse and expand
    // must not lose either the picked option or the current position.
    fireEvent.click(screen.getByLabelText(zh['nav.minimize']))
    fireEvent.click(screen.getByLabelText(zh['nav.maximize']))
    const custom = screen.getByPlaceholderText(zh['custom.placeholder'])
    fireEvent.change(custom, { target: { value: '要能独立排查线上问题' } })
    // Re-expanding must not steal focus back into the textarea: it was
    // autofocused on first presentation, so focus stays on the expand toggle.
    expect(document.activeElement).not.toBe(custom)
    fireEvent.click(screen.getByLabelText('下一题'))
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(respond).toHaveBeenCalledWith(answeredEnvelope('question-1', [
      { id: 'profile', selected: ['工程落地型 (Recommended)'] },
      { id: 'detail', custom: '要能独立排查线上问题', selected: [] },
      { id: 'signals', selected: ['系统设计'] },
    ]))
  })
})

describe('parseRecommendedLabel', () => {
  it('recognizes English and Chinese suffixes without changing ordinary labels', () => {
    expect(parseRecommendedLabel('Fast (Recommended)')).toEqual({ label: 'Fast', recommended: true })
    expect(parseRecommendedLabel('稳妥（推荐）')).toEqual({ label: '稳妥', recommended: true })
    expect(parseRecommendedLabel('稳妥 (推荐)')).toEqual({ label: '稳妥', recommended: true })
    expect(parseRecommendedLabel('Plain')).toEqual({ label: 'Plain', recommended: false })
  })
})
