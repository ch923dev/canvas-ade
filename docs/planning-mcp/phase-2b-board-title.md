# Planning-MCP — Phase 2b: agent board title

> When an agentic CLI spawns a board via MCP `spawn_board`, it can now give it a meaningful **name**
> instead of the generic per-type default ("Terminal" / "Planning" / "Browser"). The board title is
> already a first-class, user-editable field (D2-A inline rename) — 2b just lets the agent populate it
> at spawn time, so a hands-free plan reads as e.g. "Auth refactor plan" rather than "Planning".

## Change (the plumb: agent → canvas)

Crosses the package boundary, so it pairs with an `@expanse-ade/mcp` bump (like 2a → 0.16.0). **No
`schemaVersion` bump** — the title lands on the existing `BoardCommon.title`; nothing new is persisted.

1. **`@expanse-ade/mcp` 0.16.0 → 0.17.0 (published, OIDC tag `v0.17.0`).**
   - `spawn_board` tool schema gains an optional `title: z.string().max(SPAWN_BOARD_MAX_TITLE)`; it is
     forwarded to `orchestrator.spawnBoard({ …, title })`.
   - `Orchestrator.spawnBoard` input + `MockOrchestrator` carry `title?`; new `SPAWN_BOARD_MAX_TITLE = 80`
     constant (mirrors the host clamp; same 80 as the group-name cap — both are short chrome labels).
   - Contract tests: title pass-through + a wire-level over-long rejection. App pin → `^0.17.0`.

2. **App MAIN `mcpLifecycle.spawnBoard`** accepts `title?` and **sanitizes it at the trust boundary**
   (`sanitizeBoardTitle`): collapse whitespace runs → strip C0/DEL/C1 control chars → trim → clamp 80.
   It is stricter than the inline group-name clamp on one point — it also strips control chars —
   because the title lands **verbatim in later human-confirm modal bodies** (handoff / assign /
   configure render `"${board.title}"`), so an agent must not be able to slip control sequences into a
   confirm the user is asked to authorize. Included in the `addBoard` command only when non-empty
   (empty/whitespace-only ⇒ omitted ⇒ the renderer uses the per-type default).

3. **Shared `mcpTypes`**: the `addBoard` command's `board` spec gains `title?: string`.

4. **Renderer `useMcpCommands` + store `addBoard`**: read `title`, re-clamp defensively (defense in
   depth, like the `type` re-validation; non-string/empty ⇒ ignored), and pass it through to
   `createBoard` (which already supports `opts.title`).

## Security

The board title is agent-influenceable text that renders as inert DOM text **and** is echoed verbatim
in dispatch human-confirm bodies. Mitigations: whitespace collapse (a multi-line title can't push the
real confirm content off-screen), control-char strip (no escape sequences in a confirm), an 80-char
clamp, and a renderer-side defense-in-depth re-clamp. The title never reaches a PTY and never executes.
Content-less, so — like `spawn_group` — it is **cap-checked, not human-gated**; the write-time confirm
stays on content writes (`add_planning_elements` / dispatch).

## Tests

- **Package** `spawnBoard.contract.test.ts`: title passes through to the adapter; an over-long title is
  rejected at the wire (no spawn).
- **MAIN** `mcpLifecycle.test.ts`: a clean title is forwarded; whitespace collapses + trims; C0/DEL/C1
  are stripped; an over-long title clamps to 80; empty/whitespace-only and absent titles omit the key.
- **Renderer** `useMcpCommands.test.ts`: `addBoard` applies an agent title; empty/whitespace falls back
  to the per-type default; over-long clamps; a non-string forged title is ignored.
- **e2e** `mcp.e2e.ts`: a real orchestrator-tier loopback client calls `spawn_board` with a title and
  the rendered board carries it end-to-end (against the published 0.17.0 server).

## Out of scope

- Renaming an EXISTING board via MCP (a `configure_board`-style title patch) — not requested.
- This is the last planned umbrella phase; next is the umbrella → `origin/main` merge (full matrix).
