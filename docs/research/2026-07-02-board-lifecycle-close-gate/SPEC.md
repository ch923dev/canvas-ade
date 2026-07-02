# Board lifecycle: kill the idle reaper, human-gate `close_board`

**Date:** 2026-07-02 · **Branch:** `fix/mcp-reaper-close-gate` · **Status:** approved (user, 2026-07-02)

## Problem

The MCP idle reaper (`mcpLifecycle.reapIdle`, swept every 60s from `mcp.ts`) silently deletes any
MCP-spawned board that has been "idle" for 5 minutes (`MCP_IDLE_TTL_MS`). Because a Browser board is
`'idle'` the moment its page loads and a Planning/Kanban board is permanently `'static'` (made
reap-eligible by the BUG-003 fix), **every agent-spawned browser/planning board is guaranteed to be
deleted ~5–7 minutes after spawn**, and a terminal whose agent sits at a prompt ≥6–8 min is deleted
too. The reap writes no audit entry, shows no toast, and swallows errors — the user reported boards
"randomly disappearing" with no way to find out why.

## Decision (user rule, 2026-07-02)

> A board is deleted ONLY when the user deletes it, or when the user tells the agent to remove a
> named board — and that agent deletion must pass the human-confirm gate. Everything else is
> static: never auto-deleted.

## Changes

### 1. Remove the idle reaper wholesale (no dormant machinery left)

- `mcpLifecycle.ts` — delete `reapIdle`, the `sweeping` latch, `NON_IDLE_STATUSES`, the
  `idleSince` field (tracked map becomes `Map<string, { spawnedAt: number }>`), and the
  `idleTtlMs` / `idleActivityMs` / `listBoards` deps. **Keep** `tracked` + `reconcile()` +
  `spawnGraceMs` — they are the spawn-cap budget (runaway-swarm guard), orthogonal to reaping.
- `mcp.ts` — delete the reap `setInterval`, `REAP_INTERVAL_MS`, `IDLE_TTL_MS`, the
  `CANVAS_MCP_IDLE_TTL_MS` / `CANVAS_MCP_REAP_INTERVAL_MS` env plumbing, and `RunningMcp.reapIdle`.
  (`positiveMsEnv` stays only if another caller remains; else delete + its tests.)
- `mcpOrchestrator.ts` — drop `opts.idleTtlMs` / `opts.idleActivityMs` + the lifecycle wiring +
  the `reapIdle` pass-through. `handoffTimeoutMs` default currently aliases `MCP_IDLE_TTL_MS`;
  introduce `MCP_HANDOFF_TIMEOUT_MS = 5 * 60 * 1000` so handoff behavior is byte-identical.
- `mcpRegistry.ts` — delete `MCP_IDLE_TTL_MS`, `MCP_IDLE_ACTIVITY_MS`,
  `OrchestratorOpts.idleTtlMs/idleActivityMs`. **`BoardRegistry.boardActivityStaleMs` STAYS**
  (discovered during build: `awaitSettled` — the C2e output-silence settle — consumes it too),
  so the `index.ts` wiring and `pty.ts`'s `getTerminalActivityStaleMs(+Core)` + tests are
  untouched; only the doc comments lose their reaper references.
- `appModel.ts` — remove `rules.idleTtlMs` / `rules.idleActivityMs` from the self-model (and the
  matching assembly in the orchestrator). Update any `APP_TOOLS`/rules prose that promises
  idle-reaping. `version` stays `1` (pre-release; consumers are agents reading JSON).
- Tests — remove/rewrite the reap suites in `mcpLifecycle.test.ts`, `mcpOrchestrator.test.ts`,
  `mcp.test.ts`, `appModel.test.ts`, `pty.test.ts`.

### 2. Human-confirm gate on `close_board`

`orchestrator.closeBoard` (the only caller left after №1 is the agent-facing `close_board` tool)
gains the same MAIN-owned, fail-closed gate as `configure_board` / the content writes:

1. Resolve the board title from the live mirror (UUID fallback) so the human can identify it.
2. `registry.confirm({ title, body })` — deny ⇒ audit `type:'close_board', status:'denied'` + throw.
3. Approve ⇒ existing teardown (drain PTY → `removeBoard` command → token revoke).
4. Audit every exit: `'closed'` on success, `'failed'` on a rejected ack (matches the
   configure_board forensic symmetry; today spawn/close write NO audit line at all).

Confirm modal (existing ConfirmModal component, same pattern as configure_board — no new UI):

```
┌──────────────────────────────────────────────┐
│  Close board "auth-flow plan"?               │
│                                              │
│  The agent asked to close this planning      │
│  board. Its content will be removed from     │
│  the canvas (Ctrl+Z restores it this         │
│  session).                                   │
│                                              │
│                       [ Deny ]  [ Approve ]  │
└──────────────────────────────────────────────┘
```

### 3. Renderer visibility on agent-initiated removal

`applyMcpCommand` case `'removeBoard'`: when the board actually existed, raise a toast (existing
toastStore) after removal:

```
┌──────────────────────────────────────────────┐
│ Agent closed board "auth-flow plan" · Undo   │
└──────────────────────────────────────────────┘
```

Toast `action: { label: 'Undo', run: () => undo() }` — the removal is already one tracked undo
step. User-initiated deletes (dock/keyboard) do NOT toast — they never route through
`applyMcpCommand`.

## Explicitly unchanged

- User deletes on the canvas (delete key / board menu) — untouched.
- The spawn cap (`MCP_SPAWN_CAP = 4`) + `reconcile()` — slots now free only via explicit
  close/user delete; the cap error message already says "close one first".
- Handoff await-idle backstop timing (5 min — renamed constant only).
- `@expanse-ade/mcp` package — no change needed; the gate is host-side (the tool call now blocks
  on the confirm modal exactly like `configure_board`).

## Risks / notes

- An agent may accumulate boards to the cap if the user denies closes — intended: user controls
  deletion.
- `close_board` tool calls now require a human at the keyboard (same as every other write tool) —
  consistent with the ADR 0003 "every cross-board write pays the gate" invariant; `appModel`'s
  `everyWriteGated: true` finally becomes true for closes too.
