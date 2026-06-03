# Handoff — MCP roadmap T1.2: `canvas://board-states` roll-up

- **Date:** 2026-06-03
- **Milestone/Task:** M1 (Observation) / **T1.2** (`docs/roadmap-mcp.md`)
- **Repos:**
  - `Z:\Canvas ADE` (app) — umbrella `feat/mcp-integration` (PR #32), commit `b26c0e4`
    (squash-merged from `feat/mcp-t1-2-states`).
  - `Z:\canvas-ade-mcp` (package) — branch `feat/board-states`, commit `c125dff`,
    `0.2.2 → 0.2.3`. **HELD / unpublished** (stacked on the T1.1 pkg branch `feat/board-status-resource`).
- **Status:** ✅ done, both gates green. Pkg roll-up fully live-verified; app probe self-activates on publish.

## What landed

A compact swarm-shape view: **`canvas://board-states`** → `{ statusBucket: boardId[] }` over the live
board list (both tiers — observation is safe). Lets an orchestrator glance at how many boards are
running / failed / static without paging the full `canvas://boards`. Counts = array lengths; full
per-board detail stays in `canvas://boards`.

```json
{ "running": ["t1","t2"], "failed": ["b1"], "static": ["p1"] }
```
Empty buckets are omitted; board order is preserved within a bucket.

### Package (`Z:\canvas-ade-mcp`)
- **NEW** `src/resources/boardStates.ts` — pure `groupBoardsByStatus(boards)` + the
  `registerBoardStatesResource` registration. Wired into `registerBoardResources`.
- `test/contract/boardStates.contract.test.ts` — pure helper test + in-memory resource read.
- `test/live/boardStates.live.test.ts` — read over real HTTP.
- `package.json` 0.2.3.

### App (`Z:\Canvas ADE`)
- **No app code change for the resource** — it groups the buckets the renderer already publishes (T1.1).
- `src/main/mcpSmoke.ts` — `readBoards()` + `readBoardStates()` smoke-client helpers and the
  **`MCP_STATES`** probe: asserts `canvas://board-states` stays consistent with `canvas://boards`
  (every board appears under its own bucket; no extras, no dupes).
  - **Self-activating:** `canvas://board-states` only exists in pkg ≥0.2.3. On the installed `0.2.0` the
    read 404s → **`MCP_STATES_SKIP pkg<0.2.3-unpublished`** (logged, *not* a failure, smoke stays exit 0).
    The real assertion turns on automatically once `0.2.3` is published + consumed.
  - Resource-not-found is matched specifically (`code -32602` / `/resource .*not found/i`) so a
    `Session not found` (-32001) transport failure can't masquerade as a skip.

## Test evidence
- **Pkg gate:** typecheck ✓ · lint ✓ · `prettier --check` ✓ · `pnpm test` **27 contract** ✓ ·
  `pnpm test:live` **18 live** ✓ · `pnpm build` ✓.
- **App gate:** typecheck ✓ · lint ✓ (only the pre-existing PlanningBoard `no-console` warning) ·
  `prettier --check` ✓ · `pnpm test` **610 unit** ✓ · `pnpm build` ✓.
- **App live MCP smoke:** `CANVAS_SMOKE=mcp pnpm start` →
  `MCP_LIST_OK / MCP_TIER_OK / MCP_BOARDS_OK / MCP_STATUS_OK / MCP_STATES_SKIP / MCP_COMMAND_OK /
  MCP_DONE`, **exit 0**.

## Manual (per cadence)
- **Automated equivalent done:** the pkg **live** test reads `canvas://board-states` over real HTTP
  (the Inspector `resources/read` path), asserting the grouped shape.
- **By hand on publish (Inspector):** `cd Z:\canvas-ade-mcp; pnpm exec @modelcontextprotocol/inspector`
  → read `canvas://board-states` with a few mixed-state boards on the canvas; eyeball the grouping.

## ⚠️ Publish gate (memory `mcp-publish-gating`)
Same as T1.1: the app consumes the **published** dep (`0.2.0`), so the running app does not yet host
`canvas://board-states`. The app probe is in place and skips cleanly until `0.2.3` (with held `0.2.1`
host-guard + `0.2.2` status) is published + consumed. App `package.json` `^0.2.0` caret covers `0.2.3`
— no dep edit on publish. **Three pkg versions now queued for one publish: 0.2.1 / 0.2.2 / 0.2.3.**

## Follow-ups / next
- **T1.3 — `canvas://attention`**: boards needing a human (`blocked`/`awaiting-review`/`failed`). The
  app must start *emitting* `blocked`/`awaiting-review` (T1.1 reserved them but only emits
  `running`/`idle`/`failed`/`static`) — this is the first card that adds real app-side derivation again,
  not just a pkg resource. `failed` already flows (browser load-failed).
- On publish: `MCP_STATES` + the T1.1 templated-resource probe both light up; re-run the app live smoke.
- **Do not merge to `main`** — finish MCP phases on the umbrella first (user's standing decision).
