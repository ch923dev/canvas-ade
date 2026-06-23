# SLICE-011 — Planning: incremental pen-draft tessellation

- **Dimension:** scalability cliffs / algorithmic complexity (O(N²)) · **Severity:** low · **Effort:** M
- **Finding:** `plan-pen-draftpath-quadratic`
- **Where:** `src/renderer/src/canvas/boards/planning/WhiteboardSvg.tsx:116-119` (`draftPath =
  useMemo(strokeToPath, [draftStroke])`); fed per frame by `usePlanningPointer.ts:358-360`
  (`setDraftStroke(d.points)`).

## Baseline (measured, reproduced)

- `draftPath` is keyed on `draftStroke`, which changes every pen-move frame, so `strokeToPath`
  (`getStroke` = O(points)) recomputes over the **full growing point list** each frame → **O(N²)
  over one stroke**.
- Micro-bench with the real vendored `perfect-freehand` (esbuild-bundled, Node 22.17/V8): single-frame
  cost grows 50-pt 21 µs → 200-pt 153 µs → 400-pt ~170 µs → 800-pt ~480 µs. **Cumulative over one
  continuous stroke: ~135–153 ms for an 800-pt scribble** (the ~4× cost per 2× N confirms the O(N²)
  shape). Committed strokes are WeakMap-cached; only the **in-progress draft** is recomputed from
  scratch. Element-count-independent (per-stroke).

## Target

Bound per-frame draft cost: re-tessellate only the recent tail / append incrementally during the
draw, and run the full `getStroke` once on commit. (Or draw a cheap raw polyline during the gesture,
swap to the smoothed outline on pointer-up.) **Target: ~constant per-frame draft cost regardless of
stroke length; committed stroke shape identical.**

## Validation

1. Re-run the draft micro-bench with the incremental path → per-frame cost flat (not growing with N)
   over an 800-pt stroke.
2. Draw a long scribble — no visible lag accumulation near the end of the stroke.
3. Committed stroke shape is identical to today's `getStroke` output (pixel/path compare).

## Invariant (must stay identical)

The **committed** stroke (post pointer-up) is byte-identical to the current `getStroke` output; draft
preview is visually acceptable (may differ slightly mid-gesture if a polyline interim is used).

## Files touched

- `src/renderer/src/canvas/boards/planning/WhiteboardSvg.tsx` (`draftPath`).
- Possibly `src/renderer/src/lib/pen.ts` (incremental helper).

## Collisions

- None with SLICE-004 (that touches `usePlanningPointer.ts`/`snapping.ts`). Parallel-safe in Wave 1.
