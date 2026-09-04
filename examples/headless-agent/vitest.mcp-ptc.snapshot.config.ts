/** Source-only single-file staging regression with isolated generated artifacts. */
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from '../../vitest.shared.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))

export default defineConfig({
  root,
  cacheDir: fileURLToPath(new URL('../../.artifacts/mcp-ptc-20260904/vite-cache', import.meta.url)),
  plugins: [tsconfigPaths({ projects: [fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url))] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    include: ['examples/headless-agent/tests/mcp-ptc.snapshot.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 135000,
  },
})
