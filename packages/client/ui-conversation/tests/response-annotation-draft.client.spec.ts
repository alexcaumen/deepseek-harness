// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type { InputTriggerController, SubmitOutcome } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { createChatStore } from '../src/client/stores.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { responseAnnotationSource } from '../src/client/input/response-annotation.ts'

beforeEach(() => { localStorage.clear() })

describe('persisted response annotation drafts', () => {
  it('restores structured annotations and sends their quote, origin, and exact offsets after reload', async () => {
    const source = responseAnnotationSource()
    const serializeReference = vi.fn((name: string, ref: string, signal: AbortSignal) => {
      expect(name).toBe('response-annotation')
      if (source.codec === undefined) throw new Error('response annotation codec missing')
      return source.codec.serialize(ref, signal)
    })
    const sink = vi.fn((_text: string) => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
    const deps: ConstructorParameters<typeof SessionInputShell>[0] = {
      actx: {} as ClientContext,
      inputTriggers: () => ({ serializeReference, track: vi.fn() }) as unknown as InputTriggerController,
      defaultSink: sink,
      commandImages: { serialize: () => Promise.resolve([]), release: () => {}, unsupportedNotice: () => '' },
    }
    const store = createChatStore().create('annotation-reload')
    const first = new SessionInputShell(deps)
    first.bindMirror(store.actions.setDraft)
    expect(first.insertReference({ source: 'other', ref: 'other', label: 'long-name', clipboardText: 'short' }, {
      start: 0, end: 0, draftRev: first.snapshot.draftRev,
    })).toBe(true)
    expect(first.actions.addResponseAnnotation({
      messageId: 'assistant-1' as MessageId,
      text: 'repeated quote', startOffset: 5, endOffset: 19,
    })).toBe(true)
    expect(first.actions.addResponseAnnotation({
      messageId: 'assistant-2' as MessageId,
      text: 'repeated quote', startOffset: 31, endOffset: 45,
    })).toBe(true)
    first.setDraft(`${first.snapshot.draft}compare these`)

    const persisted = createChatStore().create('annotation-reload').store.getSnapshot()
    expect(persisted.draft).toBe('short @Annotation 1 @Annotation 2 compare these')
    expect(persisted.draftAnnotations?.map(item => item.offset)).toEqual([6, 20])

    const restored = new SessionInputShell(deps)
    restored.actions.setDraft(persisted.draft, persisted.draftAnnotations)
    expect(restored.snapshot.occurrences.map(item => [item.offset, item.label])).toEqual([
      [6, 'Annotation 1'], [20, 'Annotation 2'],
    ])
    restored.submit()
    await vi.waitFor(() => { expect(sink).toHaveBeenCalledOnce() })
    const modelText = sink.mock.calls[0]?.[0] ?? ''
    expect(modelText).toContain('"sourceMessageId":"assistant-1"')
    expect(modelText).toContain('"sourceStart":5')
    expect(modelText).toContain('"sourceEnd":19')
    expect(modelText).toContain('"sourceMessageId":"assistant-2"')
    expect(modelText).toContain('"sourceStart":31')
    expect(modelText).toContain('"sourceEnd":45')
    expect(modelText.match(/"text":"repeated quote"/gu)).toHaveLength(2)
    expect(modelText).toContain('compare these')
    expect(serializeReference).toHaveBeenCalledTimes(2)
  })

  it('keeps authored text but rejects a stale annotation sidecar', () => {
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      defaultSink: () => Promise.resolve({ kind: 'success' }),
      commandImages: { serialize: () => Promise.resolve([]), release: () => {}, unsupportedNotice: () => '' },
    })
    shell.actions.setDraft('plain @Annotation 1', [{ offset: 5, ref: '{"index":1,"messageId":"assistant-1","text":"quote"}' }])
    expect(shell.snapshot.draft).toBe('plain @Annotation 1')
    expect(shell.snapshot.occurrences).toHaveLength(0)
  })
})
