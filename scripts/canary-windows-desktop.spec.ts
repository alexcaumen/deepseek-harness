import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const contract = fileURLToPath(new URL('./princess-os/canary-windows-desktop.test.mjs', import.meta.url))

test('Windows desktop canary remains explicit, credential-scrubbed and read-only', () => {
  const result = spawnSync(process.execPath, ['--test', contract], {
    encoding: 'utf8',
    windowsHide: true,
  })
  expect(result.stderr).toBe('')
  expect(result.status, result.stdout).toBe(0)
})
