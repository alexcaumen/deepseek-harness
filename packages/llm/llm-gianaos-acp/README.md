# GianaOS ACP LLM adapter

This private adapter exposes canonical GianaOS principals in the Giana Code
model selector. It does not copy an identity, profile, memory, session
database, approval state, provider credential, or router into Giana Code.

For each exact live Giana Code agent/session, the adapter:

1. starts the canonical GianaOS ACP client route;
2. issues a short-lived MCP capability for that exact Giana Code agent;
3. gives the canonical ACP session the complete tools visible to that agent;
4. projects ACP text, reasoning, and sanitized tool activity into the local
   transcript; and
5. revokes the capability when the local agent or adapter is disposed.

Only a non-secret remote ACP session pointer is stored in the local append-only
session log. GianaOS remains the authority for identity, Soul, memory parity,
MOA, approvals, provider credentials, and canonical persistence.
