#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RETRIES = 4

function argument(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase()
}

async function assertClosedPorts(ports) {
  for (const port of ports) {
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        reject(Object.assign(new Error(`candidate listener is active on 127.0.0.1:${port}`), { code: 'CANDIDATE_RUNTIME_ACTIVE' }))
      })
      socket.once('error', error => {
        if ((error).code === 'ECONNREFUSED') resolve()
        else reject(error)
      })
    })
  }
}

async function stableRead(file) {
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    const before = await stat(file)
    const bytes = await readFile(file)
    const after = await stat(file)
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
      return { bytes, mtime: after.mtime, hash: sha256(bytes), attempts: attempt }
    }
  }
  throw Object.assign(new Error(`source changed while being read: ${file}`), { code: 'SOURCE_CHANGED_DURING_READ' })
}

async function inventory(root) {
  const files = new Map()
  async function visit(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const childRelative = path.join(relative, entry.name)
      const child = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(child, childRelative)
      else if (entry.isFile()) files.set(childRelative, await stableRead(child))
      else throw Object.assign(new Error(`unsupported entry: ${childRelative}`), { code: 'UNSUPPORTED_ENTRY' })
    }
  }
  await visit(root)
  return files
}

function differences(source, target) {
  const sourceOnly = [...source.keys()].filter(key => !target.has(key)).sort()
  const targetOnly = [...target.keys()].filter(key => !source.has(key)).sort()
  const changed = [...source.keys()]
    .filter(key => target.has(key) && source.get(key).hash !== target.get(key).hash)
    .sort()
  return { sourceOnly, targetOnly, changed }
}

async function copyAtomically(sourceRoot, targetRoot, relative, backupRoot) {
  const source = path.join(sourceRoot, relative)
  const target = path.join(targetRoot, relative)
  const backup = path.join(backupRoot, relative)
  const original = await stableRead(target)
  const next = await stableRead(source)
  await mkdir(path.dirname(backup), { recursive: true })
  await writeFile(backup, original.bytes, { flag: 'wx' })
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.reconcile-${process.pid}-${Date.now()}.tmp`
  try {
    await writeFile(temporary, next.bytes, { flag: 'wx' })
    const written = await stableRead(temporary)
    if (written.hash !== next.hash) throw new Error(`temporary copy hash mismatch: ${relative}`)
    await rename(temporary, target)
    await utimes(target, next.mtime, next.mtime)
  } finally {
    await rm(temporary, { force: true })
  }
  return { relative, previousSha256: original.hash, sourceSha256: next.hash }
}

export async function reconcile({ sourceRoot, targetRoot, backupRoot, apply = false, requireClosedPorts = [] }) {
  const source = path.resolve(sourceRoot)
  const target = path.resolve(targetRoot)
  if (source === target) throw new Error('source and target session stores must differ')
  const [sourceFiles, targetFiles] = await Promise.all([inventory(source), inventory(target)])
  const initial = differences(sourceFiles, targetFiles)
  if (initial.sourceOnly.length || initial.targetOnly.length) {
    throw Object.assign(new Error('session store inventories differ; reconciliation refuses to create or delete files'), {
      code: 'INVENTORY_MISMATCH',
      details: initial,
    })
  }
  const plan = {
    schema: 'giana-code-putri/session-store-reconciliation/v1',
    sourceRoot: source,
    targetRoot: target,
    apply,
    changedCount: initial.changed.length,
    changed: initial.changed,
  }
  if (!apply) return { ...plan, state: initial.changed.length === 0 ? 'PASS_EXACT_RAW_PARITY' : 'DRY_RUN_RECONCILIATION_REQUIRED' }
  if (!backupRoot) throw new Error('--backup-root is required with --apply')
  await assertClosedPorts(requireClosedPorts)

  // Re-read the old store just before the first candidate write; never merge a moving source.
  const finalSource = await inventory(source)
  const finalTarget = await inventory(target)
  const final = differences(finalSource, finalTarget)
  if (final.sourceOnly.length || final.targetOnly.length || final.changed.join('\n') !== initial.changed.join('\n')) {
    throw Object.assign(new Error('session stores changed after planning; no candidate file was written'), { code: 'RECONCILIATION_PLAN_STALE' })
  }
  await assertClosedPorts(requireClosedPorts)
  const receiptRoot = path.resolve(backupRoot, `session-reconcile-${new Date().toISOString().replace(/[:.]/gu, '-')}`)
  await mkdir(receiptRoot, { recursive: true })
  const copied = []
  for (const relative of final.changed) copied.push(await copyAtomically(source, target, relative, receiptRoot))
  const post = differences(await inventory(source), await inventory(target))
  if (post.sourceOnly.length || post.targetOnly.length || post.changed.length) {
    throw Object.assign(new Error('post-copy raw parity failed; candidate backup is retained for recovery'), { code: 'POSTCOPY_PARITY_FAILED', details: post })
  }
  const receipt = { ...plan, state: 'PASS_EXACT_RAW_PARITY', copied, backupRoot: receiptRoot }
  await writeFile(path.join(receiptRoot, 'SESSION_RECONCILIATION_RECEIPT.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
  return receipt
}

async function main() {
  const sourceRoot = argument('--source')
  const targetRoot = argument('--target')
  const apply = process.argv.includes('--apply')
  const backupRoot = argument('--backup-root')
  const requireClosedPorts = process.argv
    .flatMap((value, index) => value === '--require-closed-port' ? [process.argv[index + 1]] : [])
    .map(value => Number.parseInt(value, 10))
  if (requireClosedPorts.some(port => !Number.isSafeInteger(port) || port < 1 || port > 65535)) {
    throw new Error('--require-closed-port must be followed by a valid TCP port')
  }
  if (!sourceRoot || !targetRoot) throw new Error('usage: reconcile-session-store.mjs --source <sessions> --target <sessions> [--backup-root <dir> --apply]')
  process.stdout.write(`${JSON.stringify(await reconcile({ sourceRoot, targetRoot, backupRoot, apply, requireClosedPorts }), null, 2)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.stack ?? error}\n`)
    process.exitCode = 1
  })
}
