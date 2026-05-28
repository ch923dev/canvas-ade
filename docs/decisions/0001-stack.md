# ADR 0001 — Canvas engine & whiteboard: React Flow + custom, replacing tldraw

- **Status:** Accepted (2026-05-29)
- **Context:** The brief originally mandated tldraw. The user directed replacing it to avoid
  tldraw's production license. Decision backed by a 10-agent web-verified research workflow
  (6 dimensions → synthesis → 3 adversarial skeptics).

## Decision

1. **Canvas engine = `@xyflow/react` (React Flow) v12** (MIT).
2. **Whiteboard = custom**: vendored `perfect-freehand` (pen) + React Flow edges/bezier for
   arrows + plain React for notes/text. **Excalidraw rejected.**
3. **Cross-board arrows = React Flow edges** (hidden title-bar handle, `connectionMode="loose"`,
   `edge.zIndex` raised so arrowheads sit above target chrome). Intra-board sketch arrows use RF bezier utils.

## Why tldraw was dropped

- tldraw SDK 4.x is source-available: requires a license key, renders a "made with tldraw"
  watermark on the free tier, and costs ~$6,000/yr for commercial use. Fails all three of our
  hard "no" conditions (no key / no watermark / no per-seat fee).

## Why React Flow

- Only DOM-node engine that holds **arbitrary live React content** inside a node (xterm canvas,
  transparent native-view cutout, checklist) — canvas/WebGL engines (Konva/Fabric/Pixi/G6)
  structurally can't.
- Camera = a single inspectable CSS `translate(x,y) scale(z)` on `.react-flow__viewport`
  (d3-zoom) → exactly the model needed to imperatively sync a native `WebContentsView` overlay.
- `NodeResizer` (8 handles + min-size, full restyle), `fitView`/`setCenter`/`zoomTo` with
  `duration` (animated focus), official LOD-by-zoom pattern, `toObject()` JSON serialize.
- MIT, no license key, no per-seat fee. **Correction vs first synthesis:** React Flow DOES ship
  a default attribution badge — removable for FREE with no key via `proOptions={{hideAttribution:true}}`
  (honor-system ask to support). We set `hideAttribution: true`. Set `minZoom={0.1} maxZoom={2.5}` (default 0.5/2).

## Why custom whiteboard (not Excalidraw)

Excalidraw is MIT (license fine) but fails our embed scenario technically: no bounded-canvas mode
(#4093) → nesting an infinite canvas in RF's infinite canvas; documented coordinate bug inside an
RF-scaled node (#4778); multi-instance state bleed (#7798) — one Excalidraw per Planning board is
our exact failing case; ~45 MB; a second serialization format.

**Adversarial corrections folded in:**
- The pointer-coordinate offset under CSS scale is **generic to any pointer-canvas in an RF node**,
  not Excalidraw-specific. Custom wins because we own the fix: divide pointer deltas by `zoom`
  (`useReactFlow().getZoom()`). Budget this work; it isn't free.
- `perfect-arrows` is **abandoned** (last commit 2022) → do NOT take as a live dep; use RF edges/bezier.
- `perfect-freehand` is single-maintainer, low-velocity, authored by tldraw's founder (key-person
  risk) → **vendor a pinned copy** (MIT, ~112 KB, stable algorithm) and own bugfixes.

## Consequences / risks

- Native-overlay sync is our biggest cost and **lags worse on Windows** (async IPC `setBounds`;
  precedent: electron #32751). Mitigation = detach + `capturePage` snapshot while moving, reattach
  on idle. Validate FIRST in the Phase 1 gate on Windows with 3–4 live views.
- xterm under CSS scale historically mis-measures cells/selection → pin xterm ≥5.5; consider
  counter-scaling (render at zoom 1, scale wrapper) or LOD card swap.
- Runner-up if React Flow ever blocks us: **AntV X6** (MIT) — but pin hard (May-2026 npm supply-chain
  worm hit @antv). Reopen Excalidraw only if a true hand-drawn/roughjs aesthetic becomes required.
