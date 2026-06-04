# Handoff — MCP M3 T3.4: concurrency cap + idle-reaping (the M3 GATE)

- **Date:** 2026-06-03
- **Milestone:** M3 (Lifecycle tools) — **card 4 of 4, the gate**. **App-only** (no new pkg tool).
- **App branch:** `feat/mcp-t3-4-cap-and-reap` → squash-merged into `feat/mcp-integration`.
- **Pkg:** unchanged (held at 0.4.2 from T3.3).

## 🚦 M3 gate — met

An agent creates/destroys real boards **within a hard cap**, and **nothing auto-spawns unbounded**:
a per-session cap (4) reconciled against the live canvas, plus a TTL idle-reaper that closes dormant
MCP-spawned boards.

## What shipped (`src/main/mcpOrchestrator.ts` + `mcp.ts` + `mcpSmoke.ts`)

- **Configurable adapter** — `buildOrchestrator(registry, opts?)` takes `{ now?, cap?, idleTtlMs?,
  spawnGraceMs? }` (a clock seam + tuning; all default). Returns `LifecycleOrchestrator =
  Orchestrator & { reapIdle() }`.
- **Tracker** — `spawnedIds: Set` became `Map<id, { spawnedAt, idleSince }>`. spawn adds, close deletes.
- **Cap reconciliation** — `spawnBoard` reconciles first: a tracked id absent from `registry.listBoards()`
  for longer than `spawnGraceMs` (5s — covers the renderer's ~150ms publish debounce, so a just-spawned
  board isn't pruned) is dropped from the budget. So a board the **user** manually closed stops consuming
  a slot. Then the cap check rejects over-limit spawns (no side effects — reject before mint/send).
- **Idle-reaper** — `reapIdle()` sweeps the tracked boards: `idle` (or gone) arms `idleSince`; a return to
  `running` clears it; an idle span ≥ `idleTtlMs` reaps via the graceful `closeBoard` (drain → removeBoard).
  Returns the reaped ids.
- **Timer** — `mcp.ts` runs `reapIdle()` on an interval (`unref`'d so it never blocks shutdown; cleared in
  `close()`). TTL + interval are env-overridable (`CANVAS_MCP_IDLE_TTL_MS`, `CANVAS_MCP_REAP_INTERVAL_MS`)
  so the live smoke can drive a fast, deterministic reap. `RunningMcp.reapIdle()` exposes a manual sweep.
- **Smoke** — `MCP_CAP_OK` (spawn to the cap → next spawn rejected with a "cap" error → close frees slots)
  and `MCP_REAP_OK` (spawn → force idle via `setTerminalDown` → two `reapIdle` sweeps across a short TTL
  → board gone). `MCP_REAP_SKIP` when no short TTL is injected, so the normal gate stays fast.

## Why no board-e2e probe for T3.4
The cap + reaper live in the orchestrator **adapter**, reachable only via the MCP tool surface (HTTP),
not the renderer command path the `CANVAS_SMOKE=e2e` harness drives. They are therefore validated in the
**MCP tier smoke** (`MCP_CAP_OK` / `MCP_REAP_OK`) — the correct surface. The board-e2e
`lifecycle-spawn-close` probe already covers the renderer round-trip (spawn → configure → close).

## Gate (all green)
- typecheck · lint (0 err) · format:check · **696 unit** · build.
- `CANVAS_SMOKE=mcp` (normal) → `MCP_SPAWN/CONFIGURE/CLOSE/CAP_OK` · `MCP_REAP_SKIP` · `MCP_DONE` exit 0.
- `CANVAS_SMOKE=mcp CANVAS_MCP_IDLE_TTL_MS=800` → **`MCP_CAP_OK` + `MCP_REAP_OK`** · `MCP_DONE` exit 0.
- `CANVAS_SMOKE=e2e` → `lifecycle-spawn-close` green + all probes except the documented
  `browser`/`browser-gesture`/`focus-detach` capturePage env flake (`e2e-browser-trio-flake`, disjoint
  from T3.4).

## M3 COMPLETE
T3.1 spawn · T3.2 close · T3.3 configure · T3.4 cap+reap — all on `feat/mcp-integration`. An agent can
spawn / close / configure real boards through the MCP server, a worker tier is denied every write tool
(server-side capability split), and the cap + idle-reap hold. Pkg held chain: 0.4.0 spawn / 0.4.1 close /
0.4.2 configure — **unpublished**, dev via `pnpm mcp:link`; publish is user-gated (`tag v*`); app floor
stays `^0.2.4` (CI-safe). Umbrella NOT merged to app main (user's call). **Next: M4 — Dispatch (🔒).**
