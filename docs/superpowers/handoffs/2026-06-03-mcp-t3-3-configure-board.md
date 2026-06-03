# Handoff — MCP M3 T3.3: `configure_board` (durable per-type config)

- **Date:** 2026-06-03
- **Milestone:** M3 (Lifecycle tools) — **card 3 of 4**. Touches BOTH repos.
- **App branch:** `feat/mcp-t3-3-configure-board` → squash-merged into `feat/mcp-integration`.
- **Pkg branch:** `feat/configure-board` off `feat/close-board` → bumped **0.4.2**, HELD/unpublished.

## What shipped

An orchestrator-tier agent can **change a board's durable config** (shell / launchCommand / cwd):

```
agent → configure_board(id, shell?|launchCommand?|cwd?)   [pkg tool, orchestrator ONLY]
      → orchestrator.configureBoard(id, config)            [app adapter]
      → mcp:command {configureBoard, id, patch}             [MAIN → renderer, frame-guarded]
      → useMcpCommands → canvasStore.updateBoard(id, patch) [PATCHABLE_KEYS-filtered]
```

### Package (`Z:\canvas-ade-mcp`, 0.4.2 held)
- `src/orchestrator/Orchestrator.ts` — new `BoardConfig { shell?; launchCommand?; cwd? }` +
  `configureBoard(boardId, config): Promise<void>`. `src/orchestrator/mock.ts` — no-op.
- `src/server/tools/configureBoard.ts` — `registerConfigureBoard`; zod `id: z.string().min(1)` +
  optional shell/launchCommand/cwd; **rejects an empty id AND a call with no config fields** (isError
  before the orchestrator is called); forwards only the present fields.
- `src/server/factory.ts` + `src/constants.ts` — `TOOL_CONFIGURE_BOARD` under the orchestrator tier.
- Tests: `test/contract/configureBoard.contract.test.ts` (5). **56 contract + 27 live green.**

### App (`Z:\canvas-ade-mcp-int`)
- `src/main/mcpCommand.ts` — `McpCommand` union += `{ type:'configureBoard'; id; patch }`.
- `src/main/mcpOrchestrator.ts` — `configureBoard(id, config)` issues the command; throws on a non-ok
  ack (no silent failure).
- `src/renderer/src/store/useMcpCommands.ts` — `configureBoard` case → `canvasStore.updateBoard(id,
  patch)`. **updateBoard filters to `PATCHABLE_KEYS` per board type**, so an off-type/identity/ephemeral
  key (e.g. a forged `id`, a `url` on a terminal) is DROPPED — proven by a unit test that a `{id:'hacked'}`
  patch neither forges a new id nor changes identity.
- `src/main/e2e/probes/lifecycle.ts` — the `lifecycle-spawn-close` probe now also CONFIGURES between
  spawn and close (real `configureBoard` command → asserts the board's `launchCommand` changed).
- `src/main/mcpSmoke.ts` — `MCP_CONFIGURE_OK`: orchestrator configures (change lands, asserted via the
  renderer since the boards resource is metadata-only) + worker DENIED `configure_board`. Self-activating
  `MCP_CONFIGURE_SKIP` on pkg<0.4.2.

## Gate (all green)
- typecheck · lint (0 err) · format:check · **693 unit** · build.
- `CANVAS_SMOKE=mcp` → … `MCP_SPAWN_OK` · **`MCP_CONFIGURE_OK`** · `MCP_CLOSE_OK` · `MCP_DONE` exit 0.
- `CANVAS_SMOKE=e2e` → **`lifecycle-spawn-close` green** (now spawn→configure→close) + all other probes;
  the `browser`/`browser-gesture`/`focus-detach` trio is the documented `e2e-browser-trio-flake`
  (capturePage env flake on this contended host), disjoint from T3.3 — the real gate (`check`) + live MCP
  smoke are green.

## Notes for the next card (T3.4 — concurrency cap + idle-reaping, the M3 GATE)
- The cap budget (`spawnedIds` Set in `mcpOrchestrator.ts`) is spawn-add / close-delete. T3.4:
  **(a)** reconcile the Set vs the live mirror (`registry.listBoards`) so a user-side manual close stops
  overcounting; **(b)** reap idle MCP-spawned boards after a TTL (idle = PTY not running — derive from
  the status bucket / `listSessions`); **(c)** keep rejecting over-cap spawns with the clear error
  (already in place). e2e: spawn past cap → rejection; an idle spawned board reaps. 🚦 M3 gate.
- Pkg dev loop = `pnpm mcp:link` symlink (app sees 0.4.2 live); app floor stays `^0.2.4` (CI-safe).
  Publish user-gated (`tag v*`); held chain now 0.4.0 spawn / 0.4.1 close / 0.4.2 configure.
