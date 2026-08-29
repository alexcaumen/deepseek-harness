# @deepseek-ai/dsh-client-ui-settings-plugin-inventory

English | [中文](README.zh.md)

Read-only **Plugin list** tab for Web Settings. The browser plugin registers one localized `settings.plugins.tab` contribution with id `all`; the Plugins section owns the navigation entry and tab chrome. It performs no Remote read during plugin activation. Selecting the tab for the first time mounts it and lazily calls `ctx.remote.pluginInventory.list()` through [`api-remotes`](../../api/remotes/README.md).

The tab keeps discovery and live runtime evidence separate. The human-facing feature list and the lazily fetched skill, connector, and marketplace catalogs are discoverable claims only: source status strings and historical inventory labels never promote an entry to installed, enabled, connected, callable, behaviorally proven, or held. Catalog counts are labelled as catalog counts for the same reason. The System internals segment projects only facts carried by the current typed `pluginInventory.list()` snapshot: the exact module specifier, Loader-tree entry id, effective enablement, and literal Cordis phase. A mounted fiber proves mounting, not authentication or end-to-end behavior. Loading, empty, no-match, and generic failure states stay local to the mounted component, and a failed read can be retried without exposing transport details. The registration uses `ctx.slots.inject()`, so it follows late tab declaration, redeclaration, locale changes, and teardown without importing the section owner.

## Model Experience

None, as this package only visualizes a Host-owned deployment snapshot in browser Settings and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One snapshot per Settings mount or retry** — the tab does not subscribe to Loader changes or automatically refetch after reconnect; switching tabs preserves the current snapshot, while reopening Settings obtains a new one.
- **No live capability receipts** — the existing Client Remote exposes Loader enablement and fiber phase only. It does not expose connector authentication, action callability, behavioral-canary, or governed-hold receipts, so this package does not claim those states.
- **Identifier-based categories** — unfamiliar extensions conservatively appear under System internals until their module or entry identifier matches a supported capability family.
- **Read-only capability view** — local search does not add a catalog-to-runtime identity binding, grouping by source, or plugin mutation controls.
