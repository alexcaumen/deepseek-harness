/**
 * Hash-bound PRDG workspace allowlist and Windows path containment.
 *
 * Every target a canonical principal names is a workspace-relative path. This
 * module is the only place that turns such a name into an absolute path, and it
 * refuses the full Windows escape vocabulary before touching the filesystem:
 * absolute and drive-relative forms, UNC and device namespaces, `..` traversal,
 * alternate data streams, reserved device names, and trailing dot or space
 * segments that Win32 silently strips. Containment is re-proven against the
 * resolved real path, so a symlink, junction, or drive substitution inside the
 * root cannot widen it.
 * @module dsh-llm-gianaos-workspace-bridge/workspace
 */

import { realpath } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'

/** A workspace the surface may act inside, bound to a configured identity digest. */
export interface WorkspaceBinding {
  /** Short stable selector the principal names in a tool call. */
  readonly id: string
  /** Absolute Windows root, normalized. */
  readonly root: string
  /** Operator-supplied digest identifying this exact workspace grant. */
  readonly identitySha256: string
  /** Whether `edit` may write inside this workspace. */
  readonly writable: boolean
}

/** Failure classes; every one is a refusal, never a downgrade to a wider path. */
export type WorkspaceRefusal =
  | 'ABSOLUTE_WINDOWS_ROOT_REQUIRED'
  | 'WORKSPACE_ROOT_FORBIDDEN'
  | 'WORKSPACE_UNKNOWN'
  | 'RELATIVE_TARGET_REQUIRED'
  | 'PATH_ESCAPE'
  | 'ALTERNATE_DATA_STREAM'
  | 'RESERVED_DEVICE_NAME'
  | 'UNC_OR_DEVICE_NAMESPACE'
  | 'TARGET_NOT_FOUND'
  | 'WORKSPACE_NOT_WRITABLE'

/** Raised for every containment or allowlist refusal. */
export class WorkspaceError extends Error {
  /**
   * @param refusal - the typed refusal class.
   * @param detail - optional non-secret detail appended to the message.
   */
  constructor(readonly refusal: WorkspaceRefusal, detail?: string) {
    super(detail === undefined ? refusal : `${refusal}: ${detail}`)
    this.name = 'WorkspaceError'
  }
}

const SHA256 = /^[0-9a-f]{64}$/i
const DRIVE_ROOT = /^[A-Za-z]:\\/
const RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i

/**
 * Roots refused entirely, whatever an operator configures: the canonical
 * GianaOS authority tree and the separate Princess OS lane. Neither may be
 * read or written through this surface.
 */
const FORBIDDEN_ROOTS = Object.freeze([
  'N:\\GianaOS',
  'N:\\PrincessOS',
])

/**
 * Roots where reading is allowed but writing is structurally impossible.
 * `F:\BIG-KNOWLEDGE` is a read-only diagnostic reference: the front-door
 * contract forbids new artifacts there, while the blocked case that motivated
 * this bridge is a read inside it. Forcing `writable` false here means no
 * configuration mistake can turn that reference into a write target.
 */
const READ_ONLY_ROOTS = Object.freeze([
  'F:\\BIG-KNOWLEDGE',
])

/**
 * Normalize an absolute Windows path to comparison form.
 * @param value - an absolute Windows path.
 * @returns the path with `\` separators, an upper-case drive letter, and no repeated or trailing separator.
 */
export function normalizeWindowsRoot(value: string): string {
  const slashed = value.trim().replace(/\//g, '\\').replace(/\\+/g, '\\').replace(/\\$/, '')
  if (!DRIVE_ROOT.test(slashed)) throw new WorkspaceError('ABSOLUTE_WINDOWS_ROOT_REQUIRED', value)
  return `${slashed.slice(0, 1).toUpperCase()}${slashed.slice(1)}`
}

/**
 * Whether `candidate` is the same as, or below, `root`.
 * @param candidate - normalized absolute path.
 * @param root - normalized absolute root.
 * @returns true when candidate equals root or sits under it.
 */
function isAtOrBelow(candidate: string, root: string): boolean {
  const lowerCandidate = candidate.toLowerCase()
  const lowerRoot = root.toLowerCase()
  return lowerCandidate === lowerRoot || lowerCandidate.startsWith(`${lowerRoot}\\`)
}

/**
 * Build a workspace binding, refusing a root that is not an absolute Windows
 * path, carries no identity digest, or overlaps a forbidden root.
 * @param input - the operator-configured workspace grant.
 * @returns the frozen, normalized binding.
 */
export function bindWorkspace(input: {
  id: string
  root: string
  identitySha256: string
  writable: boolean
}): WorkspaceBinding {
  const root = normalizeWindowsRoot(input.root)
  if (input.id.trim() === '') throw new WorkspaceError('WORKSPACE_UNKNOWN', 'empty workspace id')
  if (!SHA256.test(input.identitySha256)) {
    throw new WorkspaceError('WORKSPACE_UNKNOWN', 'workspace identity digest required')
  }
  for (const forbidden of FORBIDDEN_ROOTS) {
    const normalizedForbidden = normalizeWindowsRoot(forbidden)
    if (isAtOrBelow(root, normalizedForbidden) || isAtOrBelow(normalizedForbidden, root)) {
      throw new WorkspaceError('WORKSPACE_ROOT_FORBIDDEN', root)
    }
  }
  // A root at or containing a read-only reference tree cannot be writable,
  // whatever the operator configured.
  const readOnly = READ_ONLY_ROOTS.some((reference) => {
    const normalizedReference = normalizeWindowsRoot(reference)
    return isAtOrBelow(root, normalizedReference) || isAtOrBelow(normalizedReference, root)
  })
  return Object.freeze({
    id: input.id,
    root,
    identitySha256: input.identitySha256.toLowerCase(),
    writable: input.writable && !readOnly,
  })
}

/**
 * Reject every principal-supplied target that is not a plain relative path
 * inside the workspace, before any filesystem call.
 * @param target - the workspace-relative path named by the principal.
 * @returns the normalized relative path using `\` separators.
 */
export function normalizeRelativeTarget(target: string): string {
  const raw = target.trim()
  if (raw === '') throw new WorkspaceError('RELATIVE_TARGET_REQUIRED', 'empty target')
  if (raw.includes('\0')) throw new WorkspaceError('PATH_ESCAPE', 'NUL byte')
  const slashed = raw.replace(/\//g, '\\')
  if (slashed.startsWith('\\\\')) throw new WorkspaceError('UNC_OR_DEVICE_NAMESPACE', target)
  if (slashed.startsWith('\\')) throw new WorkspaceError('RELATIVE_TARGET_REQUIRED', target)
  if (/^[A-Za-z]:/.test(slashed)) throw new WorkspaceError('RELATIVE_TARGET_REQUIRED', target)

  const segments = slashed.split('\\')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new WorkspaceError('PATH_ESCAPE', target)
    }
    if (segment.includes(':')) throw new WorkspaceError('ALTERNATE_DATA_STREAM', target)
    if (RESERVED_DEVICE.test(segment)) throw new WorkspaceError('RESERVED_DEVICE_NAME', target)
    // Win32 strips trailing dots and spaces, so a segment ending in either can
    // name a different entry than the one checked here.
    if (/[. ]$/.test(segment)) throw new WorkspaceError('PATH_ESCAPE', target)
  }
  return segments.join('\\')
}

/** A target proven to sit inside its workspace, both lexically and after link resolution. */
export interface ResolvedTarget {
  readonly workspace: WorkspaceBinding
  readonly relative: string
  readonly absolute: string
  /** The real path after symlink and junction resolution. */
  readonly realAbsolute: string
}

/**
 * Resolve a principal-supplied target inside a bound workspace and prove
 * containment against the real path.
 *
 * With `mustExist` false the parent directory is resolved instead, so creating
 * a new file stays containment-checked through links.
 * @param workspace - the bound workspace.
 * @param target - the principal-supplied relative path.
 * @param mustExist - whether the target itself must already exist.
 * @returns the resolved target with its real path.
 */
export async function resolveWorkspaceTarget(
  workspace: WorkspaceBinding,
  target: string,
  mustExist: boolean,
): Promise<ResolvedTarget> {
  const relative = normalizeRelativeTarget(target)
  const absolute = resolvePath(workspace.root, relative)
  if (!isAtOrBelow(absolute, workspace.root)) throw new WorkspaceError('PATH_ESCAPE', target)

  const realRoot = normalizeWindowsRoot(await realpath(workspace.root))
  const probe = mustExist ? absolute : dirname(absolute)
  let realProbe: string
  try {
    realProbe = normalizeWindowsRoot(await realpath(probe))
  } catch {
    throw new WorkspaceError('TARGET_NOT_FOUND', target)
  }
  if (!isAtOrBelow(realProbe, realRoot)) throw new WorkspaceError('PATH_ESCAPE', target)

  const leaf = relative.slice(relative.lastIndexOf('\\') + 1)
  const realAbsolute = mustExist ? realProbe : `${realProbe}\\${leaf}`
  if (!isAtOrBelow(realAbsolute, realRoot)) throw new WorkspaceError('PATH_ESCAPE', target)
  return Object.freeze({ workspace, relative, absolute, realAbsolute })
}

/**
 * Select a bound workspace by the id a principal named.
 * @param workspaces - the configured allowlist.
 * @param id - the workspace id from the tool call.
 * @returns the matching binding.
 */
export function selectWorkspace(
  workspaces: readonly WorkspaceBinding[],
  id: string,
): WorkspaceBinding {
  const found = workspaces.find(candidate => candidate.id === id)
  if (found === undefined) throw new WorkspaceError('WORKSPACE_UNKNOWN', id)
  return found
}
