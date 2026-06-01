# NEW-CAM-2: `zoomFor(g)` internally calls `boundsFor(g)`, doubling per-frame geometry work in `flushBatch` and `reconcile`

**Severity:** Low
**Category:** Camera sync / rAF loop performance
**Status:** CONFIRMED
**Files touched:** `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx`, `src/renderer/src/lib/cameraBounds.ts`
**Assigned:** _

## Summary

`zoomFor(g)` is a `useCallback` that calls `boundsFor(g)` internally to honour the Bug-#20 invariant (derive the zoom factor from the same rounded bounds width fed to `setBounds`). Wherever `boundsFor(g)` and `zoomFor(g)` are called in the same code path — `flushBatch` and `reconcile` both do this — `boundsFor(g)` is evaluated twice: once explicitly for `bounds`, and once again inside `zoomFor`. Each evaluation calls `getViewport()` and runs the full `deviceStageRect → toWorldRect → worldRectToScreen → roundRect` pipeline. With `MAX_LIVE=4` live boards this doubles the geometry computation per rAF frame during camera motion, and once per store mutation in `reconcile`.

## Where

`zoomFor` definition, `BrowserPreviewLayer.tsx` lines 214–223:

```ts
const zoomFor = useCallback(
  (g: BoardGeom): number => {
    // Bug #20: derive the factor from the SAME rounded bounds width fed to
    // setBounds (boundsFor) — NOT the un-rounded stage width …
    return fitZoomFactorForBounds(boundsFor(g).width, preset(g.viewport).w)
  },
  [boundsFor, preset]
)
```

`flushBatch`, lines 463–464 (calls `boundsFor` and `zoomFor` separately):

```ts
const bounds = fv ?? boundsFor(g)                                          // call #1
const zoomFactor = fv ? fitZoomFactorForBounds(fv.width, ...) : zoomFor(g) // call #2 (calls boundsFor internally)
```

`reconcile`, lines 745–749 (same pattern):

```ts
const bounds = boundsFor(g)     // call #1
const zoomFactor = zoomFor(g)   // call #2 (calls boundsFor internally)
```

`boundsFor` definition, lines 205–211:
```ts
const boundsFor = useCallback(
  (g: BoardGeom): Rect => {
    const stage = toWorldRect(deviceStageRect(g.w, g.h, g.viewport), g.x, g.y)
    return roundRect(worldRectToScreen(stage, getViewport(), paneOffset.current))
  },
  [getViewport]
)
```

## How it triggers

Every frame during camera movement, `flushBatch` iterates all attached boards and calls both `boundsFor(g)` and `zoomFor(g)`. For each board, `deviceStageRect`, `toWorldRect`, `worldRectToScreen`, and `roundRect` are each executed twice. With 4 live boards and 60 Hz this is 480 extra function calls per second of camera motion. The work is not visually observable but is measurable in a profiler.

`reconcile` has the same pattern: called on every store mutation (board drag, select, viewport change), it also double-computes bounds + zoom for each attached board.

## Verification evidence

`zoomFor` calls `boundsFor(g)` (line 220):
```ts
return fitZoomFactorForBounds(boundsFor(g).width, preset(g.viewport).w)
```

`flushBatch` calls both (lines 463–464) in the non-full-view branch:
```ts
const bounds = fv ?? boundsFor(g)
const zoomFactor = fv ? fitZoomFactorForBounds(fv.width, preset(g.viewport).w) : zoomFor(g)
```

`reconcile` same pattern (lines 745–748):
```ts
const bounds = boundsFor(g)
const zoomFactor = zoomFor(g)
if (r.lastSent && rectsEqual(r.lastSent, bounds) && r.lastZoom === zoomFactor) continue
```

## Suggested fix direction

Compute `boundsFor(g)` once and pass the result into `zoomFor`, or restructure `zoomFor` to accept a pre-computed `Rect`. A small helper that returns `{ bounds, zoomFactor }` together would eliminate the duplication cleanly:

```ts
const boundsAndZoom = (g: BoardGeom): { bounds: Rect; zoomFactor: number } => {
  const bounds = boundsFor(g)
  return { bounds, zoomFactor: fitZoomFactorForBounds(bounds.width, preset(g.viewport).w) }
}
```

Then callers use `boundsAndZoom(g)` and `boundsFor(g)` is called exactly once per board per iteration.

## Collision notes: TBD
