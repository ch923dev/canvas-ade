# Next-session kickoff — MCP **M3: Lifecycle tools** (the first *write* path)

Paste the block below as the next session's opening prompt. It continues the Canvas ADE × MCP
roadmap. M0/M1 (Observation) + M2 (Spatial connectors) are COMPLETE on `feat/mcp-integration`.

---

You are continuing the Canvas ADE × MCP integration roadmap. M0 + M1 (Observation) + M2 (Spatial
connectors) are COMPLETE on `feat/mcp-integration`. This session: build Milestone **M3 — Lifecycle
tools** by completing **T3.1 → T3.2 → T3.3 → T3.4 SEQUENTIALLY** (one card fully green +
squash-merged + handed off before the next). Do NOT parallelize.

**⚠️ M3 IS DIFFERENT FROM M2: it TOUCHES THE PACKAGE.** M2 was renderer/state-only. M3 is the first
**write** path and is **package Phase 3** — each card adds a server tool in the sibling package
`Z:\canvas-ade-mcp` AND the app-side wiring (orchestrator adapter + the MAIN→renderer command channel).
This re-opens pkg work + publish coordination + the live MCP smoke. Treat every write tool as
security-sensitive.

## REPOS / RUNTIME

- **WORK HERE (app):** `Z:\canvas-ade-mcp-int` — branch `feat/mcp-integration`. Cut task sub-branches
  off it; squash back. (Worktree node_modules is its OWN, de-junctioned — normal pnpm; do NOT re-junction.)
- **WORK HERE (pkg):** `Z:\canvas-ade-mcp` — the MCP server package `@ch923dev/canvas-ade-mcp`. M3 adds
  lifecycle tools here. The dev loop is the `pnpm mcp:link` symlink (app `node_modules/@ch923dev/canvas-ade-mcp`
  → the sibling), so the app sees pkg edits live WITHOUT publishing. **Publish stays user-gated** (tag `v*`
  via CI). The held chain is 0.3.0/0.3.1/0.3.2 (unpublished); M3 bumps to 0.4.x, also HELD until the user
  green-lights a publish. NEVER commit a `link:` lockfile entry; package.json/lockfile stay on the published
  `^0.2.4` floor (CI-safe) — the symlink overrides it in dev.
- **APP main `Z:\Canvas ADE`** — integration only; NEVER work there (shared-dir collision hit this project
  twice). Do NOT merge `feat/mcp-integration` to app main (user's call).

## READ FIRST (in order)

1. `Z:\Canvas ADE\CLAUDE.md` — durable contract. Especially **Process model & security** (contextIsolation/
   sandbox/no-nodeIntegration; node-pty ONLY in MAIN; treat launchCommand as trusted-user-only; Browser
   content must NEVER reach the PTY write channel) and **Terminal bridge** (spawn the shell, write
   launchCommand as the first PTY line; kill the tree on close).
2. `docs/roadmap-mcp.md` § **M3 — Lifecycle tools** — the 4 task cards (T3.1–T3.4) + the M3 gate, AND
   § "Manual-test harness" + § "Per-task card template".
3. The M2 handoffs for the exact cadence pattern: `docs/superpowers/handoffs/2026-06-03-mcp-t2-1-connector-model.md`
   … `-t2-3-typed-edge-render.md`.
4. The command-channel contract (M3 builds directly on it):
   - `src/main/mcpCommand.ts` — `McpCommand` union ships only `{type:'ping'}` today; the file's own comment
     prescribes the M3 extension: `| {type:'addBoard'; board: PersistedBoard} | {type:'removeBoard'; id} |
     {type:'selectBoard'; id}`. `sendMcpCommand(bus, getWin, command, timeoutMs)` already does the
     request/reply + 2s timeout + frame-guarded ack.
   - `src/renderer/src/store/useMcpCommands.ts` — the renderer applier; today handles only `ping`. M3 adds
     the board-CRUD cases against `canvasStore` (`addBoard`/`removeBoard`/`selectBoard`).
   - `src/main/mcpOrchestrator.ts` — `spawnBoard`/`dispatchPrompt`/`gitDiff` currently THROW phase-gated
     ("not available until Phase 3/4/6"). M3 makes `spawnBoard` (+ close/configure) issue an `mcp:command`
     and return the server-issued id; `dispatchPrompt`/`gitDiff` stay gated.
   - `src/main/mcp.ts` + `src/main/index.ts` — how the server is mounted + `getWin` is threaded.
5. The package side: `Z:\canvas-ade-mcp\docs\roadmap.md` § Phase 3, `src/orchestrator/Orchestrator.ts`
   (the interface the app implements), `src/server/factory.ts` (per-session ServerFactory — tools are
   registered per TIER, never by prompt/annotation), and `src/auth/scopes.ts` (orchestrator vs worker tier).
6. Memories (recalled automatically): `mcp-spec-state-2026-06` · `mcp-publish-gating` · `canvas-ade-mcp` ·
   `undo-lastrecorded-phantom` · `e2e-sendinputevent-vs-dispatchevent` · `e2e-rf-measurement-race` ·
   `e2e-browser-trio-flake`.

## STATE OF PLAY (as of 2026-06-03, end of M2)

- **App umbrella `feat/mcp-integration`** (pushed, NOT on app main): M1 done (T1.4 `efb6726` · T1.5 `ef32ae5`
  · T1.6 `7c00b3d` · T1.7 `48cda99`) + **M2 done** (T2.1 `b90be53` schema 4→5 + connector model + undo rail
  widened; T2.2 `8e00d25` draw/delete gesture; T2.3 `eee33b1` typed render gate). App gate green: **675 unit**,
  typecheck/lint/format/build; board e2e `E2E_DONE ok:true` zero-false.
- **Schema is now v5** (M2 claimed it). A further breaking shape change = v6 + a migration.
- **pkg `Z:\canvas-ade-mcp` = v0.3.2**, Host-header guard live (R2 fixed), observation resources (Phase 2)
  shipped. **Phase 3 (lifecycle) UNBUILT.** Held chain 0.3.0/0.3.1/0.3.2 unpublished, user-gated.
- The command channel ships **`ping` only** (T0.3 scaffold); `mcpOrchestrator.spawnBoard` THROWS. These are
  the exact seams M3 fills.
- Live MCP smoke `CANVAS_SMOKE=mcp` boots the app + connects orchestrator/worker clients + asserts
  tier-enforcement (MCP_LIST/TIER/BOARDS/STATUS/STATES/ATTENTION/OUTPUT/RESULT/MEMORY/COMMAND_OK exit 0).
  M3 adds spawn/close/configure assertions here.

## THE 4 CARDS, IN ORDER (full cards in `docs/roadmap-mcp.md` § M3)

- **T3.1 — `spawn_board(type, prompt?, cwd?)`** (`feat/mcp-t3-1-spawn-board`)
  pkg: new tool, validates `type`, caps N (orchestrator-tier only). app: `mcpOrchestrator.spawnBoard` stops
  throwing → issues `mcp:command {type:'addBoard', …}` → `useMcpCommands` adds a board to `canvasStore` at a
  free slot (reuse the store's `freeSlot`/`addBoard`), returns the server-issued id. 🔒 hard concurrency cap.
  **🧪 e2e:** orchestrator calls `spawn_board('terminal')` → a new board appears in the mirror + on the canvas
  + a shell starts. **Manual:** real agent spawns a board, watch it appear.

- **T3.2 — `close_board(id)` (graceful drain)** (`feat/mcp-t3-2-close-board`)
  pkg tool; app adapter DRAINS the PTY (not an immediate kill — see CLAUDE.md "kill the tree" but graceful
  first) then removes the board via the command channel. (Dirty-worktree prompt is deferred to M6.)
  **🧪 e2e:** spawn then close → board gone from mirror + canvas, PTY reaped.

- **T3.3 — `configure_board(id, …)`** (`feat/mcp-t3-3-configure-board`)
  pkg tool; app adapter applies shell/launchCommand/cwd changes via the command channel (mind `PATCHABLE_KEYS`
  in canvasStore — only durable per-type keys; never an ephemeral key). **🧪 e2e:** configure → board config changed.

- **T3.4 — 🔒 Concurrency cap + idle-reaping** (`feat/mcp-t3-4-cap-and-reap`) — **the M3 gate**
  app: enforce a max live MCP-spawned board count; reap idle MCP-spawned boards after a TTL; reject
  over-limit spawns with a clear error. **🧪 e2e:** spawn past the cap → rejection; an idle spawned board reaps.

**🚦 M3 gate:** an agent creates/destroys real boards within the cap; nothing auto-spawns unbounded.

## TESTING (the whole point — this is a write path)

- **TDD first** for every pure/decidable unit: the type-validation + cap logic + free-slot placement +
  command-envelope mapping are pure → write the failing test first, watch it fail, then implement.
- **Two e2e surfaces, BOTH must stay green per card:**
  1. **App board e2e** `CANVAS_SMOKE=e2e` (renderer side): add ONE probe per card to a new/extended
     `src/main/e2e/probes/lifecycle.ts` + the load-bearing playlist in `src/main/e2e/index.ts`. Probes MUST
     restore baseline (seed count returns to 4). Use the harness hooks + **poll, don't fixed-sleep** (a board
     spawn + shell start + mirror publish is async — memory `e2e-rf-measurement-race`). Drive the command
     path the SAME way the orchestrator does (issue `mcp:command` through MAIN), not by calling the store
     directly, so the probe exercises the real round-trip.
  2. **Live MCP smoke** `CANVAS_SMOKE=mcp` (package + tier enforcement): extend `src/main/mcpSmoke.ts` to
     assert the orchestrator tier can `spawn_board`/`close_board`/`configure_board` AND a **worker tier is
     DENIED** these write tools (the capability split is the load-bearing safety guarantee — verify it
     server-side, never by prompt). Self-skip cleanly when the running pkg version predates the tool (like the
     M1 `*_SKIP` pattern) so it stays green pre-publish.
- **Gate before each handoff (the REAL gate = the `check` job):**
  `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build`. Then run BOTH smokes locally:
  `pnpm build; CANVAS_SMOKE=e2e pnpm start` (grep `E2E_DONE {"ok":true` + any `"ok":false`; the
  browser-trio + fixed-delay edge probes are known env flakes — rerun for clean, memory `e2e-browser-trio-flake`)
  AND `CANVAS_SMOKE=mcp pnpm start` (expect `MCP_*_OK … MCP_DONE` exit 0).
  pkg: `cd Z:\canvas-ade-mcp; pnpm test; pnpm test:live`.

## CADENCE — MANDATORY per card

- One sub-branch off `feat/mcp-integration` → squash-merge back when green → THEN next card.
- pkg tool work goes on a pkg `feat/*` branch in `Z:\canvas-ade-mcp` (HELD, unpublished, like the 0.3.x chain);
  the app consumes it live via the `mcp:link` symlink during dev. Do NOT publish or bump the app floor unless
  the user green-lights it.
- Write a handoff `docs/superpowers/handoffs/2026-06-03-mcp-t3-N-*.md` after each card.
- Update YOUR row on `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` BEFORE editing. Declare zones:
  `src/main/mcpCommand.ts` · `src/main/mcpOrchestrator.ts` · `src/renderer/src/store/useMcpCommands.ts` ·
  `src/main/mcpSmoke.ts` · NEW `src/main/e2e/probes/lifecycle.ts` + playlist · pkg `src/server/tools/*`.
  ⚠️ CROSS-ZONE: `src/main/index.ts` + `src/preload/index.ts` are also touched by `feat/context` (additive);
  `canvasStore.ts` `addBoard`/`removeBoard` is the M2 undo rail (route writes through the existing tracked
  actions; do NOT introduce a phantom undo step — memory `undo-lastrecorded-phantom`).

## SECURITY (never weaken — M3 is the first write path)

- Commands are control-plane only, frame-guarded (the `isForeignSender`/main-frame pattern already in
  `mcpCommand.ts` + `boardRegistry.ts`). The server tool is the ONLY authority — tier is re-derived from the
  verified bearer (`ctxFromAuth`), never trusted from the prompt. A **worker tier must NEVER reach a lifecycle
  write tool** (assert this in the mcp smoke).
- The hard **concurrency cap + idle-reap** is the runaway-swarm guard — it is part of the gate, not optional.
- node-pty stays in MAIN; the renderer never touches Node/native. A spawned terminal still spawns the SHELL
  (then writes `launchCommand` as the first line), and close still kills the tree (`taskkill /T /F` on Windows).
- Do NOT weaken contextIsolation/sandbox/nodeIntegration.

## DO NOT

- Do NOT publish the pkg or bump the app floor without the user's go-ahead (publish = tag `v*`, user-gated).
- Do NOT re-junction the worktree node_modules. Do NOT commit a `link:` lockfile entry.
- Do NOT merge `feat/mcp-integration` to app main. Do NOT work in `Z:\Canvas ADE` main dir.
- Do NOT let a worker-tier client reach a write tool. Do NOT auto-spawn unbounded (cap is mandatory).
- Do NOT unblock `dispatchPrompt` (M4) or `gitDiff` (M6) — they stay phase-gated this session.

## START BY

`cd Z:\canvas-ade-mcp-int`; confirm branch `feat/mcp-integration` + the `pnpm mcp:link` symlink is active
(`node_modules/@ch923dev/canvas-ade-mcp` → the sibling, resolves 0.3.2). Read `docs/roadmap-mcp.md` § M3 +
`mcpCommand.ts`/`useMcpCommands.ts`/`mcpOrchestrator.ts`. Confirm the command channel ships only `ping` today
and `spawnBoard` throws. Declare T3.1 zones on ACTIVE-WORK.md. Then build T3.1 **test-first**: pkg
`spawn_board` tool + the app adapter + the `addBoard` command case + the e2e lifecycle probe + the mcp-smoke
tier assertion. Finish + squash-merge + handoff T3.1 before starting T3.2. **M3 is done when an agent can
spawn / close / configure real boards through the MCP server, a worker tier is denied those tools, and the
concurrency cap + idle-reap hold — with both `CANVAS_SMOKE=e2e` and `CANVAS_SMOKE=mcp` green.**
