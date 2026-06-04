# Handoff — MCP roadmap T1.1: status buckets in the board mirror

- **Date:** 2026-06-03
- **Milestone/Task:** M1 (Observation) / **T1.1** (`docs/roadmap-mcp.md`)
- **Repos:**
  - `Z:\Canvas ADE` (app) — umbrella `feat/mcp-integration` (PR #32), commit `0f01ac1`
    (squash-merged from sub-branch `feat/mcp-t1-1-status` `5436642`).
  - `Z:\canvas-ade-mcp` (package) — branch `feat/board-status-resource`, commit `ab9130a`,
    version `0.2.1 → 0.2.2`. **HELD / unpublished** (stacked on the host-header guard `c6e1b33`).
- **Status:** ✅ done, both gates green. App side fully live-verified; pkg resource live-verified by
  its own contract+live tests (app-side live probe of the new resource is publish-gated — see below).

## What landed

Agents (and, in T1.6, the human) get a **coarse status bucket per board** instead of bare presence.

**Buckets:** `idle | running | awaiting-review | blocked | failed | static`. T1.1 emits a coarse
subset — terminals `running`/`idle`, browsers `running`(connecting)/`failed`(load-failed)/`idle`,
planning + forward types `static`. The richer terminal states (`awaiting-review`, `blocked`) are
**reserved in the enum but not yet emitted** — they start in T1.3 (attention) and M8 (permission
detection), when MAIN gains the signals to detect them.

**One source of truth.** The bucket is derived **in the renderer** (the only place holding the live
`terminalRuntimeStore.running` + `previewStore` load state) and pushed to MAIN over the existing
`mcp:boards` mirror. So the agent's `canvas://boards` view and the future on-canvas pill (T1.6) read
the *same* value — they can't disagree.

### App (`Z:\Canvas ADE`)
- **NEW** `src/renderer/src/store/boardStatus.ts` — pure, unit-tested:
  - `boardStatusBucket(type, { terminalRunning?, preview? })` → bucket.
  - `buildBoardSnapshot(boards, { running, preview })` → `{id,type,title,status}[]` (the mirror payload).
- `src/renderer/src/store/useMcpPublish.ts` — now subscribes to `terminalRuntimeStore.running` +
  `previewStore.byId` (so a liveness change republishes even when `boards` is unchanged) and publishes
  via `buildBoardSnapshot`. Still debounced 150 ms, metadata-only.
- `src/preload/index.ts` — `mcp.publishBoards` payload carries the `status` field.
- `src/main/boardRegistry.ts` — `BoardMirror.status?`; `sanitizeSnapshot` keeps `status` **only** when
  it is a known bucket (`STATUS_BUCKETS` set) — an unknown/garbage value over IPC is dropped.
- `src/main/mcpOrchestrator.ts` — `deriveStatus` prefers the renderer bucket; **falls back** to a
  PTY/presence-derived bucket (terminal `running`↔`idle` from the PTY map, browser `idle`, else
  `static`) when the mirror carries none → graceful for an older renderer / pre-republish race.
- `src/main/mcpSmoke.ts` — **`MCP_STATUS_OK`** probe: seeds a terminal, `fitView` (→ real PTY spawns →
  natural `running`), polls `canvas://boards` until that board reads `running`, forces it down
  (`setTerminalDown`), polls until `idle`. Asserts the bucket **propagated through the full pipeline**,
  not just that the resource returned a value.
- Tests updated: `boardStatus.test.ts` (new, 5), `boardRegistry.test.ts` (+1 status case),
  `mcpOrchestrator.test.ts` (rewritten to the bucket contract).

### Package (`Z:\canvas-ade-mcp`)
- `src/resources/boards.ts` — registers **`canvas://board/{id}/status`** (templated, both tiers —
  observation is safe). Returns `{ "id", "status" }`.
- `test/helpers/{inMemory,httpServer}.ts` — accept a custom `Orchestrator` override.
- `test/contract/boardStatusResource.contract.test.ts` + `test/live/boardStatusResource.live.test.ts`
  — assert template-var routing returns the right bucket (in-memory + real HTTP).
- `package.json` 0.2.2.

## Test evidence
- **App gate:** `pnpm typecheck` ✓ · `pnpm lint` ✓ (only the pre-existing PlanningBoard `no-console`
  warning, not ours) · `pnpm format:check` ✓ · `pnpm test` **610 unit** ✓ · `pnpm build` ✓.
- **App live MCP smoke:** `CANVAS_SMOKE=mcp pnpm start` →
  `MCP_LIST_OK / MCP_TIER_OK / MCP_BOARDS_OK / MCP_STATUS_OK / MCP_COMMAND_OK / MCP_DONE`, **exit 0**.
- **Pkg gate:** `pnpm typecheck` ✓ · `pnpm lint` ✓ · `prettier --check` ✓ · `pnpm test` **24 contract**
  ✓ · `pnpm test:live` **17 live** ✓ · `pnpm build` ✓.

## Manual (per cadence)
- **Automated equivalent done:** the pkg **live** test reads `canvas://board/{id}/status` over real
  HTTP + bearer + template routing (the Inspector's `resources/read` path), and the app smoke proves
  buckets move on a real running canvas via `canvas://boards`.
- **Still to run by hand when convenient (Inspector):** `cd Z:\canvas-ade-mcp; pnpm exec
  @modelcontextprotocol/inspector` → connect to the live loopback (port+token from the dev log) →
  read `canvas://board/<id>/status` for a running vs idle board.
- **Real agent:** generate a `.mcp.json` into a Terminal board's CLI, connect, read the status
  resource. (Both deferred to the publish step below.)

## ⚠️ Publish gate (matches the T0.2 precedent)
The app consumes the **published** `@ch923dev/canvas-ade-mcp` (currently `0.2.0`), so the running app's
MCP server does **not** yet host the new `canvas://board/{id}/status` resource. T1.1's app side does
not need it — buckets are already observable via `canvas://boards` (which `0.2.0` serializes), which is
exactly what `MCP_STATUS_OK` asserts. The **app-side live probe of the templated resource**
(`readBoardStatus` via `canvas://board/{id}/status`) waits until `0.2.2` is **published + consumed**,
together with the held host-header guard `0.2.1`. `app package.json` is `^0.2.0`, so caret already
covers `0.2.2` — no app dep edit needed on publish.

## Follow-ups / next
- **T1.2 — `canvas://board-states`** (bucketed roll-up). The app already feeds buckets; the pkg adds a
  grouped resource. Next card in `docs/roadmap-mcp.md` § M1.
- When the user publishes `0.2.1`+`0.2.2`: add the templated-resource app probe to `mcpSmoke.ts` and
  re-run the app live smoke.
- Reserved buckets `awaiting-review`/`blocked` get their emit sites in T1.3 + M8.
- **Do not merge to `main`** — finish the MCP phases on the umbrella first (user's standing decision).
