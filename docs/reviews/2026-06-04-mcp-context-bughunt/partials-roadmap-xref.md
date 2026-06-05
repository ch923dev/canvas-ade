# Partial-coverage roadmap cross-references

These confirmed findings sit in code that `docs/roadmap-mcp.md` MCP-hardening T-items also touch, but the planned work would not fully resolve the specific defect. They remain in the active fix queue. When fixing, also drop a `🔗 Related bug-hunt finding` note under the listed T-item on the `main` checkout (the target worktree was removed, so in-place annotation is deferred to the fixer).

| Card | T-item(s) | Note |
|------|-----------|------|
| BUG-002 — MCP `configureBoard` sets `launchCommand` with no  | docs/roadmap-mcp.md + T3.3, T4.2 | roadmap-mcp.md T3.3 covers configure_board and T4.2 covers human-confirm modal infrastructure. T4.3 establishes the huma |
| BUG-008 — MCP handoffPrompt uses a stale board snapshot / ne | docs/roadmap-mcp.md + T4.3; docs/roadmap-mcp.md + T4.3, T5.2; docs/roadmap-mcp.md + T4.3, T5.3 | roadmap-mcp.md T4.3 describes building handoffPrompt (send → await idle → return result) with idle detection, but T4.3 i |
| BUG-009 — closeBoard / reapIdle error handling: cap-slot lea | docs/roadmap-mcp.md + T3.2; docs/roadmap-mcp.md + T3.4 | roadmap-mcp.md T3.2 covers building close_board (graceful drain), touching the closeBoard area. However, T3.2 is about i |
| BUG-010 — MCP confirm request has no timeout → tool call han | docs/roadmap-mcp.md + T4.2 | roadmap-mcp.md T4.2 covers building the human-confirm modal infrastructure. However, T4.2 is about constructing the moda |
| BUG-020 — dispatchGuard outstanding-nonce set grows unbounde | docs/roadmap-mcp.md + T4.3 | roadmap-mcp.md T4.3 explicitly mentions 'single-use nonce + monotonic sequence' and the e2e test verifies 'replayed nonc |
| BUG-021 — relayPrompt TOCTOU: connector not re-checked + sou | docs/roadmap-mcp.md + M10 T10.4; docs/roadmap-mcp.md + T4.6, M10 T10.4 | roadmap-mcp.md T4.6 covers agent-to-agent dispatch over the connector cable and M10.4 addresses safety hardening includi |
| BUG-022 — Predictable PRNG confirm reply-channel name | docs/roadmap-mcp.md + T4.2, T10.4 | roadmap-mcp.md T4.2 covers building a human-confirm modal and T10.4 covers safety hardening including provenance-tagging |
| BUG-023 — mcp.ts env TTL accepts zero/negative → idle-reap s | docs/roadmap-mcp.md + T3.4 | roadmap-mcp.md T3.4 covers idle-reaping with a TTL and hard cap, but T3.4 is about implementing reaping functionality, n |
| BUG-024 — auditLog sequence reset/interleave on concurrent a | docs/roadmap-mcp.md + T4.1 | roadmap-mcp.md T4.1 covers building the audit log infrastructure (append-only, seq + timestamp). However, T4.1 is descri |
| BUG-025 — Audit log wired AFTER MCP server starts → early di | docs/roadmap-mcp.md + T4.1 | roadmap-mcp.md T4.1 covers the audit log infrastructure and the gate requires audit entries for dispatched actions. Howe |