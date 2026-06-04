# Handoff — MCP M3 T3.1: `spawn_board` (lifecycle write path)

- **Date:** 2026-06-03
- **Milestone:** M3 (Lifecycle tools) — **card 1 of 4**, the FIRST write tool. Touches BOTH repos.
- **App branch:** `feat/mcp-t3-1-spawn-board` → squash-merged into `feat/mcp-integration`.
- **Pkg branch:** `feat/spawn-board` off `feat/board-memory` (the M1 held tip, 0.3.2) → bumped **0.4.0**,
  **HELD/unpublished** (the 0.3.x/0.4.x chain ships on one user-gated `tag v*`).

## What shipped

An orchestrator-tier agent can now **create a board through the MCP server**. The full path:

```
agent → spawn_board(type)            [pkg tool, orchestrator-tier ONLY]
      → orchestrator.spawnBoard()    [app adapter: mints id, caps N]
      → mcp:command {addBoard,{id,type}}  [MAIN → renderer, frame-guarded]
      → useMcpCommands → canvasStore.addBoard(type, anchor, {id})  [board on canvas + shell starts]
      → tool returns the id to the agent
```

### Package (`Z:\canvas-ade-mcp`, 0.4.0 held)
- `src/server/tools/spawnBoard.ts` — `registerSpawnBoard(server, orchestrator)`. Zod input
  `{ type: enum(terminal|browser|planning), prompt?, cwd? }`; returns the id as text content.
- `src/server/factory.ts` — registered INSIDE the `ctx.tier === 'orchestrator'` branch (structural
  capability split, same mechanism as `orchestrator_ping`; never a per-handler check).
- `src/constants.ts` — `TOOL_SPAWN_BOARD`, `SPAWNABLE_BOARD_TYPES` (closed allowlist — the write path
  is stricter than the read surfaces, which keep `type` open).
- Tests: `test/contract/spawnBoard.contract.test.ts` (5). **47 contract + 27 live green.**

### App (`Z:\canvas-ade-mcp-int`)
- `src/main/mcpCommand.ts` — `McpCommand` union += `{ type:'addBoard'; board:{id,type} }`. Carries a
  MINIMAL spec, not a full PersistedBoard: MAIN mints the id but doesn't know geometry, so the renderer
  builds the board (free-slot placement, per-type defaults).
- `src/main/mcpOrchestrator.ts` — `BoardRegistry.sendCommand` (injected); `spawnBoard` un-gated: mints
  `randomUUID()`, issues the command, returns `{id}`; throws on a non-ok ack (no silent failure).
  `MCP_SPAWN_CAP = 4` 🔒 reject-before-side-effects (per-instance `spawnedIds` Set). `dispatchPrompt`
  /`gitDiff` stay phase-gated.
- `src/main/index.ts` — inject `sendCommand: (c) => sendMcpCommand(ipcMain, () => mainWindow, c)`.
- `src/renderer/src/store/useMcpCommands.ts` — extracted pure `applyMcpCommand(command)` (testable);
  `addBoard` case re-validates the type (defense in depth) → `canvasStore.addBoard`.
- `src/renderer/src/store/canvasStore.ts` — `addBoard(type, at, opts?: {id?})` honours an injected id
  (rides the M2 tracked undo rail — one step, no phantom).
- `src/main/e2e/probes/lifecycle.ts` (+ playlist) — `lifecycle-spawn`: issues a REAL `mcp:command`
  through MAIN, asserts the board lands on the canvas + in the mirror + its PTY starts; restores
  baseline (count→4).
- `src/main/mcpSmoke.ts` — `MCP_SPAWN_OK`: orchestrator spawns (board lands on canvas) + worker is
  DENIED `spawn_board` server-side. Self-activating `MCP_SPAWN_SKIP` on the published ^0.2.4 floor.

## Gate (all green)
- typecheck · lint (0 err) · format:check · **684 unit** · build.
- `CANVAS_SMOKE=mcp` → `MCP_LIST/TIER/BOARDS/STATUS/STATES/ATTENTION/OUTPUT/RESULT/MEMORY/COMMAND/**SPAWN**_OK` · `MCP_DONE` exit 0.
- `CANVAS_SMOKE=e2e` → `E2E_DONE ok:true` (lifecycle-spawn green; final seed=4). The
  `preview-edge-stale`/`duplicate-keeps-link` fixed-delay edge probes flaked on run 1, green on rerun
  (known env flake, memory `e2e-browser-trio-flake`) — not a regression (they run before this probe).

## Notes for the next card (T3.2 close_board)
- `spawnedIds` Set is the cap budget. **T3.2 close_board must remove the id from it** (else closed
  boards keep consuming cap). T3.4 adds idle-reaping + mirror reconciliation (the Set currently
  overcounts on a user-side manual close — the SAFE direction).
- The e2e cleanup currently removes via the store hook (`deleteBoard`); T3.2 replaces that with the real
  `close_board` command path (graceful PTY drain → kill tree → removeBoard command).
- `prompt`/`cwd` are accepted by `spawn_board`/`spawnBoard` but NOT yet applied — **T3.3 configure_board**
  threads them (shell/launchCommand/cwd) via the command channel, minding `PATCHABLE_KEYS`.
- Pkg dev loop = `pnpm mcp:link` symlink (app sees 0.4.0 live); app floor stays `^0.2.4` (CI-safe).
  Publish is user-gated (`tag v*`); the 0.3.x/0.4.x chain is held.
