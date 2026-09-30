# Codex continuity model

Each session stores one provider `threadId`, the workspace path, selected model, ordered account pool, logical turns, event records, approvals, and the currently active account. The runtime is account-scoped, but the session is not.

On a normal account switch, the previous runtime is stopped, the next account token is loaded, and the same provider thread is resumed. The UI reloads the persisted turns and events, so the conversation does not depend on an in-memory cache.

Limit handling is deliberately conservative:

1. A usage-limit response is classified before any retry.
2. If no side effect event was observed, the same logical turn may retry on the next account in the pool.
3. If a command, file change, MCP call, or dynamic tool started, the turn is marked interrupted and the session pauses. The user must decide whether to continue.
4. Unauthorized responses refresh the token once before account switching.

This prevents duplicate commands while allowing normal text-only turns to continue across accounts A, B, and C.
