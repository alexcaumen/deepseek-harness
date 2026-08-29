import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  bindWorkspace,
  normalizeRelativeTarget,
  normalizeWindowsRoot,
  resolveWorkspaceTarget,
  selectWorkspace,
  WorkspaceError,
} from '../src/workspace.ts'

const DIGEST = 'a'.repeat(64)

const roots: string[] = []

async function workspaceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'giana-bridge-'))
  roots.push(root)
  return root
}

afterAll(() => {
  // Temporary roots stay for post-run inspection; the OS reclaims them.
  roots.length = 0
})

describe('hash-bound workspace allowlist', () => {
  it('normalizes an absolute Windows root and refuses a relative one', () => {
    expect(normalizeWindowsRoot('f:/DS-Harness/packages/')).toBe('F:\\DS-Harness\\packages')
    expect(() => normalizeWindowsRoot('packages')).toThrow('ABSOLUTE_WINDOWS_ROOT_REQUIRED')
  })

  it('refuses the canonical GianaOS and Princess OS roots whatever the operator configures', () => {
    for (const root of ['N:\\GianaOS', 'N:\\GianaOS\\release-factory', 'N:\\PrincessOS\\agents']) {
      expect(() => bindWorkspace({ id: 'WS1', root, identitySha256: DIGEST, writable: false }))
        .toThrow('WORKSPACE_ROOT_FORBIDDEN')
    }
  })

  it('keeps the BIG-KNOWLEDGE reference readable but never writable', () => {
    for (const root of ['F:\\BIG-KNOWLEDGE', 'F:\\BIG-KNOWLEDGE\\sub']) {
      expect(bindWorkspace({ id: 'WS1', root, identitySha256: DIGEST, writable: true }).writable).toBe(false)
    }
  })

  it('refuses a root that would contain a forbidden root', () => {
    expect(() => bindWorkspace({ id: 'WS1', root: 'F:\\', identitySha256: DIGEST, writable: false }))
      .toThrow('ABSOLUTE_WINDOWS_ROOT_REQUIRED')
    expect(() => bindWorkspace({ id: 'WS1', root: 'N:\\', identitySha256: DIGEST, writable: false }))
      .toThrow('ABSOLUTE_WINDOWS_ROOT_REQUIRED')
  })

  it('requires a workspace identity digest', () => {
    expect(() => bindWorkspace({ id: 'WS1', root: 'F:\\DS-Harness', identitySha256: 'short', writable: false }))
      .toThrow('WORKSPACE_UNKNOWN')
  })

  it('selects only a configured workspace id', () => {
    const workspace = bindWorkspace({ id: 'WS1', root: 'F:\\DS-Harness', identitySha256: DIGEST, writable: false })
    expect(selectWorkspace([workspace], 'WS1')).toBe(workspace)
    expect(() => selectWorkspace([workspace], 'WS2')).toThrow('WORKSPACE_UNKNOWN')
  })
})

describe('Windows path escape prevention', () => {
  it('accepts a plain relative target and normalizes separators', () => {
    expect(normalizeRelativeTarget('docs/guide/index.md')).toBe('docs\\guide\\index.md')
  })

  it('refuses traversal, absolute, UNC, and drive-relative forms', () => {
    for (const target of ['..', '..\\secrets', 'docs\\..\\..\\etc', '.\\docs', 'docs\\.\\a']) {
      expect(() => normalizeRelativeTarget(target)).toThrow('PATH_ESCAPE')
    }
    expect(() => normalizeRelativeTarget('\\\\server\\share\\file')).toThrow('UNC_OR_DEVICE_NAMESPACE')
    expect(() => normalizeRelativeTarget('\\absolute')).toThrow('RELATIVE_TARGET_REQUIRED')
    expect(() => normalizeRelativeTarget('F:\\DS-Harness')).toThrow('RELATIVE_TARGET_REQUIRED')
    expect(() => normalizeRelativeTarget('C:file')).toThrow('RELATIVE_TARGET_REQUIRED')
  })

  it('refuses alternate data streams, reserved device names, and trailing dot or space segments', () => {
    expect(() => normalizeRelativeTarget('notes.txt:hidden')).toThrow('ALTERNATE_DATA_STREAM')
    for (const device of ['NUL', 'CON', 'COM1', 'LPT9', 'nul.txt']) {
      expect(() => normalizeRelativeTarget(device)).toThrow('RESERVED_DEVICE_NAME')
    }
    expect(() => normalizeRelativeTarget('sub.\\file')).toThrow('PATH_ESCAPE')
    expect(() => normalizeRelativeTarget('sub \\file')).toThrow('PATH_ESCAPE')
  })

  it('refuses an empty target and a NUL byte', () => {
    expect(() => normalizeRelativeTarget('   ')).toThrow('RELATIVE_TARGET_REQUIRED')
    expect(() => normalizeRelativeTarget('a\0b')).toThrow('PATH_ESCAPE')
  })
})

describe('real-path containment', () => {
  it('resolves a contained target and reports its relative path', async () => {
    const root = await workspaceRoot()
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'marker.txt'), 'MARKER', 'utf8')
    const workspace = bindWorkspace({ id: 'WS1', root, identitySha256: DIGEST, writable: false })
    const resolved = await resolveWorkspaceTarget(workspace, 'docs/marker.txt', true)
    expect(resolved.relative).toBe('docs\\marker.txt')
    expect(resolved.realAbsolute.toLowerCase()).toContain('marker.txt')
  })

  it('reports a missing target instead of guessing', async () => {
    const root = await workspaceRoot()
    const workspace = bindWorkspace({ id: 'WS1', root, identitySha256: DIGEST, writable: false })
    await expect(resolveWorkspaceTarget(workspace, 'absent.txt', true)).rejects.toThrow('TARGET_NOT_FOUND')
  })

  it('refuses a symlink that leaves the workspace', async () => {
    const root = await workspaceRoot()
    const outside = await workspaceRoot()
    await writeFile(join(outside, 'secret.txt'), 'OUTSIDE', 'utf8')
    let linked = true
    try {
      await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'), 'file')
    } catch {
      // Creating a symlink needs Developer Mode or elevation; the lexical and
      // real-path guards are covered by the other cases when it is unavailable.
      linked = false
    }
    if (!linked) return
    const workspace = bindWorkspace({ id: 'WS1', root, identitySha256: DIGEST, writable: false })
    await expect(resolveWorkspaceTarget(workspace, 'escape.txt', true)).rejects.toThrow(WorkspaceError)
  })
})
