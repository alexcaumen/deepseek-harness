/**
 * Durable session skill catalog and model-facing `skill` loader tool.
 *
 * @module @deepseek-ai/dsh-tool-skill
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import {
  escapeText,
  isModelInvocable,
  isSkillName,
  isUserInvocable,
  renderSkillContent,
  type SkillInvocationSource,
  type SkillSummary,
} from '@deepseek-ai/dsh-skill'

export const name = 'tool-skill'
export const inject = ['agents', 'tools', 'skills']

const DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500
const DEFAULT_CATALOG_MAX_ENTRIES = Number.MAX_SAFE_INTEGER
const DEFAULT_SEARCH_RESULT_LIMIT = 25
/**
 * Durable provider and item records for one published session skill catalog. The catalog is a
 * `catalog`-form context, so it records the entries it published beside the
 * model-facing prose: a consumer presenting the list must not re-parse the
 * `<available_skills>` block, whose framing exists for the model.
 */
export interface SkillCatalogSource {
  readonly kind: 'skill-catalog'
  readonly form: 'catalog'
  /** Marks a replacement catalog rather than this session's first publication. */
  readonly update?: true
  /** Exactly the entries this message published, in catalog order. */
  readonly entries: readonly { readonly name: string; readonly description: string }[]
  /** Full model-invocable population when the rendered catalog is intentionally bounded. */
  readonly totalAvailable?: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'skill-catalog': SkillCatalogSource
  }
}

/** Durable entry list mirroring the rendered catalog lines, for non-model consumers. */
function catalogSourceEntries(
  skills: SkillSummary[],
  descriptionMaxLength: number,
): SkillCatalogSource['entries'] {
  return skills.map(skill => ({
    name: skill.name,
    description: catalogDescription(skill.description, descriptionMaxLength),
  }))
}

/** Model-facing skill catalog configuration. */
export interface Config {
  /** Maximum normalized description length rendered in the session catalog; minimum 3. */
  catalogDescriptionMaxLength?: number
  /** Maximum entries rendered in the durable session catalog; all entries remain searchable. */
  catalogMaxEntries?: number
  /** Maximum entries returned by one model-facing skill search. */
  searchResultLimit?: number
  /** Names that should be rendered first when the catalog is bounded. */
  catalogPinnedNames?: string[]
}

/** Validate and default the model-facing skill catalog configuration. */
export const Config: z<Config> = z.object({
  catalogDescriptionMaxLength: z.number().default(DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH),
  catalogMaxEntries: z.number().default(DEFAULT_CATALOG_MAX_ENTRIES),
  searchResultLimit: z.number().default(DEFAULT_SEARCH_RESULT_LIMIT),
  catalogPinnedNames: z.array(z.string()).default([]),
})

/**
 * Register the model-facing skill loader and its visibility-matched
 * durable session catalog. The catalog is emitted only when the calling agent
 * resolves this plugin's exact tool registration; a restriction or scoped
 * same-name shadow therefore removes both the schema and its call guidance.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const catalogDescriptionMaxLength = config.catalogDescriptionMaxLength ?? DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH
  const catalogMaxEntries = config.catalogMaxEntries ?? DEFAULT_CATALOG_MAX_ENTRIES
  const searchResultLimit = config.searchResultLimit ?? DEFAULT_SEARCH_RESULT_LIMIT
  const catalogPinnedNames = config.catalogPinnedNames ?? []
  assertPositiveInteger('catalogDescriptionMaxLength', catalogDescriptionMaxLength, 3)
  assertPositiveInteger('catalogMaxEntries', catalogMaxEntries)
  assertPositiveInteger('searchResultLimit', searchResultLimit)
  for (const pinnedName of catalogPinnedNames) {
    if (!isSkillName(pinnedName)) throw new Error(`tool-skill: invalid catalogPinnedNames entry "${pinnedName}"`)
  }

  const skillTool = defineTool({
    name: 'skill',
    description: 'Load the full instructions for an available skill. Call this with the exact skill name from the session skill catalog before acting on a task that names or clearly matches that skill.',
    parameters: {
      name: { type: 'string', required: true, description: 'The exact skill name from the available skills list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          resourceBase: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'directory' },
                  path: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'url' },
                  url: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'opaque' },
                  description: { type: 'string', required: true },
                },
              },
            ],
          },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSkillContent(value) }],
    },
    async execute(args, exec) {
      if (!isSkillName(args.name)) {
        throw new Error(`invalid skill name "${args.name}"`)
      }
      // The agent is its own scope key, so the lookup resolves the layered
      // registry exactly as this agent's composition sees it.
      const lookup = { cwd: exec.agent?.session.header.cwd, signal: exec.signal, scope: exec.agent }
      const summary = (await ctx.skills.list(lookup)).find(skill => skill.name === args.name)
      if (!summary) {
        throw new Error(`skill "${args.name}" is unknown or no longer available`)
      }
      if (!isModelInvocable(summary)) {
        throw new Error(`skill "${args.name}" is not available for model invocation`)
      }
      const skill = await ctx.skills.get(args.name, lookup)
      if (!skill) {
        throw new Error(`skill "${args.name}" is unknown or no longer available`)
      }
      if (!isModelInvocable(skill)) {
        throw new Error(`skill "${args.name}" is not available for model invocation`)
      }
      return {
        name: skill.name,
        provider: skill.provider,
        ...skill.resourceBase !== undefined ? {
          resourceBase: { ...skill.resourceBase },
        } : {},
        content: skill.content,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Load skill ${args.name}`, kind: 'read', rawInput: args.name }
    },
  })
  ctx.tools.register(skillTool)

  const skillSearchTool = defineTool({
    name: 'skill_search',
    description: 'Search every available model-invocable skill by name and description. Use this when the bounded session catalog does not list the capability you need, then call `skill` with an exact returned name.',
    parameters: {
      query: { type: 'string', required: true, description: 'Words describing the capability or skill name to find.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          totalMatches: { type: 'number', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value, null, 2),
      }],
    },
    async execute(args, exec) {
      const query = args.query.replaceAll(/\s+/g, ' ').trim().toLowerCase()
      if (query === '') throw new Error('skill_search query must not be empty')
      const lookup = { cwd: exec.agent?.session.header.cwd, signal: exec.signal, scope: exec.agent }
      const matches = (await ctx.skills.list(lookup))
        .filter(isModelInvocable)
        .map(skill => ({ skill, score: skillSearchScore(skill, query) }))
        .filter(row => row.score !== undefined)
        .sort((left, right) => (left.score as number) - (right.score as number)
          || left.skill.name.localeCompare(right.skill.name))
      return {
        query,
        totalMatches: matches.length,
        results: matches.slice(0, searchResultLimit).map(({ skill }) => ({
          name: skill.name,
          description: catalogDescription(skill.description, catalogDescriptionMaxLength),
        })),
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Search skills for ${args.query}`, kind: 'read', rawInput: args.query }
    },
  })
  ctx.tools.register(skillSearchTool)

  // User-explicit skill invocation: a claimed user message whose first line
  // starts with `/<name>` naming a user-invocable skill is a deterministic
  // load gesture. The rendered body enters this step as injected
  // instructions context appended after every other injection — background
  // first (workspace rules, runtime policy, the catalog), the material the
  // model must act on last, closest to its answer. Registration order makes
  // that placement deterministic: this listener registers before the catalog
  // listener, so the waterfall hands it the catalog-bearing list to extend.
  // Only `source.kind === 'user'` messages are scanned — external text
  // cannot forge the gesture — and a token naming no user-invocable skill
  // stays ordinary prose (the command registry is a different closed
  // namespace, resolved client-side before a line ever becomes a prompt).
  // This is the only entry point for `disable-model-invocation` skills; the
  // catalog and the `skill` tool below never see them.
  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const names = invokedSkillNames(messages)
    if (names.length === 0) return decision
    signal.throwIfAborted()
    const lookup = { cwd: agent.session.header.cwd, signal, scope: agent }
    const injections: UserMessage[] = []
    for (const name of names) {
      const skill = await ctx.skills.get(name, lookup)
      signal.throwIfAborted()
      // Unknown names and user-disabled skills stay plain prose: the
      // gesture was never a claim this boundary recognizes. The check sits
      // on the loaded definition — the single lookup that produces what is
      // actually injected.
      if (skill === undefined || !isUserInvocable(skill)) continue
      const source: SkillInvocationSource = { kind: 'skill-invocation', name, form: 'instructions' }
      injections.push(createUserMessage({
        content: [{ type: 'text', text: renderSkillContent(skill) }],
        source,
      }))
    }
    if (injections.length === 0) return decision
    return { kind: 'enter', messages: [...decision.messages, ...injections] }
  })

  // Register after the tool so reverse teardown removes guidance first. Exact definition
  // identity prevents a scoped shadow merely named `skill` from inheriting this catalog.
  //
  // The comparison is against the definition this plugin registered, not against
  // a lookup of its own name: `register()` files into the CALLING context's
  // scope, so a plugin mounted inside an agent preset registers for that agent
  // alone and an unscoped lookup correctly finds nothing.
  ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()
    const toolVisible = ctx.tools.get(skillTool.name, agent) === skillTool
    const snapshot = toolVisible
      ? await ctx.skills.snapshot({ cwd: agent.session.header.cwd, signal, scope: agent })
      : { skills: [], complete: true }
    signal.throwIfAborted()
    if (!snapshot.complete) return decision
    const skills = snapshot.skills.filter(isModelInvocable)
    const visibleSkills = selectCatalogSkills(skills, catalogMaxEntries, catalogPinnedNames)
    const entries = catalogSourceEntries(visibleSkills, catalogDescriptionMaxLength)
    const totalAvailable = skills.length > entries.length ? skills.length : undefined
    const digest = digestCatalogEntries(entries, totalAvailable)
    const history = catalogHistory(agent)
    const existing = catalogMessage(decision.messages)
    if (history.visibleDigest === digest) {
      return existing === undefined
        ? decision
        : { kind: 'enter', messages: decision.messages.filter(message => message.id !== existing.message.id) }
    }
    if (existing !== undefined && digestCatalogEntries(existing.entries, existing.totalAvailable) === digest) return decision
    if (!history.published && skills.length === 0) {
      return existing === undefined
        ? decision
        : { kind: 'enter', messages: decision.messages.filter(message => message.id !== existing.message.id) }
    }
    const catalog = history.published
      ? renderCatalogUpdate(entries, totalAvailable)
      : renderCatalogMessage(entries, totalAvailable)
    return {
      kind: 'enter',
      messages: existing === undefined
        ? [...decision.messages, catalog]
        : decision.messages.map(message => message.id === existing.message.id ? catalog : message),
    }
  })
}

function renderCatalogMessage(entries: SkillCatalogSource['entries'], totalAvailable?: number): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
        '',
        '<available_skills>',
        ...renderCatalogEntries(entries),
        '</available_skills>',
        '',
        ...catalogSearchGuidance(entries.length, totalAvailable),
        "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
        'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
        '</system-reminder>',
      ].join('\n'),
    }],
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      entries,
      ...totalAvailable === undefined ? {} : { totalAvailable },
    },
  })
}

function renderCatalogUpdate(entries: SkillCatalogSource['entries'], totalAvailable?: number): UserMessage {
  const availability = entries.length === 0
    ? [
      'No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs.',
      'A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool for it.',
    ]
    : [
      'Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.',
      'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
    ]
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:',
        '',
        '<available_skills>',
        ...renderCatalogEntries(entries),
        '</available_skills>',
        '',
        ...catalogSearchGuidance(entries.length, totalAvailable),
        ...availability,
        '</system-reminder>',
      ].join('\n'),
    }],
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      update: true,
      entries,
      ...totalAvailable === undefined ? {} : { totalAvailable },
    },
  })
}

/**
 * Model-facing catalog lines, projected from the same entries the source records.
 * The pseudo-XML escaping belongs to this frame, not to the published fact, so it
 * is applied here and never stored. Names are `isSkillName`-validated and carry
 * no escapable character.
 */
function renderCatalogEntries(entries: SkillCatalogSource['entries']): string[] {
  return entries.map(entry => `- \`${entry.name}\`: ${escapeText(entry.description)}`)
}

/**
 * Catalog identity over the durable entry list rather than the rendered prose.
 * The entries are what changes; the surrounding `<system-reminder>` framing is
 * written for the model and must not decide whether a republish is needed.
 */
function digestCatalogEntries(entries: SkillCatalogSource['entries'], totalAvailable?: number): string {
  // JSON per entry rather than a separator character: every separator is itself
  // a legal description character, so only quoting makes the boundary exact.
  const canonical = JSON.stringify({ totalAvailable: totalAvailable ?? entries.length, entries })
  return createHash('sha256')
    .update(canonical)
    .digest('hex')
}

/**
 * Entries of one durable catalog message, or undefined when the record is not a
 * usable catalog.
 *
 * `agent.session.events` may be a resumed, forked, or externally written seed,
 * and seed validation only guarantees a source object with a non-empty `kind`;
 * no per-kind field is checked there. An unreadable record is therefore treated
 * as "not this plugin's catalog" — the posture the replaced content digest had —
 * rather than throwing inside the step listener, which would fail every
 * subsequent turn of that session.
 */
function readCatalogRecord(source: unknown): { entries: SkillCatalogSource['entries']; totalAvailable?: number } | undefined {
  const entries = (source as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return undefined
  const readable: { name: string; description: string }[] = []
  for (const entry of entries as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { name, description } = entry as { name?: unknown; description?: unknown }
    if (typeof name !== 'string' || name === '' || typeof description !== 'string') return undefined
    readable.push({ name, description })
  }
  const totalAvailable = (source as { totalAvailable?: unknown }).totalAvailable
  if (totalAvailable !== undefined && (!Number.isInteger(totalAvailable) || (totalAvailable as number) < readable.length)) {
    return undefined
  }
  return {
    entries: readable,
    ...totalAvailable === undefined ? {} : { totalAvailable: totalAvailable as number },
  }
}

function catalogHistory(agent: Agent): { visibleDigest?: string; published: boolean } {
  const visible = new Set(agent.session.surface.nodes)
  const events = agent.session.events
  let published = false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // The loop bounds prove the read-only event view contains this index.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const event = events[index]!
    if (event.type !== 'user/message' || event.data.source.kind !== 'skill-catalog') continue
    const record = readCatalogRecord(event.data.source)
    if (record === undefined) continue
    const digest = digestCatalogEntries(record.entries, record.totalAvailable)
    published = true
    if (visible.has(event.seq)) return { visibleDigest: digest, published }
  }
  return { published }
}

function catalogMessage(
  messages: readonly UserMessage[],
): { message: UserMessage; entries: SkillCatalogSource['entries']; totalAvailable?: number } | undefined {
  for (const message of messages) {
    if (message.source.kind !== 'skill-catalog') continue
    const record = readCatalogRecord(message.source)
    if (record !== undefined) return { message, ...record }
  }
  return undefined
}

/** Normalized, length-bounded description exactly as the catalog publishes it (unescaped). */
function catalogDescription(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}

function selectCatalogSkills(skills: SkillSummary[], maximum: number, pinnedNames: readonly string[]): SkillSummary[] {
  if (skills.length <= maximum) return skills
  const byName = new Map(skills.map(skill => [skill.name, skill]))
  const selected: SkillSummary[] = []
  for (const name of pinnedNames) {
    const skill = byName.get(name)
    if (skill !== undefined && !selected.includes(skill)) selected.push(skill)
    if (selected.length === maximum) return selected
  }
  for (const skill of skills) {
    if (!selected.includes(skill)) selected.push(skill)
    if (selected.length === maximum) break
  }
  return selected
}

function catalogSearchGuidance(rendered: number, totalAvailable?: number): string[] {
  if (totalAvailable === undefined) return []
  return [
    `This bounded catalog shows ${rendered} of ${totalAvailable} available skills.`,
    'Use `skill_search` to find every other indexed skill, then load the exact returned name with `skill`.',
    '',
  ]
}

function skillSearchScore(skill: SkillSummary, query: string): number | undefined {
  const name = skill.name.toLowerCase()
  const description = skill.description.toLowerCase()
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  if (name.includes(query)) return 2
  const tokens = query.split(' ').filter(Boolean)
  if (tokens.length > 0 && tokens.every(token => name.includes(token) || description.includes(token))) return 3
  if (description.includes(query)) return 4
  return undefined
}

function assertPositiveInteger(name: string, value: number, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`tool-skill: ${name} must be an integer greater than or equal to ${minimum}`)
  }
}

/**
 * A whitespace-bounded `/name` token (the public skill-name grammar) anywhere
 * in the text — the same word-boundary shape the transcript chip decoration
 * uses, so a gesture reads as one wherever it sits in the sentence. A second
 * `/` or any non-boundary character breaks the match, which keeps file paths
 * (`/usr/bin`) and fractions (`5/8`) out.
 */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

/**
 * `/name` gesture tokens from the claimed user messages, deduplicated in
 * first-seen order. Every text block of direct user input is scanned; no
 * other source can forge a gesture.
 * @param messages - the step's claimed batch.
 * @returns candidate skill names, unvalidated against the registry.
 */
function invokedSkillNames(messages: readonly UserMessage[]): string[] {
  const names: string[] = []
  for (const message of messages) {
    if ((message.source as { kind?: unknown }).kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        const name = match[2]
        if (name !== undefined && !names.includes(name)) names.push(name)
      }
    }
  }
  return names
}
