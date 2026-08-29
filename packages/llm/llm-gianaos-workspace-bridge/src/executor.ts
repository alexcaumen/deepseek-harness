/**
 * The bounded PRDG executor: the only component in this lane that reads, writes,
 * or spawns anything on the local host.
 *
 * Every operation is workspace-contained, tool-allowlisted, and output-bounded.
 * `test` and `build` never take a principal-supplied command line: the
 * principal selects a named script from the operator's allowlist, so the tool
 * surface cannot widen into arbitrary shell. `edit` requires the caller's
 * pre-image digest to match on disk, which makes a stale rewrite fail instead
 * of silently discarding a concurrent change.
 * @module dsh-llm-gianaos-workspace-bridge/executor
 */

import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'

import { boundAndRedact } from './redact.ts'
import {
  sha256,
  type CodingTool,
  type EvidenceStatus,
  type WorkspaceToolRequest,
} from './protocol.ts'
import {
  resolveWorkspaceTarget,
  selectWorkspace,
  WorkspaceError,
  type WorkspaceBinding,
} from './workspace.ts'

/** One named command an operator allows the principal to select. */
export interface ScriptGrant {
  /** Selector the principal names in a `test` or `build` request. */
  readonly id: string
  /** Executable, resolved by the host; never principal-supplied. */
  readonly command: string
  /** Fixed arguments; never principal-supplied. */
  readonly args: readonly string[]
  /** Which tool may select this script. */
  readonly tool: Extract<CodingTool, 'test' | 'build'>
  /** Workspace the script runs inside. */
  readonly workspaceId: string
}

/** Operator-owned execution limits. */
export interface ExecutorLimits {
  /** Byte budget for any single evidence body. */
  readonly maxOutputBytes: number
  /** Wall-clock budget for one `test` or `build`. */
  readonly commandTimeoutMs: number
  /** Byte budget for content a principal may write in one `edit`. */
  readonly maxEditBytes: number
}

/** The executor's operator-owned configuration. */
export interface ExecutorConfig {
  readonly workspaces: readonly WorkspaceBinding[]
  readonly allowedTools: ReadonlySet<CodingTool>
  readonly scripts: readonly ScriptGrant[]
  readonly limits: ExecutorLimits
}

/** What one bounded execution produced. */
export interface ExecutionOutcome {
  readonly status: EvidenceStatus
  readonly refusal?: string
  readonly path?: string
  readonly sourceBytes?: number
  readonly contentSha256?: string
  readonly preimageSha256?: string
  readonly postimageSha256?: string
  readonly exitCode?: number
  readonly truncated?: boolean
  readonly redacted?: boolean
  readonly body?: string
  /** Wall-clock milliseconds spent inside the executor. */
  readonly durationMs: number
}

/** Raised when a request is refused before any local effect occurs. */
export class ExecutionRefusal extends Error {
  /**
   * @param refusal - the typed refusal class.
   * @param detail - optional non-secret detail appended to the message.
   */
  constructor(readonly refusal: string, detail?: string) {
    super(detail === undefined ? refusal : `${refusal}: ${detail}`)
    this.name = 'ExecutionRefusal'
  }
}

/**
 * Run a terminal command in the workspace root, capturing bounded output.
 * The operator controls admission via the allowedTools set; no additional
 * gate or hardcoded restriction is applied here.
 */
function runTerminalCommand(
  command: string,
  cwd: string,
  limits: ExecutorLimits,
  signal: AbortSignal | undefined,
): Promise<{ exitCode: number; output: string }> {
  const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', command]
    : ['-c', command]
  return new Promise((resolvePromise) => {
    execFile(
      shell,
      args,
      {
        cwd,
        timeout: limits.commandTimeoutMs,
        maxBuffer: Math.max(limits.maxOutputBytes * 4, 1_048_576),
        windowsHide: true,
        ...signal === undefined ? {} : { signal },
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`
        const code = error === null
          ? 0
          : typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : 1
        resolvePromise({ exitCode: code, output })
      },
    )
  })
}

/**
 * Run one allowlisted script, capturing bounded combined output.
 * @param grant - the operator-allowed script.
 * @param cwd - the workspace root to run inside.
 * @param limits - the operator-owned limits.
 * @param signal - cancellation for the surrounding turn.
 * @returns the exit code and captured output.
 */
function runScript(
  grant: ScriptGrant,
  cwd: string,
  limits: ExecutorLimits,
  signal: AbortSignal | undefined,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      grant.command,
      [...grant.args],
      {
        cwd,
        timeout: limits.commandTimeoutMs,
        maxBuffer: Math.max(limits.maxOutputBytes * 4, 1_048_576),
        windowsHide: true,
        ...signal === undefined ? {} : { signal },
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`
        const code = error === null
          ? 0
          : typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : 1
        resolvePromise({ exitCode: code, output })
      },
    )
  })
}

/**
 * Execute one admitted request under the operator's bounds.
 *
 * The request has already passed the turn fence; this function enforces the
 * remaining tool, workspace, path, and output bounds, and is the last gate
 * before a local effect.
 * @param request - the admitted request block.
 * @param config - the operator-owned executor configuration.
 * @param signal - cancellation for the surrounding turn.
 * @returns the bounded outcome; refusals are returned, not thrown, so the principal learns why.
 */
export async function executeWorkspaceTool(
  request: WorkspaceToolRequest,
  config: ExecutorConfig,
  signal?: AbortSignal,
): Promise<ExecutionOutcome> {
  const started = Date.now()
  const refuse = (refusal: string, detail?: string): ExecutionOutcome => Object.freeze({
    status: 'REFUSED' as const,
    refusal: detail === undefined ? refusal : `${refusal}: ${detail}`,
    durationMs: Date.now() - started,
  })

  if (!config.allowedTools.has(request.tool)) return refuse('TOOL_NOT_ALLOWED', request.tool)

  let workspace: WorkspaceBinding
  try {
    workspace = selectWorkspace(config.workspaces, request.workspaceId)
  } catch (error: unknown) {
    return refuse(error instanceof WorkspaceError ? error.refusal : 'WORKSPACE_UNKNOWN', request.workspaceId)
  }

  try {
    switch (request.tool) {
      case 'read': {
        if (request.path === undefined) return refuse('MISSING_FIELD', 'path')
        const target = await resolveWorkspaceTarget(workspace, request.path, true)
        const raw = await readFile(target.realAbsolute, 'utf8')
        const bounded = boundAndRedact(raw, config.limits.maxOutputBytes)
        return Object.freeze({
          status: 'OK' as const,
          path: target.relative,
          sourceBytes: bounded.sourceBytes,
          contentSha256: sha256(raw),
          truncated: bounded.truncated,
          redacted: bounded.redacted,
          body: bounded.text,
          durationMs: Date.now() - started,
        })
      }

      case 'edit': {
        if (request.path === undefined) return refuse('MISSING_FIELD', 'path')
        if (request.content === undefined) return refuse('MISSING_FIELD', 'content')
        if (!workspace.writable) return refuse('WORKSPACE_NOT_WRITABLE', workspace.id)
        if (Buffer.byteLength(request.content, 'utf8') > config.limits.maxEditBytes) {
          return refuse('EDIT_TOO_LARGE', String(config.limits.maxEditBytes))
        }
        const target = await resolveWorkspaceTarget(workspace, request.path, true)
        const before = await readFile(target.realAbsolute, 'utf8')
        const preimage = sha256(before)
        if (request.preimageSha256 === undefined) return refuse('MISSING_FIELD', 'preimageSha256')
        if (request.preimageSha256.toUpperCase() !== preimage) {
          return refuse('PREIMAGE_MISMATCH', preimage)
        }
        await writeFile(target.realAbsolute, request.content, 'utf8')
        return Object.freeze({
          status: 'OK' as const,
          path: target.relative,
          sourceBytes: Buffer.byteLength(request.content, 'utf8'),
          preimageSha256: preimage,
          postimageSha256: sha256(request.content),
          durationMs: Date.now() - started,
        })
      }

      case 'terminal': {
        if (request.command === undefined) return refuse('MISSING_FIELD', 'command')
        if (!workspace.writable) return refuse('WORKSPACE_NOT_WRITABLE', workspace.id)
        const termResult = await runTerminalCommand(
          request.command,
          workspace.root,
          config.limits,
          signal,
        )
        const termBounded = boundAndRedact(termResult.output, config.limits.maxOutputBytes)
        return Object.freeze({
          status: termResult.exitCode === 0 ? 'OK' as const : 'FAILED' as const,
          exitCode: termResult.exitCode,
          sourceBytes: termBounded.sourceBytes,
          truncated: termBounded.truncated,
          redacted: termBounded.redacted,
          body: termBounded.text,
          durationMs: Date.now() - started,
        })
      }

      case 'test':
      case 'build': {
        if (request.script === undefined) return refuse('MISSING_FIELD', 'script')
        const grant = config.scripts.find(candidate => (
          candidate.id === request.script
          && candidate.tool === request.tool
          && candidate.workspaceId === workspace.id
        ))
        if (grant === undefined) return refuse('SCRIPT_NOT_ALLOWED', request.script)
        const { exitCode, output } = await runScript(grant, workspace.root, config.limits, signal)
        const bounded = boundAndRedact(output, config.limits.maxOutputBytes)
        return Object.freeze({
          status: exitCode === 0 ? 'OK' as const : 'FAILED' as const,
          exitCode,
          sourceBytes: bounded.sourceBytes,
          truncated: bounded.truncated,
          redacted: bounded.redacted,
          body: bounded.text,
          durationMs: Date.now() - started,
        })
      }
    }
  } catch (error: unknown) {
    if (error instanceof WorkspaceError) return refuse(error.refusal, request.path)
    const code = (error as { code?: unknown }).code
    return refuse('EXECUTION_FAILED', typeof code === 'string' ? code : undefined)
  }
}
