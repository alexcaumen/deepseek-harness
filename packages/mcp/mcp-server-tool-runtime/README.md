# `@deepseek-ai/dsh-mcp-server-tool-runtime`

Authenticated, loopback-only Streamable HTTP MCP access to the active process's
`ToolRuntime`.

Load `ToolRuntimeMcpServer` as a Cordis plugin after `tools`, `agents`, and
`sessions`. A trusted in-process consumer calls
`ctx.mcpToolRuntime.issue(agent)` and gives the returned `endpoint` and bearer
`token` to the external MCP client. The capability is pinned to that exact live
agent and session object. It is revoked when either object leaves its registry,
when `revoke()` is called, or when the plugin unloads.

The server binds only `127.0.0.1` or `::1`. It has no unauthenticated mode and
does not accept an agent or session identifier over MCP. Tool listing comes
from `ctx.tools.schemas(agent)` and calls pass through `ctx.tools.execute`, so
the existing scoped visibility, guards, approval flow, and cancellation rules
remain authoritative.
