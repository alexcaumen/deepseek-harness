import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type {
  InputTriggerController, SubmitOutcome,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { responseAnnotationSource } from '../src/client/input/response-annotation.ts'
import { responseAnnotationPresentations } from '../src/client/response-annotation.ts'

const commandImages = {
  serialize: () => Promise.resolve([]),
  release: () => {},
  unsupportedNotice: (token: string) => `${token.trim()} images-unsupported`,
}

describe('response annotations', () => {
  it('derives exact structured chip placement from durable envelopes rather than duplicate labels', () => {
    const body = JSON.stringify([{
      index: 1,
      sourceMessageId: 'assistant-1',
      text: 'second repeated passage',
      sourceStart: 21,
      sourceEnd: 44,
    }])
    const modelText = `literal @Annotation 1 then <response-annotations>\n${body}\n</response-annotations> finish`
    const displayText = 'literal @Annotation 1 then @Annotation 1 finish'

    const annotations = responseAnnotationPresentations(
      [{ type: 'text', text: modelText }],
      [{ type: 'text', text: displayText }],
    )

    const displayStart = displayText.lastIndexOf('@Annotation 1')
    expect(annotations).toEqual([{
      index: 1,
      messageId: 'assistant-1',
      text: 'second repeated passage',
      startOffset: 21,
      endOffset: 44,
      displayStart,
      displayEnd: displayStart + '@Annotation 1'.length,
    }])
  })

  it('does not attach structured annotations when durable and display projections diverge', () => {
    const body = JSON.stringify([{
      index: 2,
      sourceMessageId: 'assistant-2',
      text: 'quoted',
    }])
    expect(responseAnnotationPresentations(
      [{ type: 'text', text: `<response-annotations>\n${body}\n</response-annotations>` }],
      [{ type: 'text', text: '@Annotation 2 changed' }],
    )).toEqual([])
  })

  it('recovers annotations after a mixed file and session reference send and history reload', async () => {
    const sessionRef = '@[Research notes](dsh-session:InNvdXJjZSI)'
    const fileRef = '@"docs/design notes.md"'
    const sink = vi.fn((
      _text: string,
      _imageIds: readonly unknown[],
      _mode: 'queue' | 'steer',
      _signal: AbortSignal,
      _displayText?: string,
    ) => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      inputTriggers: () => ({
        serializeReference: (_source: string, ref: string) => Promise.resolve(ref),
        track: vi.fn(),
      } as unknown as InputTriggerController),
      defaultSink: sink,
      commandImages,
    })
    shell.addResponseAnnotation({ messageId: 'assistant-source' as MessageId, text: 'selected answer' })
    shell.setDraft('@res')
    expect(shell.insertReference({ source: 'reference', ref: sessionRef, label: 'Research notes', clipboardText: sessionRef }, {
      start: 0, end: 4, draftRev: shell.snapshot.draftRev,
    })).toBe(true)
    shell.setDraft(`${shell.snapshot.draft}and @file`)
    const fileStart = shell.snapshot.draft.indexOf('@file')
    expect(shell.insertReference({ source: 'reference', ref: fileRef, label: 'design notes.md', clipboardText: fileRef }, {
      start: fileStart, end: fileStart + 5, draftRev: shell.snapshot.draftRev,
    })).toBe(true)
    shell.submit()
    await vi.waitFor(() => { expect(sink).toHaveBeenCalledOnce() })
    const model = sink.mock.calls[0]?.[0] ?? ''
    const display = sink.mock.calls[0]?.[4] ?? ''
    expect(model).toContain(sessionRef)
    expect(model).toContain(fileRef)
    expect(display).toBe('@Annotation 1 @Research notes and @design notes.md')
    const reloadedModel = JSON.parse(JSON.stringify([{ type: 'text', text: model }])) as unknown[]
    const reloadedDisplay = JSON.parse(JSON.stringify([{ type: 'text', text: display }])) as unknown[]
    expect(responseAnnotationPresentations(reloadedModel, reloadedDisplay)).toMatchObject([{
      index: 1, messageId: 'assistant-source', text: 'selected answer', displayStart: 0,
    }])
    expect(responseAnnotationPresentations(reloadedModel, [{ type: 'text', text: `${display} changed` }])).toEqual([])
    expect(responseAnnotationPresentations([{ type: 'text', text: `${model} changed` }], reloadedDisplay)).toEqual([])
  })

  it('keeps selected passages out of the draft and sends them as one model-facing envelope', async () => {
    const serializeReference = vi.fn()
    const inputTriggers = { serializeReference, track: vi.fn() } as unknown as InputTriggerController
    const sink = vi.fn((
      _text: string,
      _imageIds: readonly unknown[],
      _mode: 'queue' | 'steer',
      _signal: AbortSignal,
      _displayText?: string,
    ) => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      inputTriggers: () => inputTriggers,
      defaultSink: sink,
      commandImages,
    })

    expect(shell.actions.addResponseAnnotation({
      messageId: 'assistant-1' as MessageId,
      text: 'first selected passage',
      startOffset: 4,
      endOffset: 26,
    })).toBe(true)
    expect(shell.actions.addResponseAnnotation({
      messageId: 'assistant-2' as MessageId,
      text: 'second selected passage',
    })).toBe(true)
    shell.actions.commentResponseAnnotation(2, 'is this cheaper?')
    shell.setDraft('please compare both')

    expect(shell.snapshot.draft).toBe('please compare both')
    expect(shell.snapshot.occurrences).toEqual([])
    expect(shell.snapshot.annotations.map(item => item.index)).toEqual([1, 2])
    shell.submit()

    await vi.waitFor(() => { expect(sink).toHaveBeenCalledOnce() })
    const submitted = sink.mock.calls[0]?.[0] ?? ''
    const display = sink.mock.calls[0]?.[4] ?? ''
    expect(submitted.startsWith('<response-annotations>\n')).toBe(true)
    expect(submitted).toContain('"index":1')
    expect(submitted).toContain('"sourceMessageId":"assistant-1"')
    expect(submitted).toContain('"text":"first selected passage"')
    expect(submitted).toContain('"sourceStart":4')
    expect(submitted).toContain('"sourceEnd":26')
    expect(submitted).toContain('"index":2')
    expect(submitted).toContain('"sourceMessageId":"assistant-2"')
    expect(submitted).toContain('"comment":"is this cheaper?"')
    expect(submitted.endsWith(' please compare both')).toBe(true)
    expect(display).toBe('@Annotation 1 @Annotation 2 please compare both')
    expect(serializeReference).not.toHaveBeenCalled()
    // The durable projection of the model text reproduces the display text, so history renders the chips.
    expect(responseAnnotationPresentations([{ type: 'text', text: submitted }], [{ type: 'text', text: display }])
      .map(item => [item.index, item.messageId, item.comment]))
      .toEqual([[1, 'assistant-1', undefined], [2, 'assistant-2', 'is this cheaper?']])
    await vi.waitFor(() => { expect(shell.snapshot.annotations).toEqual([]) })
    expect(shell.snapshot.draft).toBe('')
  })

  it('renumbers after removal and sends annotations without authored text', async () => {
    const sink = vi.fn((
      _text: string,
      _imageIds: readonly unknown[],
      _mode: 'queue' | 'steer',
      _signal: AbortSignal,
      _displayText?: string,
    ) => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
    const shell = new SessionInputShell({ actx: {} as ClientContext, defaultSink: sink, commandImages })
    for (const text of ['one', 'two', 'three']) {
      expect(shell.actions.addResponseAnnotation({ messageId: 'assistant-1' as MessageId, text })).toBe(true)
    }
    expect(shell.actions.addResponseAnnotation({ messageId: 'assistant-1' as MessageId, text: 'two' })).toBe(true)
    expect(shell.snapshot.annotations).toHaveLength(3)
    shell.actions.removeResponseAnnotation(2)
    expect(shell.snapshot.annotations.map(item => [item.index, item.text])).toEqual([[1, 'one'], [2, 'three']])

    shell.submit()
    await vi.waitFor(() => { expect(sink).toHaveBeenCalledOnce() })
    expect(sink.mock.calls[0]?.[0]).toMatch(/^<response-annotations>\n.*\n<\/response-annotations>$/u)
    expect(sink.mock.calls[0]?.[4]).toBe('@Annotation 1 @Annotation 2')
    await vi.waitFor(() => { expect(shell.snapshot.annotations).toEqual([]) })
  })

  it('keeps annotations for correction when the send fails', async () => {
    const sink = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'error', text: 'offline' }))
    const shell = new SessionInputShell({ actx: {} as ClientContext, defaultSink: sink, commandImages })
    shell.actions.addResponseAnnotation({ messageId: 'assistant-1' as MessageId, text: 'kept' })
    shell.setDraft('ask')
    shell.submit()
    await vi.waitFor(() => { expect(sink).toHaveBeenCalledOnce() })
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
    expect(shell.snapshot.annotations.map(item => item.text)).toEqual(['kept'])
    expect(shell.snapshot.draft).toBe('ask')
  })

  it('fails closed for malformed persisted annotation payloads', async () => {
    const source = responseAnnotationSource()
    await expect(source.codec?.serialize('{"index":0}', new AbortController().signal))
      .rejects.toThrow('Response annotation payload is invalid')
  })

  it.each(['', 'question'])('freezes attachments during admission and retains later text for draft %j', async (draft) => {
    let finish!: (outcome: SubmitOutcome) => void
    const pending = new Promise<SubmitOutcome>((resolve) => { finish = resolve })
    const sink = vi.fn(() => pending)
    const shell = new SessionInputShell({ actx: {} as ClientContext, defaultSink: sink, commandImages })
    shell.addResponseAnnotation({ messageId: 'assistant-1' as MessageId, text: 'quote' })
    shell.commentResponseAnnotation(1, 'keep comment')
    shell.setDraft(draft)
    shell.submit('steer')
    expect(shell.snapshot.phase).toBe('submitting')
    expect(shell.addResponseAnnotation({ messageId: 'assistant-2' as MessageId, text: 'late' })).toBe(false)
    shell.commentResponseAnnotation(1, 'changed')
    shell.removeResponseAnnotation(1)
    shell.clearResponseAnnotations()
    shell.actions.setDraft('stale', [{ offset: -1, ref: '{"index":1,"messageId":"other","text":"stale"}' }])
    expect(shell.snapshot.draft).toBe(draft)
    expect(shell.snapshot.annotations).toMatchObject([{ text: 'quote', comment: 'keep comment' }])
    shell.submit()
    expect(sink).toHaveBeenCalledOnce()

    // RC52 permits programmatic suffix edits while a prompt is awaiting admission.
    shell.setDraft(`${draft} later`)
    finish({ kind: 'success' })
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
    expect(shell.snapshot.annotations).toEqual([])
    expect(shell.snapshot.draft).toBe(' later')
    shell.undo()
    expect(shell.snapshot.draft).toBe(' later')
  })

  it.each(['outcome', 'rejection', 'throw'] as const)('retains annotation-only drafts after %s and retries once', async (failure) => {
    const sink = vi.fn((): Promise<SubmitOutcome> => {
      if (failure === 'throw') throw new Error('offline')
      return failure === 'rejection'
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ kind: 'error', text: 'offline' })
    })
    const shell = new SessionInputShell({ actx: {} as ClientContext, defaultSink: sink, commandImages })
    shell.addResponseAnnotation({ messageId: 'assistant-1' as MessageId, text: 'kept' })
    shell.commentResponseAnnotation(1, 'retry this')
    shell.submit()
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
    expect(shell.snapshot.annotations).toMatchObject([{ text: 'kept', comment: 'retry this' }])
    expect(shell.notices.getSnapshot()?.text).toBe('offline')
    sink.mockResolvedValue({ kind: 'success' })
    shell.submit()
    shell.submit()
    await vi.waitFor(() => { expect(shell.snapshot.annotations).toEqual([]) })
    expect(sink).toHaveBeenCalledTimes(2)
  })

  it('aborts an annotation-only send on disposal and ignores its late settlement', async () => {
    let finish!: (outcome: SubmitOutcome) => void
    const pending = new Promise<SubmitOutcome>((resolve) => { finish = resolve })
    const sink = vi.fn((_text: string, _images: readonly unknown[], _mode: string, _signal: AbortSignal) => pending)
    const shell = new SessionInputShell({ actx: {} as ClientContext, defaultSink: sink, commandImages })
    shell.addResponseAnnotation({ messageId: 'assistant-1' as MessageId, text: 'quote' })
    shell.submit()
    const signal = sink.mock.calls[0]![3]
    shell.dispose()
    expect(signal.aborted).toBe(true)
    const annotations = shell.snapshot.annotations
    finish({ kind: 'success' })
    await pending
    expect(shell.snapshot.annotations).toBe(annotations)
    expect(shell.addResponseAnnotation({ messageId: 'assistant-2' as MessageId, text: 'late' })).toBe(false)
    shell.submit()
    expect(sink).toHaveBeenCalledOnce()
  })

  it('keeps legacy behavior when an incomplete source anchor is supplied', async () => {
    const source = responseAnnotationSource()
    const serializeReference = vi.fn((_name: string, ref: string, signal: AbortSignal) => {
      if (source.codec === undefined) throw new Error('response annotation codec missing')
      return source.codec.serialize(ref, signal)
    })
    const inputTriggers = { serializeReference, track: vi.fn() } as unknown as InputTriggerController
    const sink = vi.fn((
      _text: string,
      _imageIds: readonly unknown[],
      _mode: 'queue' | 'steer',
      _signal: AbortSignal,
      _displayText?: string,
    ) => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      inputTriggers: () => inputTriggers,
      defaultSink: sink,
      commandImages,
    })

    expect(shell.actions.addResponseAnnotation({
      messageId: 'assistant-legacy' as MessageId,
      text: 'legacy passage',
      startOffset: 2,
    })).toBe(true)
    shell.submit()

    await vi.waitFor(() => { expect(sink).toHaveBeenCalledOnce() })
    const submitted = sink.mock.calls[0]?.[0]
    expect(submitted).toContain('"text":"legacy passage"')
    expect(submitted).not.toContain('sourceStart')
    expect(submitted).not.toContain('sourceEnd')
  })
})
