# ADR 0001 — Canvas engine & whiteboard: React Flow + custom, replacing tldraw

- **Status:** Accepted (2026-05-29)
- **Context:** The brief originally mandated tldraw. The user directed replacing it to avoid
  tldraw's production license. Decision backed by a 10-agent web-verified research workflow
  (6 dimensions → synthesis → 3 adversarial skeptics).

## Decision

1. **Canvas engine = `@xyflow/react` (React Flow) v12** (MIT).
2. **Whiteboard = custom**: vendored `perfect-freehand` (pen) + React Flow edges/bezier for
   arrows + plain React for notes/text. **Excalidraw rejected.**
3. **Cross-board arrows = React Flow edges** (preview-link connectors). `BoardNode` exposes hidden,
   non-connectable `Handle` anchors (`opacity:0`, `pointerEvents:none`) at Left/Right so RF can
   attach edges with no connection UX. Edge geometry is floating, computed from board-center
   border-intersection math in `PreviewEdge.tsx`, so arrows reroute as boards move. No
   `connectionMode` override. Intra-board sketch arrows use RF bezier utils.

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

## Addendum (2026-06-15) — draw.io / mxGraph license split for the parked shapes epic

The Planning Board Optimization research (`docs/research/2026-06-15-planning-board-optimization/REPORT.md`
§4–7) re-examined the geometric-shapes epic and used **draw.io** as one of its two reference passes
(alongside Excalidraw). Reopening that epic would *reverse this ADR* and needs a **new ADR + explicit
user sign-off** (never a silent build) — but if it ever does, the engine's license must already be
settled. Recording it here so a future implementer inherits a correct baseline and doesn't repeat the
"is draw.io copyleft?" investigation.

**The permissive core (safe).** draw.io / diagrams.net and its engine **mxGraph (the JavaScript
library)** are **Apache License 2.0** — permissive, *not* copyleft. draw.io's bundled third-party JS
dependencies are explicitly all Apache-2.0-compatible, with **no GPL or AGPL** in the stack. So
referencing or vendoring the mxGraph / drawio source carries **no copyleft obligation** on our app —
the same posture as our React Flow (MIT) + vendored perfect-freehand (MIT). draw.io also makes no
copyright claim on the diagrams a user authors.

**The split / caveats (why this is not a one-line "it's Apache, ship it"):**
1. **mxGraph (JS) is EOL.** JGraph stopped development on **2020-11-09** and **archived** the repo.
   draw.io carries its own internal fork inside `jgraph/drawio` but does not publish mxGraph as a
   maintained standalone library. Vendoring mxGraph = adopting an **unmaintained** engine and owning
   every bugfix — the key-person/maintenance risk we accepted for perfect-freehand, at a far larger
   surface. The live community fork is **maxGraph** (also Apache 2.0).
2. **The rename was trademark, not copyleft.** maxGraph was renamed from "mxGraph" (2021-06) because
   **"mxGraph" is a JGraph trademark**, not because any Apache-license term was triggered. Apache 2.0
   licenses the *code*, not the *marks*: we could fork/vendor the code but could not redistribute it
   under the **mxGraph** or **draw.io** name/logo.
3. **Permissive ≠ everything under the draw.io brand.** Only the **source** repos are Apache-2.0
   (`jgraph/drawio`, `jgraph/drawio-desktop`, `jgraph/mxgraph`). draw.io's **commercial integrations**
   (Confluence / Jira plugins, the drawio.com SaaS) are proprietary. We would only ever vendor the
   Apache-2.0 source, never bundle a proprietary integration.
4. **Beware the older "JGraph" Java lineage.** The original JGraph Swing component (pre-mxGraph) and
   JGraphX are *different artifacts under different licenses* — never pull anything by the "JGraph"
   name assuming it matches draw.io's Apache-2.0 JS stack.

**Bearing on the decision.** None of this reverses ADR 0001. It confirms that *if* the shapes epic is
reopened, the leading reference engine is **license-safe (Apache 2.0, permissive)** but
**maintenance-unsafe (EOL)** — which reinforces the standing recommendation (REPORT §4) to ship the
Mermaid `Diagram` element first (Mermaid is MIT and maintained) and keep the geometric-shapes /
mxGraph path parked until Mermaid demonstrably fails the formal-diagram need. The license is not the
blocker; the EOL maintenance burden and the ADR-0001 reversal are.

Sources: `jgraph/drawio` `LICENSE` (Apache-2.0) + the "draw.io | drawio" project page (bundled deps
Apache-compatible, no GPL/AGPL); `jgraph/mxgraph` (archived, EOL 2020-11-09); the **maxGraph** fork
(renamed 2021-06 over the mxGraph trademark).
