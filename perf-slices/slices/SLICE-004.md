# SLICE-004 — Planning: per-drag static snap cache

- **Dimension:** algorithmic complexity / hot loops + caching gaps · **Severity:** med · **Effort:** M
- **Finding:** `plan-snap-statics-rebuild-per-frame`
- **Where:** `src/renderer/src/canvas/boards/planning/usePlanningPointer.ts:327-346`
  (`onWellPointerMove`, `d.mode==='move'`); `planning/snapping.ts:31-86` (`computeSnap`).

## Baseline (measured, reproduced)

- On **every pointermove frame** of a move-drag, snapping: (a) filters all N elements to build
  `statics` and calls `elementBBox` on each (O(N)); (b) `computeSnap` runs `bestAxis` **twice**, each
  looping all ~N−1 statics and calling `anchors(s)` inside (O(N) object allocs/axis).
- Micro-bench @ **N=300** (Node 22.17 / V8 = Electron-42 engine): **~144 µs/pointermove frame**
  (20,000 frames in 2,883 ms); **~908 short-lived allocations/frame** (~299 bbox + ~598 anchors + 3
  arrays). At a sustained ~120 pointermove/s: **~17.3 ms/s main-thread + ~108,000 allocs/s** of pure
  GC churn recomputing **unchanging** data. Snap is **on by default** (`PlanningBoard.tsx:105`).
- No spatial index exists (R3 deferred — grep for quadtree/rtree/spatial in `planning/` = 0). See
  `skipped-roadmap.md` for the R3 cross-ref.

## Target

The static set is **identical for the whole single-element drag**. Compute `statics` + their bboxes +
anchors **once at drag-start**, reuse the cache across frames; per frame only the moving element's
bbox/anchors recompute + the axis compare. **Target: <20 µs/frame and ~0 allocs/frame at N=300**
(from 144 µs / 908 allocs). (This is the cheap, in-scope subset of R3 — not a full spatial index;
defer R3 until a target element-count is set.)

## Validation

1. Re-run the same micro-bench harness (replay `onWellPointerMove` move branch at N=300) →
   per-frame <20 µs; allocs/frame near 0.
2. Manual: snap-line positions and snapped drop positions are pixel-identical to before at several
   element counts.
3. `@planning` e2e leg green.

## Invariant (must stay identical)

Snap results — which guides appear and the final snapped position — are identical. Cache invalidates
correctly if the static set changes mid-gesture (it shouldn't during a pure drag, but guard
add/remove/undo during drag).

## Files touched

- `src/renderer/src/canvas/boards/planning/usePlanningPointer.ts` (cache lifecycle on drag
  start/end).
- `src/renderer/src/canvas/boards/planning/snapping.ts` (accept precomputed statics).

## Collisions

- None with other slices (011 touches `WhiteboardSvg.tsx`/`pen.ts`, not these). Parallel-safe in
  Wave 1.
