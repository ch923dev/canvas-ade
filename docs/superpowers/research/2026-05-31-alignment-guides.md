# Smart Alignment Guides — Web Research (2026-05-31)

> Source: 5-agent web-research workflow (`align-guides-research`, run `wf_afc74a89-c12`).
> Verbatim synthesis preserved for the spec/plan. Decisions taken from it are in
> `docs/superpowers/specs/2026-05-31-alignment-guides.md`.

## 1. TL;DR recommendation

**Build the React Flow "Helper Lines" pattern by hand — no new dep.** The official
`getHelperLines` util is now Pro-gated / 404 in OSS. The pattern is ~150 lines and fits our
shape: controlled nodes through one `onNodesChange` (the interception point), zoom from
`useStore(s => s.transform[2])`, drag start/stop already wired.

**Snap by mutating `change.position` inside `onNodesChange` BEFORE `applyNodeChanges` — NOT
`setNodes` mid-drag** (xyflow #4593 = v12 jitter regression from `setNodes`). Our controlled
`onNodesChange` path sidesteps it.

Ship edge + center first (the high-value 80%). Equal-spacing / distribution = separate phase
(Excalidraw gap algorithm).

## 2. How it works

- **Detection (pure, per-axis nearest-match):** dragged rect → 3 stops/axis
  (X: left/centerX/right · Y: top/centerY/bottom). Loop other boards, 3×3 diff per axis, keep
  smallest under threshold. Gives edge↔edge + center↔center free. At most one vertical + one
  horizontal winner, each `{ guideCoord, snapValue }`.
- **Threshold under zoom (the one detail that matters):** store screen px, compare world units →
  `effectiveThreshold = SNAP_THRESHOLD / zoom`. Excalidraw (`SNAP_DISTANCE = 8`) and tldraw both
  do this; Konva does NOT (assumes scale=1). Start 8 screen px.
- **React Flow hooks:** `onNodesChange` (intercept the single `NodePositionChange` where
  `dragging && position`), `useStore(s => s.transform)` for zoom + overlay, `onNodeDragStart/Stop`
  to gate + clear guides. NOT `onNodeDrag`. `snapToGrid`/`snapGrid` irrelevant (fixed grid). Guard
  multi-select (canonical util is single-node only).
- **Render:** `<canvas>`/SVG sibling to `<ReactFlow>`, `absolute inset:0 pointerEvents:none`,
  above boards. world→screen `x*zoom+tx`, stroke 1px (no ctx.scale) → crisp at any zoom. Color =
  accent `#4f8cff`.

## 3. OSS references (priority order)

1. **DiagramX** (MIT, RF v12 re-impl of the Pro pattern) — most copy-relevant:
   - `getHelperLines.ts` — https://github.com/DaveAldon/DiagramX/blob/main/src/components/HelperLines/getHelperLines.ts
   - `HelperLines.tsx` — https://github.com/DaveAldon/DiagramX/blob/main/src/components/HelperLines/HelperLines.tsx
   - `useHelperLines.tsx` — https://github.com/DaveAldon/DiagramX/blob/main/src/hooks/useHelperLines.tsx
2. **Excalidraw `snapping.ts`** — zoom-scaled threshold + equal-spacing/gap distribution
   (`getVisibleGaps`, gap-center + gap-duplication). Copy for phase 2 —
   https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/snapping.ts
3. **Konva Objects_Snapping** — minimal `{guide, offset, snap}` model (scale=1 caveat) —
   https://konvajs.org/docs/sandbox/Objects_Snapping.html
4. **tldraw snapping docs** — 'points' vs 'gaps', dedupe, single-continuous-line —
   https://tldraw.dev/sdk-features/snapping
5. **xyflow #4593** — the v12 jitter gotcha — https://github.com/xyflow/xyflow/issues/4593

## 4. Fit to our constraints & risks

- **Resizable custom nodes:** fine — board `w/h` is durable in the store; align by true edges.
  Guard against undefined size → NaN stops.
- **Native `WebContentsView` occlusion (ADR 0002):** non-issue. `onNodeDragStart` already calls
  `window.api.detachAllPreviews?.()` synchronously (Canvas.tsx:256) → no native view attached
  during a drag → guides draw cleanly over snapshot cards. **No new occlusion work.**
- **Reduced-motion:** snapping is instant per-frame clamp → already safe. Only gate a guide
  fade-in (we won't add one — guides show/hide instantly).
- **Zustand:** guide coords are ephemeral drag UI → local component state, NOT persisted. The
  snapped *position* flows the normal `updateBoard` path (persisted, correct).
- **Performance:** O(N) scan/frame is the shipped baseline (Konva/tldraw/Excalidraw). Fine for a
  handful of boards; prefilter `getIntersectingNodes`/viewport-cull only if counts grow.
- **Risk — jitter #4593:** mitigated by design (mutate `change.position`, not `setNodes`).
- **Risk — composes with detach+snapshot LOD:** only `position` is mutated; must pass the existing
  browser-trio e2e (known env flake) to confirm no regression.

## 5. Open questions → user decisions taken 2026-05-31

1. Distribution now or later? → **Build it, but as slice 2** (edge+center slice 1 first).
2. Threshold? → **8 screen px ÷ zoom** start.
3. Line style? → **Dashed blue `#4f8cff` `[4,6]`, 1px.**
4. Suppress modifier? → **Always-on snap; Ctrl mid-drag suppresses.**
5. Snap to viewport center? → skip (infinite canvas).
6. Multi-select drag? → v1 single-board only (canonical limitation).
