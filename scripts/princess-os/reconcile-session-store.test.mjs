#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { reconcile } from './reconcile-session-store.mjs'

const root = await mkdtemp(path.join(os.tmpdir(), 'giana-code-putri-session-reconcile-'))
const source = path.join(root, 'source')
const target = path.join(root, 'target')
const backups = path.join(root, 'backups')

try {
  for (const directory of [source, target]) await mkdir(path.join(directory, 'workspace', 'session'), { recursive: true })
  const relative = path.join('workspace', 'session', 'session.jsonl.zstd')
  await writeFile(path.join(source, relative), 'canonical-session-bytes')
  await writeFile(path.join(target, relative), 'candidate-test-bytes')

  const dry = await reconcile({ sourceRoot: source, targetRoot: target })
  assert.equal(dry.state, 'DRY_RUN_RECONCILIATION_REQUIRED')
  assert.equal(await readFile(path.join(target, relative), 'utf8'), 'candidate-test-bytes')

  const applied = await reconcile({ sourceRoot: source, targetRoot: target, backupRoot: backups, apply: true })
  assert.equal(applied.state, 'PASS_EXACT_RAW_PARITY')
  assert.equal(applied.copied.length, 1)
  assert.equal(await readFile(path.join(target, relative), 'utf8'), 'canonical-session-bytes')
  assert.equal(await readFile(path.join(applied.backupRoot, relative), 'utf8'), 'candidate-test-bytes')
  const settled = await reconcile({ sourceRoot: source, targetRoot: target })
  assert.equal(settled.state, 'PASS_EXACT_RAW_PARITY')

  const blocker = net.createServer()
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve))
  try {
    const port = blocker.address().port
    await assert.rejects(
      reconcile({ sourceRoot: source, targetRoot: target, backupRoot: backups, apply: true, requireClosedPorts: [port] }),
      /candidate listener is active/,
    )
  } finally {
    await new Promise(resolve => blocker.close(resolve))
  }
  process.stdout.write('PASS reconcile-session-store\n')
} finally {
  await rm(root, { recursive: true, force: true })
}
