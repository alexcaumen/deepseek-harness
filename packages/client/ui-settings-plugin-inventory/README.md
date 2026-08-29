# @deepseek-ai/dsh-client-ui-settings-plugin-inventory

English | [中文](README.zh.md)

Read-only **Plugin list** tab for Web Settings. The browser plugin registers one localized `settings.plugins.tab` contribution with id `all`; the Plugins section owns the navigation entry and tab chrome. It performs no Remote read during plugin activation. Selecting the tab for the first time mounts it and lazily calls `ctx.remote.pluginInventory.list()` through [`api-remotes`](../../api/remotes/README.md).

The tab renders capability, readiness, attention, and system-internal summary counts above a searchable catalog. It deterministically groups descriptive module or entry identifiers into human-facing categories and maps Loader state to Ready, Available, Needs sign-in, Loading, Failed, or Disabled. The default Capabilities segment omits low-level runtime rows; an explicit System internals segment keeps those entries available without flooding the primary view. Compact disclosure cards use readable titles and public statuses, while their expanded technical details retain the exact module specifier, Loader-tree entry id, effective configuration, and Cordis phase. Loading, empty, no-match, and generic failure states stay local to the mounted component, and a failed read can be retried without exposing transport details. The registration uses `ctx.slots.inject()`, so it follows late tab declaration, redeclaration, locale changes, and teardown without importing the section owner.

## Model Experience

None, as this package only visualizes a Host-owned deployment snapshot in browser Settings and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One snapshot per Settings mount or retry** — the tab does not subscribe to Loader changes or automatically refetch after reconnect; switching tabs preserves the current snapshot, while reopening Settings obtains a new one.
- **Identifier-based categories** — unfamiliar extensions conservatively appear under System internals until their module or entry identifier matches a supported capability family.
- **Read-only capability view** — local search does not add provenance, current-browser activation diagnosis, grouping by source, or plugin mutation controls.
