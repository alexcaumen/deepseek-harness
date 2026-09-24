import { describe, expect, it } from 'vitest'
import { createFixtureFaces } from '../src/client/fixture.ts'

describe('fixture startup Remotes', () => {
  it('accepts the Client inspect manifest with the Host null receipt', async () => {
    const { rpc } = createFixtureFaces({ annotationQa: true })

    await expect(rpc.call('/api', 'dynamicCordisRunner/syncInspectManifest', {
      args: { providers: [] },
    })).resolves.toEqual({ ok: true, value: null })
  })

  it('serves an empty Host plugin inventory snapshot', async () => {
    const { rpc } = createFixtureFaces({ annotationQa: true })

    await expect(rpc.call('/api', 'pluginInventory/list', { args: {} }))
      .resolves.toEqual({ ok: true, value: { entries: [] } })
  })

  it('serves an empty dynamic Cordis runner inventory', async () => {
    const { rpc } = createFixtureFaces({ annotationQa: true })

    await expect(rpc.call('/api', 'dynamicCordisRunner/inventory', { args: {} }))
      .resolves.toEqual({ ok: true, value: [] })
  })

  it('still rejects unrelated endpoints and channels', async () => {
    const { rpc } = createFixtureFaces({ annotationQa: true })

    await expect(rpc.call('/api', 'dynamicCordisRunner/runHostHalf', { args: {} }))
      .rejects.toThrow('fixture connection RPC endpoint')
    await expect(rpc.call('/other', 'pluginInventory/list', { args: {} }))
      .rejects.toThrow('fixture connection RPC channel')
  })
})
