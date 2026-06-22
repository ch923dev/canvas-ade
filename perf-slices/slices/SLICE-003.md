# SLICE-003 — CommandBoard: derived-fingerprint subscription

- **Dimension:** client render / per-frame re-render fan-out · **Severity:** med · **Effort:** S
- **Finding:** `cb-cmdboard-boards-subscription-perframe`
- **Where:** `src/renderer/src/canvas/boards/CommandBoard.tsx:70-81` (`useCanvasStore((s)=>s.boards)`).

## Baseline (measured, reproduced)

- CommandBoard subscribes to the **whole `boards` array**. `updateBoard` (`canvasStore.ts:767-781`)
  returns a **new array reference** on every drag-position change; `Canvas.onNodesChange`
  (`Canvas.tsx:433`) calls `updateBoard` per RF move frame (~60/s, unthrottled). React Flow has
  `onlyRenderVisibleElements` **unset** (0 grep matches), so the Command board (a singleton) renders
  even off-screen.
- Result: while **any** board is dragged above LOD, the entire CommandBoard subtree reconciles
  **~60×/s** — 5 kanban columns + every `TaskCard` + `PoolStrip` + `SubmitWell`, none memoized — for
  a board that did not move.
- The actual derivation (`deriveWorkerPool` over 60 boards) is **trivial** (0.27 µs/call, micro-bench
  2M iters) — the cost is the **unmemoized React subtree reconciliation fan-out**, not the math.
- This is the exact class fixed elsewhere (GROUP-07 fingerprint selector; CANVAS-01/PLAN-01 per-frame
  re-render kills) but **never applied to CommandBoard** (it was excluded from the PA audit).

## Target

Subscribe to a **derived fingerprint** (e.g. a stable string/number of board type-counts + the ids
the board actually consumes), not the raw `boards` array, using a custom equality fn so position-only
changes don't fire. Memoize the heavy subtree. **Target: 0 CommandBoard re-renders when an unrelated
board is dragged.**

## Validation

1. React DevTools Profiler (or a render counter): drag an unrelated board for 3 s → CommandBoard
   render count stays 0 (was ~180 over 3 s).
2. Add/remove a board / change a board's type → CommandBoard updates exactly once.

## Invariant (must stay identical)

Worker-pool strip + kanban column counts + submit well update correctly on any add/remove/type
change; no stale counts.

## Files touched

- `src/renderer/src/canvas/boards/CommandBoard.tsx` (subscription + memo); optionally a small
  selector helper in `store/`.

## Collisions

- None (isolated file). Parallel-safe in Wave 1.
