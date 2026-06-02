# Research — infinite-canvas coordinate model & the Planning full-view bug (2026-06-02)

**Why:** the Planning board's full-view "add a note" + "fit to content" kept breaking despite three
attempts. The user's repeated instinct — "it might be the schema / something fundamental" — turned out
to be correct. This note captures the web research (tldraw, Steve Ruiz, React Flow, D3) and the
resulting architectural diagnosis so the fix is designed once, correctly.

## The canonical model (what every production canvas does)

tldraw (Steve Ruiz, its creator), React Flow, and the general HTML-canvas literature all agree:

- **One camera `{x, y, z}`.** `z` = zoom (1 = 100%). `x,y` = top-left of the viewport in *world/page*
  coordinates.
- **Elements are stored in UNBOUNDED world/page space** — never inside a fixed per-element box. The
  camera projects that infinite space to the screen.
- **A single screen↔world transform**, applied once:
  - `screenToWorld(p) = { x: p.x / z - camera.x, y: p.y / z - camera.y }`
  - `worldToScreen(p) = { x: (p.x + camera.x) * z, y: (p.y + camera.y) * z }`
- **Place a new element at a click** = `screenToWorld(clickScreenPoint)`. Direct, exact, at any zoom.
- **Zoom keeping the cursor fixed** = world-point-before vs world-point-after the zoom, shift `camera.x/y`
  by the delta.
- **Zoom-to-fit / fit-to-content** = compute `scale + center` to fit a bounding box into the viewport,
  capped by a `targetZoom` and an `inset`/padding. tldraw exposes `zoomToFit()`, `zoomToSelection()`,
  `zoomToBounds(bounds, { inset, targetZoom })`. (D3's mbostock "Zoom to Bounding Box" is the canonical
  2-D version: `scale = clamp(min(W/bw, H/bh)); translate = center − scale·bboxCenter`.)

## The load-bearing pitfall: nesting two transformed viewports

- **React Flow does NOT support nesting a ReactFlow inside a node** — the docs/discussions call it the
  "outer vs inner transform issue": the inner content gets a position offset because two camera
  transforms compound. `screenToFlowPosition()` only inverts ONE transform.
- **CSS nested zoom multiplies**: a parent at `scale 0.5` containing a child at `scale 0.5` renders the
  child at 25%. Applying a transform at two levels without explicitly composing them is a bug.
- `transform: scale()` (visual only) vs CSS `zoom` (affects layout) must not be mixed.

## Diagnosis of OUR bug (research-backed)

Our Planning board violates the canonical model in two compounding ways:

1. **Bounded-box, board-local coordinates (the "schema" issue).** Elements are stored in *board-local*
   px inside a fixed `board.w × board.h` box (`overflow:hidden`). That's not an infinite canvas — it's a
   clipped frame. Content placed outside the box (which the full-view bug did: a note at board-local
   `x=1469` when `board.w=516`) is silently clipped. Real canvases use unbounded world coords + a camera,
   so "outside" doesn't exist.

2. **Full-view introduces a SECOND transform — the exact nesting pitfall.** On the canvas the board is a
   React Flow node under the parent camera (ONE transform); `toBoard` works because it measures that one
   rendered scale. **Full-view portals the board OUT of the node into a modal and applies its own CSS
   transform** — now there are two stacked transforms (the modal's `.fullview-frame transform: scale(1)`
   ancestor + our stage/well transform), and `toBoard`'s "measure `rect.width/offsetWidth`" assumption no
   longer yields a clean single mapping. Clicks map to the wrong world point; content clips against the
   box. This is why every full-view coordinate attempt (stretch → 1:1 → fit-to-content) was fragile.

**Why Focus works but Full-view doesn't:** Focus (`Canvas.tsx` → `rf.fitView({ nodes: [board] })`) moves
the **parent camera** — still ONE transform — so `toBoard`, add-note, and drag all work unchanged.
Full-view is the only path that stacks a second transform.

## Solution directions (decide before coding)

- **A — Planning full-view = camera fit (reuse the Focus path).** Don't portal Planning into the modal;
  instead `fitView({ nodes: [board], maxZoom })` to zoom the parent camera onto the board (optionally with
  a dimming scrim + exit affordance). ONE transform → the whole bug class disappears, `toBoard`/add/drag
  work as on canvas. *Smallest, most robust.* Cost: it moves the camera (full-view originally "didn't");
  Planning diverges from the Browser/Terminal portal path (justified — those portal only to keep live
  native content alive, which DOM Planning doesn't need).

- **B — Keep the portal modal, but make full-view a proper single explicit transform.** Render the
  planning content through ONE container transform = the fit `{scale, tx, ty}`, and compute `toBoard`
  from those KNOWN values + the stage's screen origin (NOT from `getBoundingClientRect` measurement).
  Removes the measurement fragility; keeps a consistent modal UX across board types. *Medium effort.*
  Still carries the bounded-box clipping issue.

- **C — Make Planning elements unbounded world coords (drop the `board.w×board.h` box).** The fully
  canonical model; resolves both the clipping and the nesting issues structurally. *Largest:* schema
  migration + rework of marquee/snap/grow/persist. The right long-term direction (the user's instinct),
  likely overkill for the immediate fix.

**Recommendation:** **A** for the immediate, robust fix (eliminates the second transform — the actual
root cause — by reusing the proven camera path), with **C** noted as the long-term model if Planning
boards are meant to be truly infinite sketch surfaces rather than framed cards.

## Sources

- Steve Ruiz (tldraw creator), *Creating a Zoom UI* — https://www.steveruiz.me/posts/zoom-ui
- tldraw Camera docs — https://tldraw.dev/sdk-features/camera
- React Flow coordinate system / nested-flow offset — https://github.com/xyflow/xyflow/discussions/4311 ·
  https://github.com/xyflow/xyflow/discussions/4743
- mbostock, *Zoom to Bounding Box* — https://gist.github.com/mbostock/4699541
- roblouie, *Transforming Mouse Coordinates to Canvas Coordinates* —
  https://roblouie.com/article/617/transforming-mouse-coordinates-to-canvas-coordinates/
