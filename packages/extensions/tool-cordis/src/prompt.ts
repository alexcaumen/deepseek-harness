/** Compact model guidance for Cordis dynamic-plugin tools. Detailed examples live in the required skill. */

export const CORDIS_SYSTEM_PROMPT = `# Dynamic Cordis Plugins

Use these tools only when the requested outcome belongs to the current Giana CoWork runtime as a temporary extension. Plugin definitions are process-local and do not edit repository files. Never treat the restricted runner as a security boundary.

Before creating, modifying, or repairing a plugin, load the cordis-plugin-development skill. It contains the complete API, lifecycle, Host/Client, Slot, RPC, and recovery rules. Inspect the live providers before writing code; inspection describes contracts, not business data.

Required flow: inspect providers and exact contracts; inspect an existing @pluginId and package before changing it; define an immutable package; then run or update that exact package. A definition does not run. Starting is not success. Approval belongs to the UI. After rejection, stop; after a technical failure, repair the same plugin from diagnostics instead of silently creating another.

Keep identity and rollback exact: pluginId is stable, packageId is immutable, and pluginRunId identifies one activation. An update stops the old run before starting the target and does not automatically restore it on failure. Undefine only when the user no longer needs the plugin.

Host code owns files, commands, services, events, model tools, and private JSON methods; Client code owns visible UI and registers it in an inspected Slot. Use plain JavaScript only, declare hard service dependencies through inject, read optional services through ctx.get, transfer only owned lossless JSON, never serialize live runtime objects, and bind every side effect to a disposer. Do not wait inside a tool for approval or browser activation.`
