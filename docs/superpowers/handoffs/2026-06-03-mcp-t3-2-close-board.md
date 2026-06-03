# Handoff — MCP M3 T3.2: `close_board` (graceful PTY drain + teardown)

- **Date:** 2026-06-03
- **Milestone:** M3 (Lifecycle tools) — **card 2 of 4**. Touches BOTH repos.
- **App branch:** `feat/mcp-t3-2-close-board` → squash-merged into `feat/mcp-integration`.
- **Pkg branch:** `feat/close-board` off `feat/spawn-board` → bumped **0.4.1**, HELD/unpublished.

## What shipped

An orchestrator-tier agent can **close a board through the MCP server**, gracefully:

```
agent → close_board(id)              [pkg tool, orchestrator-tier ONLY, id non-empty]
      → orchestrator.closeBoard(id)  [app adapter]
      → drainPty(id)                 [MAIN: Ctrl-C + `exit`, grace window, then tree-kill]
      → mcp:command {removeBoard,id}  [MAIN → renderer, frame-guarded]
      → useMcpCommands → canvasStore.removeBoard(id)  [board leaves the canvas]
      → frees the spawn cap slot (spawnedIds.delete)
```

### Package (`Z:\canvas-ade-mcp`, 0.4.1 held)
- `src/orchestrator/Orchestrator.ts` — interface += `closeBoard(boardId): Promise<void>` (idempotent;
  the host drains the PTY before removal). `src/orchestrator/mock.ts` — no-op `closeBoard`.
- `src/server/tools/closeBoard.ts` — `registerCloseBoard`; zod `{ id: z.string().min(1) }` (empty id
  rejected by the schema before the orchestrator is called).
- `src/server/factory.ts` — registered in the orchestrator-tier branch; `src/constants.ts` —
  `TOOL_CLOSE_BOARD`.
- Tests: `test/contract/closeBoard.contract.test.ts` (4). **51 contract + 27 live green.**

### App (`Z:\canvas-ade-mcp-int`)
- `src/main/mcpCommand.ts` — `McpCommand` union += `{ type:'removeBoard'; id }`.
- `src/main/pty.ts` — `drainPty(id, graceMs=600)`: Ctrl-C + `exit` to the shell, poll for a natural
  exit within the grace window, else hard `cleanup` (taskkill /T /F). No-op on a non-terminal/absent id;
  never throws (best-effort). Draining FIRST means the board-unmount `pty:kill` that follows the removal
  no-ops, and the session isn't parked-for-undo.
- `src/main/mcpOrchestrator.ts` — `BoardRegistry.drainPty` (injected); `closeBoard` = drain → removeBoard
  command → `spawnedIds.delete` (frees the cap; proven by a unit test: spawn to cap, close one, spawn
  succeeds). Throws on a non-ok ack (no silent failure).
- `src/main/index.ts` — inject `drainPty: (id) => drainPty(id)`.
- `src/renderer/src/store/useMcpCommands.ts` — `removeBoard` case (idempotent → `canvasStore.removeBoard`).
- `src/main/e2e/probes/lifecycle.ts` — `lifecycle-spawn-close`: spawn via command (canvas+mirror+PTY up),
  then the REAL close path (`drainPty` + `removeBoard` command) → gone from canvas + mirror + PTY reaped;
  baseline 4.
- `src/main/mcpSmoke.ts` — `MCP_CLOSE_OK`: orchestrator closes via the real tool (board leaves the
  canvas) + worker DENIED `close_board`. Self-activating `MCP_CLOSE_SKIP` on pkg<0.4.1.

## Gate (all green)
- typecheck · lint (0 err) · format:check · **689 unit** · build.
- `CANVAS_SMOKE=mcp` → … `MCP_SPAWN_OK` · **`MCP_CLOSE_OK`** · `MCP_DONE` exit 0.
- `CANVAS_SMOKE=e2e` → **`lifecycle-spawn-close` green every run** (+ all 50+ other probes incl.
  preview-edges/connectors/seed=4). ⚠️ The `browser`/`browser-gesture`/`focus-detach` trio flaked
  `ok:false` ("browser not live" / capturePage `empty=true`) across 4 consecutive runs on this
  load-contended host — the documented `e2e-browser-trio-flake` (live-WebContentsView capturePage env
  flake, proven-by-neg-control, NOT a regression). T3.2 touches no browser/preview/WebContentsView
  code; the real gate (`check`) + the live MCP smoke (capturePage-independent) are fully green.

## Notes for the next card (T3.3 configure_board)
- `spawn_board`/`spawnBoard` already ACCEPT `prompt`/`cwd` but don't apply them — T3.3 threads
  shell/launchCommand/cwd via a new `configureBoard` command, minding `PATCHABLE_KEYS` (only durable
  per-type keys — never an ephemeral key). `configureBoard` command name is reserved in the union doc.
- The cap budget (`spawnedIds`) is now spawn-add / close-delete. **T3.4** adds idle-reaping + a TTL +
  mirror reconciliation (the Set still overcounts on a user-side manual close — the SAFE direction).
- Pkg dev loop = `pnpm mcp:link` symlink (app sees 0.4.1 live); app floor stays `^0.2.4` (CI-safe).
  Publish user-gated (`tag v*`); the 0.3.x/0.4.x chain is held (now 0.4.0 spawn + 0.4.1 close).
