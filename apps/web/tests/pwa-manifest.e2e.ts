import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toEqual({
    id: '/',
    name: 'Giana CoWork',
    short_name: 'Giana',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [{
      src: '/giana-cowork-logo.png',
      sizes: '1024x1024',
      type: 'image/png',
      purpose: 'any',
    }],
  })
})

it('ships the canonical Giana CoWork favicon asset', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  const favicon = await readFile(join(DIST_ROOT, 'giana-cowork-logo.png'))
  expect(index).toContain('<link rel="icon" type="image/png" href="/giana-cowork-logo.png" />')
  expect(favicon.byteLength).toBeGreaterThan(0)
})
