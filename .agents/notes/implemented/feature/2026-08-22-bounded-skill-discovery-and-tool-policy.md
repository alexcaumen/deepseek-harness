# Agent Note: Bounded skill discovery and deployment tool policy

Status: implemented

English | [中文](2026-08-22-bounded-skill-discovery-and-tool-policy.zh.md)

## Problem

Deployments can mount hundreds of local and plugin-provided skills plus broad MCP tool surfaces. Rendering every skill summary in every model request wastes context, while hiding the excess prevents the model from discovering capabilities that remain executable. External browser servers may also publish operations that a deployment must reject even though the rest of that server is useful. A UI-only filter or prompt rule would not protect alternate callers of the tool registry.

## Decision

`dsh-tool-skill` retains the complete scoped skill provider as authority and adds a bounded durable catalog projection. `catalogMaxEntries` limits the rendered entries, `catalogPinnedNames` selects deployment-critical entries first, and the durable `skill-catalog` source records `totalAvailable` whenever the projection is smaller than the current population. The digest covers both the rendered entries and total population so count changes replace the model-visible catalog through the existing session-log lifecycle.

The same plugin registers `skill_search`. It queries the complete cwd- and agent-scoped model-invocable population, ranks deterministic lexical matches, limits returned rows with `searchResultLimit`, and returns only names and bounded descriptions. It does not load bodies or disclose provider paths. The existing `skill` tool remains the only model-facing loader for an exact selected name.

Broad external tool surfaces are governed independently by the deployment-owned `tool-access-policy` plugin. It installs at `tools/pre-execute`, evaluates deny patterns before approval patterns, and returns the canonical deny or ask decision before the tool implementation runs. The policy is configuration, so a deployment may bind exact server-qualified MCP names without changing the shared tool runtime.

Princess OS projects reviewed local skills into one junction-only directory generated from an auditable manifest. Duplicate names resolve by fixed source priority. Portable, governed sources are active; connector- or platform-bound candidates remain recorded as held until their runtime dependency and authority are proven. The projection never copies skill bodies and refuses to delete non-junction members.

## Verification

Unit coverage proves bounded and pinned catalog output, complete search, deterministic ranking, invalid configuration rejection, and executor-level denial. Source-launched parity synchronization is idempotent. An isolated assembled Web profile proves plugin composition and browser rendering. Protocol canaries exercise Playwright MCP navigation, snapshot, and screenshot against the isolated Harness, and Office canaries create and read XLSX, PDF, PPTX, and DOCX through `ctx.tools.execute`.

## Alternatives considered

**Render every discovered skill in the durable catalog.** Rejected because prompt and cache cost grows with the entire ecosystem even though most turns use a small subset.

**Copy selected skill directories into the Harness profile.** Rejected because copies drift from their source and make provenance and update behavior ambiguous. Junctions preserve one source of content while the manifest records the selected projection.

**Hide dangerous MCP operations from the prompt only.** Rejected because Code Mode, programmatic callers, and later consumers can still address a registered tool directly. The decision belongs at the canonical pre-execution operation.

**Install every community plugin immediately.** Rejected because public discovery is not proof of compatibility, authority, credentials, or safe lifecycle behavior. Candidates remain searchable evidence until each complete capability seam is source-audited and target-tested.

## Consequences

Large skill populations remain discoverable without placing every summary in each request. Catalog currentness stays reconstructable from the session log, and exact skill bodies still load only on demand. Search is intentionally lexical, so deployments must provide clear names and descriptions rather than relying on semantic retrieval. Tool policy can safely remove a few operations from a useful MCP server, but pattern configuration becomes a reviewed deployment artifact. Community additions require finite admission work instead of becoming silently executable.
