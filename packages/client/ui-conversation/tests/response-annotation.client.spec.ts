import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type {
  InputTriggerController, SubmitOutcome,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { SessionInputShell } from '../src/client/input/facade.ts'
import {
  RESPONSE_ANNOTATION_SOURCE, responseAnnotationSource,
} from '../src/client/input/response-annotation.ts'

const commandImages = {
  serialize: () => Promise.resolve([]),
  release: () => {},
  unsupportedNotice: (token: string) => `${token.trim()} images-unsupported`,
}

describe('response annotations', () => {
  it('numbers selected passages and serializes them as model-facing response annotations', async () => {
    const source = responseAnnotationSource()
    const serializeReference = vi.fn((name: string, ref: string, signal: AbortSignal) => {
      expect(name).toBe(RESPONSE_ANNOTATION_SOURCE)
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
      messageId: 'assistant-1' as MessageId,
      text: 'first selected passage',
    })).toBe(true)
    expect(shell.actions.addResponseAnnotation({
      messageId: 'assistant-2' as MessageId,
      text: 'second selected passage',
    })).toBe(true)
    shell.setDraft(`${shell.snapshot.draft}please compare both`)

    expect(shell.snapshot.draft).toBe('@Annotation 1 @Annotation 2 please compare both')
    expect(shell.snapshot.occurrences.map(item => item.label)).toEqual(['Annotation 1', 'Annotation 2'])
    shell.submit()

    await vi.waitFor(() => { expect(sink).toHaveBeenCalledOnce() })
    const submitted = sink.mock.calls[0]?.[0]
    expect(submitted).toContain('<response-annotations>')
    expect(submitted).toContain('"index":1')
    expect(submitted).toContain('"sourceMessageId":"assistant-1"')
    expect(submitted).toContain('"text":"first selected passage"')
    expect(submitted).toContain('"index":2')
    expect(submitted).toContain('"sourceMessageId":"assistant-2"')
    expect(submitted).toContain('please compare both')
    expect(sink.mock.calls[0]?.[4]).toBe('@Annotation 1 @Annotation 2 please compare both')
    expect(serializeReference).toHaveBeenCalledTimes(2)
  })

  it('fails closed for malformed persisted annotation payloads', async () => {
    const source = responseAnnotationSource()
    await expect(source.codec?.serialize('{"index":0}', new AbortController().signal))
      .rejects.toThrow('Response annotation payload is invalid')
  })
})
