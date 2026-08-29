#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const defaultSource = 'C:/Users/grinv/.dsh-0.1.1-rc.2-20260822/sessions';
const defaultTarget = 'C:/Users/grinv/.dsh-giana-code-putri-clean-20260827/sessions';
const sourceRoot = path.resolve(process.env.DSH_OLD_SESSION_STORE ?? defaultSource);
const targetRoot = path.resolve(process.env.DSH_CANDIDATE_SESSION_STORE ?? defaultTarget);
const outputRoot = path.resolve(
  process.env.DSH_SESSION_PARITY_OUTPUT ??
    'N:/worktrees/deepseek-harness/giana-code-putri-20260827/.artifacts/session-rehydration-final',
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stableRead(filePath) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const before = await stat(filePath);
    const bytes = await readFile(filePath);
    const after = await stat(filePath);
    const beforeRevision = before.mtimeNs?.toString() ?? String(before.mtimeMs);
    const afterRevision = after.mtimeNs?.toString() ?? String(after.mtimeMs);
    if (before.size === after.size && beforeRevision === afterRevision) {
      return {
        bytes,
        revision: `${after.size}:${afterRevision}`,
        attempts: attempt,
      };
    }
    await sleep(15 * attempt);
  }
  const error = new Error('source changed during stable read');
  error.code = 'SOURCE_CHANGED_DURING_READ';
  throw error;
}

async function listFiles(root) {
  const files = [];
  const directories = [];

  async function visit(current, relative = '') {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      const childRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        directories.push(childRelative);
        await visit(child, childRelative);
      } else if (entry.isFile()) {
        files.push(childRelative);
      } else {
        const error = new Error(`unsupported filesystem entry: ${childRelative}`);
        error.code = 'UNSUPPORTED_ENTRY';
        throw error;
      }
    }
  }

  await visit(root);
  files.sort();
  directories.sort();
  return { files, directories };
}

async function manifest(root, inventory) {
  const records = {};
  for (const relative of inventory.files) {
    const absolute = path.join(root, relative);
    const stable = await stableRead(absolute);
    records[relative] = {
      bytes: stable.bytes.length,
      sha256: createHash('sha256').update(stable.bytes).digest('hex').toUpperCase(),
      revision: stable.revision,
      stableReadAttempts: stable.attempts,
    };
  }
  return records;
}

function sortedDifference(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

function compare(source, target) {
  const allPaths = [...new Set([...Object.keys(source), ...Object.keys(target)])].sort();
  const changed = [];
  for (const relative of allPaths) {
    const sourceRecord = source[relative];
    const targetRecord = target[relative];
    if (!sourceRecord || !targetRecord) continue;
    if (sourceRecord.sha256 !== targetRecord.sha256 || sourceRecord.bytes !== targetRecord.bytes) {
      changed.push({ relative, source: sourceRecord, target: targetRecord });
    }
  }
  return changed;
}

async function main() {
  const startedAt = new Date().toISOString();
  let sourceInventory;
  let targetInventory;
  let sourceManifest;
  let targetManifest;
  let state = 'PASS_EXACT_FILE_PARITY';
  let error = null;

  try {
    await stat(sourceRoot);
    await stat(targetRoot);
    sourceInventory = await listFiles(sourceRoot);
    targetInventory = await listFiles(targetRoot);
    sourceManifest = await manifest(sourceRoot, sourceInventory);
    targetManifest = await manifest(targetRoot, targetInventory);
  } catch (caught) {
    error = { code: caught.code ?? 'READ_FAILED', message: caught.message };
    state = caught.code === 'SOURCE_CHANGED_DURING_READ'
      ? 'HELD_SOURCE_CHANGED_DURING_READ'
      : 'HELD_SESSION_STORE_READ_FAILED';
  }

  const oldOnly = sourceInventory && targetInventory
    ? sortedDifference(sourceInventory.files, targetInventory.files)
    : [];
  const newOnly = sourceInventory && targetInventory
    ? sortedDifference(targetInventory.files, sourceInventory.files)
    : [];
  const directoryOldOnly = sourceInventory && targetInventory
    ? sortedDifference(sourceInventory.directories, targetInventory.directories)
    : [];
  const directoryNewOnly = sourceInventory && targetInventory
    ? sortedDifference(targetInventory.directories, sourceInventory.directories)
    : [];
  const changedFiles = sourceManifest && targetManifest
    ? compare(sourceManifest, targetManifest)
    : [];

  if (!error) {
    if (oldOnly.length || newOnly.length || directoryOldOnly.length || directoryNewOnly.length) {
      state = 'HELD_FILE_OR_DIRECTORY_SET_MISMATCH';
    } else if (changedFiles.length) {
      state = 'STALE_SOURCE_SNAPSHOT';
    }
  }

  const report = {
    schema: 'giana-code-putri/session-rehydration-verifier/v1',
    state,
    readOnly: true,
    sourceRoot,
    targetRoot,
    startedAt,
    finishedAt: new Date().toISOString(),
    source: sourceInventory
      ? { fileCount: sourceInventory.files.length, directoryCount: sourceInventory.directories.length }
      : null,
    target: targetInventory
      ? { fileCount: targetInventory.files.length, directoryCount: targetInventory.directories.length }
      : null,
    oldOnly,
    newOnly,
    directoryOldOnly,
    directoryNewOnly,
    changedFileCount: changedFiles.length,
    changedFiles,
    interpretation: state === 'STALE_SOURCE_SNAPSHOT'
      ? 'No file or directory is missing, but source and candidate bytes differ; candidate is not current and must not be promoted or force-synced while the source runtime can write.'
      : state === 'PASS_EXACT_FILE_PARITY'
        ? 'All recursively observed files are byte-identical at stable-read time.'
        : 'Fail closed; no synchronization or mutation was attempted.',
    error,
  };

  await mkdir(outputRoot, { recursive: true });
  const outputPath = path.join(outputRoot, `session-rehydration-${Date.now()}.json`);
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outputPath, bytes, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ ...report, outputPath }, null, 2)}\n`);
  process.exitCode = state === 'PASS_EXACT_FILE_PARITY' ? 0 : 2;
}

main().catch((caught) => {
  process.stderr.write(`${caught.stack ?? caught}\n`);
  process.exitCode = 1;
});
