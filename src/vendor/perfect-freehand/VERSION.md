# Vendored: perfect-freehand

- **Package:** `perfect-freehand` (npm) by Steve Ruiz — <https://github.com/steveruizok/perfect-freehand>
- **License:** MIT (see `./LICENSE`)
- **npm version:** `1.2.2`
- **Source git tag:** `v1.2.3` (the monorepo tag that publishes npm `1.2.2`)
- **Source path:** `packages/perfect-freehand/src/*.ts`
- **Vendored on:** 2026-05-29
- **By:** Phase 2.3 (Planning board) — see `docs/handoffs/phase-2.md`.

## Why vendored, not an npm dependency

ADR 0001 mandates a **custom whiteboard** with `perfect-freehand` **vendored**, not added to
`package.json`. Keeping the source in-tree avoids a runtime dependency, lets Vite bundle it directly
into the renderer, and pins the exact algorithm we tested against. **Do NOT add it to
`package.json`.**

## What was vendored

The published TypeScript source, verbatim, with only this header note added per file. No code
changes. Files:

- `index.ts` — public surface (`getStroke` default + named re-exports).
- `getStroke.ts` — the one-call entry: points → outline polygon.
- `getStrokePoints.ts` — input points → smoothed/streamlined `StrokePoint[]`.
- `getStrokeOutlinePoints.ts` — `StrokePoint[]` → outline polygon points.
- `getStrokeRadius.ts` · `simulatePressure.ts` · `constants.ts` · `vec.ts` · `types.ts` — internals.

## How we use it

The Planning board's freehand pen records pointer positions in **board-local** coordinates (screen
deltas ÷ camera zoom — see `lib/pen.ts` + its tests), stores them as a flat `points: number[]` on a
`StrokeElement`, then renders each stroke via `getStroke(...)` → an SVG `<path>` fill. We pass
`simulatePressure: false` (mouse/trackpad has no real pressure) so the stroke width is driven by the
size option, not velocity.

## Updating

Re-fetch the same files from a newer git tag, re-apply only the per-file header note, bump the
versions above. The public API (`getStroke`, `StrokeOptions`, `StrokePoint`) has been stable across
the 1.x line.
