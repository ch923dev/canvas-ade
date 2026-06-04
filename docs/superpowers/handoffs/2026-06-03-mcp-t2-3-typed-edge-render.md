# Handoff — MCP M2 T2.3: Typed edge render (the M2 gate)

- **Date:** 2026-06-03
- **Branch:** `feat/mcp-t2-3-typed-edge-render` (off `feat/mcp-integration`) → squash-merge when green.
- **Milestone:** M2 (Spatial connectors) — **T2.3 is the gate**. T2.1✅ + T2.2✅ already on the umbrella.
- **Status:** gate green (typecheck/lint/format/675 unit/build); local e2e (see e2e note).

## What shipped

The typed render that finalizes M2: orchestration connectors render distinct from preview edges,
reroute on move, and the preview edges are provably unbroken by the shared-geometry extraction.

### `src/renderer/src/canvas/edges/floatingPath.ts` (extracted)
Lifted the floating-edge geometry out of `PreviewEdge.tsx`: `box` / `borderPoint` / `edgePositions`
(pure) + `floatingPath(s, t)` (reads RF internal-node geometry → `{path, labelX, labelY}`, null when
unmeasured). `PreviewEdge.tsx` and `OrchestrationEdge.tsx` now BOTH import it — one source of truth for
the border-to-border bezier, so they can never drift. `PreviewEdge.test.ts` now imports `edgePositions`
from `floatingPath` (the 5 geometry tests are unchanged and green).

### `src/renderer/src/lib/orchestrationEdges.ts` (+ test)
Pure `orchestrationEdges(connectors, boards)` — mirror of `previewEdges`: one RF edge per
`orchestration` connector whose BOTH endpoint boards are present (dangling-skipped). Canvas's `edges`
memo now calls it and only decorates (selection, `onDelete`, marker) — the inline filter/map from T2.2
is gone.

### `OrchestrationEdge.tsx` styling (DESIGN §7.3)
Calm neutral stroke (`--border-strong`, ~2px; selected → `--text-1`/2.5px) — distinct from the accent
(`--accent`, 1.5px) preview edge. No glow/gradient. Midpoint ✕ via `EdgeLabelRenderer`, shown when
selected.

### e2e gate probe — `connector-edge-render`
Links browser→terminal (preview edge) AND draws a terminal→planning orchestration cable, then asserts:
(1) the orchestration stroke ≠ the preview stroke (distinct), (2) the orchestration path re-paths when
its target board moves (reroute), (3) the preview edge still renders (no regression from the
floatingPath extraction). Restores baseline. The existing `preview-edge-stale` /
`duplicate-keeps-link` / `preview-connect-gesture` probes remain the preview regression guard.

## M2 GATE — met
- Connectors **persist + round-trip** (T2.1: schema v5 + migration + dual-source fold).
- **Draw + delete** works (T2.2: title-bar handle → store-geometry resolve → addConnector; ✕ / Delete).
- Orchestration edges render **visually distinct** from preview edges and **reroute on move**, with
  **no preview regression** (T2.3).
- Sets up M4 dispatch (T4.6) to flow along the orchestration cable.

## Verify
```
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
pnpm build; CANVAS_SMOKE=e2e pnpm start
#   connector-roundtrip / connector-draw-delete / connector-edge-render ok
#   preview-edge-stale / duplicate-keeps-link / preview-connect-gesture still ok (no regression)
```

## Notes for next (M3 lifecycle)
- `McpCommand` union (`src/main/mcpCommand.ts`) + `useMcpCommands` applier extend with board CRUD
  (`addBoard`/`removeBoard`/`selectBoard`) — the connector model + the orchestration edge are now the
  spatial substrate dispatch (M4) renders along.
- The connectors array is orchestration-only in memory; preview connectors stay derived from
  `previewSourceId` (Decision B). Don't route ephemeral gesture state into `connectors[]`.
