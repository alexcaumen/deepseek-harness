import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Plugin } from 'vite'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function titleDocument() {
  const { default: config } = await import('../vite.config.ts')
  const plugin = (config.plugins as Plugin[]).find(item => item.name === 'dsh-client-document-title')
  const transform = plugin?.transformIndexHtml
  if (typeof transform !== 'function') throw new Error('document-title transform must be callable')
  return (transform as (html: string) => string)(html)
}

describe('GCP browser title', () => {
  it('keeps Preview in the source document and default title', async () => {
    vi.stubEnv('DSH_CLIENT_TITLE', undefined)
    expect(html).toContain('<title>Giana CoWork Preview</title>')
    expect(await titleDocument()).toContain('<title>Giana CoWork Preview</title>')
  })

  it('preserves an explicit deployment title without changing document content', async () => {
    vi.stubEnv('DSH_CLIENT_TITLE', 'Custom workbench')
    expect(await titleDocument()).toBe(html.replace('Giana CoWork Preview', 'Custom workbench'))
  })

  it('escapes deployment titles as text', async () => {
    vi.stubEnv('DSH_CLIENT_TITLE', 'GCP <stage> & test')
    expect(await titleDocument()).toContain('<title>GCP &lt;stage&gt; &amp; test</title>')
  })
})
