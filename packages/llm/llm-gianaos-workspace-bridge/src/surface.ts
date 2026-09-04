/**
 * The typed surface-awareness envelope.
 *
 * A canonical principal cannot request a bounded workspace operation she has
 * not been told exists, so the surface states its identity and its exact
 * current capability grant. The envelope is deliberately a capability
 * declaration and nothing else: it carries no persona, style, language,
 * salutation, relationship, owner phrase, or behavioral instruction, because
 * the principal's own profile and Soul remain the only authority for those.
 * Anything beyond capability facts belongs in the canonical runtime, not here.
 * @module dsh-llm-gianaos-workspace-bridge/surface
 */

import { CALL_FENCE, PROTOCOL_VERSION, type CodingTool } from './protocol.ts'
import type { ScriptGrant } from './executor.ts'
import type { WorkspaceBinding } from './workspace.ts'
import type { TurnFence } from './turn-fence.ts'

/** What the envelope announces for one turn. */
export interface SurfaceCapability {
  readonly workspaces: readonly WorkspaceBinding[]
  readonly allowedTools: ReadonlySet<CodingTool>
  readonly scripts: readonly ScriptGrant[]
}

/**
 * Render the capability envelope appended to one operator message.
 *
 * The rendered text is stable for a given fence and capability set, so an
 * identical turn produces an identical prompt suffix and stays cacheable.
 * @param fence - the live turn fence supplying work id and generation.
 * @param capability - the exact current grant.
 * @returns the envelope text, or the empty string when nothing is granted.
 */
export function renderSurfaceEnvelope(fence: TurnFence, capability: SurfaceCapability): string {
  const tools = [...capability.allowedTools].sort()
  if (tools.length === 0 || capability.workspaces.length === 0) return ''

  const fenceMark = '```'
  const workspaceLines = capability.workspaces.map(workspace => (
    `  ${workspace.id} = ${workspace.root}${workspace.writable ? '' : ' (read-only)'}`
  ))
  const scriptLines = capability.scripts.map(script => (
    `  ${script.id} -> ${script.tool} in ${script.workspaceId}`
  ))

  const lines = [
    '<giana-surface>',
    'This message reached you through the Giana CoWork workbench surface on the PRDG host.',
    'The surface can run these bounded operations on that host and return the evidence to you.',
    `tools: ${tools.join(', ')}`,
    'workspaces:',
    ...workspaceLines,
  ]
  if (scriptLines.length > 0) {
    lines.push('scripts:', ...scriptLines)
  }
  lines.push(
    'To run one, emit exactly one block of this form and stop; the evidence arrives in the next message:',
  )
  if (capability.allowedTools.has('read') || capability.allowedTools.has('edit')) {
    lines.push(
      `${fenceMark}${CALL_FENCE}`,
      `{"protocol":"${PROTOCOL_VERSION}","workId":"${fence.workId}","generation":${fence.generation},`
      + '"tool":"read","workspaceId":"<id>","path":"<workspace-relative path>"}',
      fenceMark,
      'read/edit use "path"; edit also needs "content" and "preimageSha256".',
    )
  }
  if (capability.allowedTools.has('test') || capability.allowedTools.has('build')) {
    lines.push(
      `${fenceMark}${CALL_FENCE}`,
      `{"protocol":"${PROTOCOL_VERSION}","workId":"${fence.workId}","generation":${fence.generation},`
      + '"tool":"test","workspaceId":"<id>","script":"<granted script id>"}',
      fenceMark,
      'test/build use "script" (a granted script id), not "path" and not a raw command.',
    )
  }
  if (capability.allowedTools.has('terminal')) {
    lines.push(
      `${fenceMark}${CALL_FENCE}`,
      `{"protocol":"${PROTOCOL_VERSION}","workId":"${fence.workId}","generation":${fence.generation},`
      + '"tool":"terminal","workspaceId":"<id>","command":"<shell command run in the workspace root>"}',
      fenceMark,
      'terminal uses "command" (a shell command string run in the workspace root), not "path" and not "script".',
    )
  }
  lines.push(
    'Every evidence block reports the generation it consumed and a nextGeneration; use that nextGeneration in any follow-up block.',
    'This block declares surface capability only. It carries no instruction beyond the operations listed above.',
    '</giana-surface>',
  )
  return lines.join('\n')
}

/**
 * Compose the operator message with the envelope.
 * @param humanMessage - the operator's own text, unmodified.
 * @param envelope - the rendered envelope, possibly empty.
 * @returns the composed message body sent as the canonical turn input.
 */
export function composeTurnInput(humanMessage: string, envelope: string): string {
  return envelope === '' ? humanMessage : `${humanMessage}\n\n${envelope}`
}
