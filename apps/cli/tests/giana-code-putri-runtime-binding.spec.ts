import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'

interface PatchEntry {
  id?: string
  config?: Record<string, unknown>
  insert?: PatchEntry[]
}

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const PATCH_PATH = join(REPO_ROOT, 'configs', 'giana-code-putri.patch.yml')

function entriesFromPatch(): PatchEntry[] {
  const parsed: unknown = yaml.load(readFileSync(PATCH_PATH, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError('the Giana Code Putri patch must parse to an entry array')
  return (parsed as PatchEntry[]).flatMap(entry => Array.isArray(entry.insert) ? entry.insert : [entry])
}

function evaluatedString(value: unknown, env: Record<string, string>): string {
  const evaluated: unknown = value !== null && typeof value === 'object' && '__jsExpr' in value
    ? evaluate({ process: { env } }, (value as { __jsExpr: string }).__jsExpr) as unknown
    : value
  if (typeof evaluated !== 'string') throw new TypeError('the runtime path must evaluate to a string')
  return evaluated
}

describe('Giana Code Putri runtime binding', () => {
  it('derives ACP and browser paths from the selected source and isolated home', () => {
    const isolatedHome = join(REPO_ROOT, '.test-giana-code-putri-home')
    const env = { DSH_SOURCE_ROOT: REPO_ROOT, DSH_HOME: isolatedHome }
    const entries = entriesFromPatch()
    const gianaOs = entries.find(entry => entry.id === 'llm-gianaos-acp')?.config
    const princessOs = entries.find(entry => entry.id === 'llm-princess-os')?.config
    const playwright = entries.find(entry => entry.id === 'mcp-playwright')?.config
    const systemPrompt = entries.find(entry => entry.id === 'system-prompt')?.config
    const approval = entries.find(entry => entry.id === 'approval')?.config
    const permission = entries.find(entry => entry.id === 'permission')?.config
    const launchScript = evaluatedString(gianaOs?.launchScript, env)
    const playwrightArgs = playwright?.args

    expect(resolve(evaluatedString(gianaOs?.localWorkspace, env))).toBe(REPO_ROOT)
    expect(resolve(launchScript)).toBe(join(REPO_ROOT, 'scripts', 'princess-os', 'Start-GianaOsPutriAcp.mjs'))
    expect(existsSync(launchScript)).toBe(true)
    expect(resolve(evaluatedString(princessOs?.workspace, env))).toBe(REPO_ROOT)
    expect(Array.isArray(playwrightArgs)).toBe(true)
    expect(resolve(evaluatedString((playwrightArgs as unknown[])[0], env)))
      .toBe(join(isolatedHome, 'profiles', 'web', 'node_modules', '@playwright', 'mcp', 'cli.js'))
    const outputDirectoryIndex = (playwrightArgs as unknown[]).indexOf('--output-dir') + 1
    expect(outputDirectoryIndex).toBeGreaterThan(0)
    expect(resolve(evaluatedString((playwrightArgs as unknown[])[outputDirectoryIndex], env)))
      .toBe(join(REPO_ROOT, '.artifacts', 'playwright-mcp', 'output'))
    expect(approval?.policy).toBe('ask')
    expect(permission?.presets).toMatchObject({
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'ask' },
    })
    expect(permission?.reconcileExistingPresets).toEqual(['danger-full-access'])
    expect(systemPrompt?.persona).toContain('working inside Giana Code Putri')
    expect(systemPrompt?.persona).toContain('Keep private chain-of-thought')
    expect(systemPrompt?.persona).toContain('one concise user-facing final answer')
    expect(systemPrompt?.persona).toContain('newest steering message as governing the next action')
    expect(systemPrompt?.persona).toContain('never restart or abandon prior progress unless explicitly ordered')
  })
})
