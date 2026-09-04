# `@deepseek-ai/dsh-mcp-server-tool-runtime`

English | [中文](README.zh.md)

Authenticated, loopback-only Streamable HTTP MCP access to the active process's `ToolRuntime`.

Load `ToolRuntimeMcpServer` as a Cordis plugin after `tools`, `agents`, and `sessions`. A trusted in-process consumer calls `ctx.mcpToolRuntime.issue(agent)` and gives the returned `endpoint` and bearer `token` to the external MCP client. The capability is pinned to that exact live agent and session object. It is revoked when either object leaves its registry, when `revoke()` is called, or when the plugin unloads.

The server binds only `127.0.0.1` or `::1`. It has no unauthenticated mode and does not accept an agent or session identifier over MCP. Each listing and call reads `ctx.tools.wireSchemas(agent).schemas` for the exact bound agent. Code mode advertises only `run_code`; native mode advertises native tools; both mode advertises both. Calls pass through `ctx.tools.execute`, so scoped visibility, guards, approval, and cancellation remain authoritative.

The `run_code` description includes the current scope's canonical generated SDK from `ctx.tools.codeSdk(agent)`, including argument and output types. External clients do not need the local system prompt to discover program bindings. Inside a program, use only the exact properties declared in that SDK, without adding the MCP client's server prefixes. Listing failure exposes no fallback catalog or backend error details. Listings and calls re-read current visibility rather than retaining a discovery-time allowlist.

Typed image result blocks are resolved only through the exact agent scope's active `attachments` service. The bridge reads verified attachment bytes with the MCP call's cancellation signal and emits MCP image content containing canonical base64 data plus the verified MIME type; it never sends an attachment storage path or path-bearing URI. Image projection is all-or-nothing and uses the tighter of deployment attachment limits and fixed transport caps of 20 images and 20 MiB of aggregate raw image bytes. A missing store, refused metadata, mismatched stored object, read failure, or cancellation returns the generic bridge failure without partial bytes or backend details.
