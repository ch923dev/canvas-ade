# draw.io Roadmap — diagram + dev-tooling feature integration

A **separate feature track** sequencing the feasible findings from
[`research/drawio-feature-borrowing.md`](research/drawio-feature-borrowing.md) into shippable slices.
Independent of the main build order ([`roadmap.md`](roadmap.md)) — parallel feature work that **does
NOT block Phase 5 (packaging) or the MCP layer**.

**Source of truth:** the research doc is the *why/how/risk* reference; this is the *order + status*.
Borrow IDEAS, not the engine — draw.io/mxGraph (Apache-2.0) is studied, not adopted
(`decisions/0001-stack.md`).

**Reads with the Excalidraw whiteboard track** (shipped W1–W5; compiled in
[`archive/2026-06-03-whiteboard-epic.md`](archive/2026-06-03-whiteboard-epic.md)). Both research
passes independently converge on the SAME conclusion — the **shapes epic** is the one structural gap.
That epic is shared, deferred, and owned in ONE place (see § Deferred). This track owns the *diagram /
dev-tooling* borrows draw.io adds on top: Mermaid, embedded-source export, anchored connectors,
text→diagram generation, and two internal-discipline refactors.

> **Overlap with the whiteboard track is deliberate and de-duplicated below** — export (their W5 vs
> this D3) and the shapes epic (their Deferred vs this Deferred) are the same work seen from two
> angles. Build once; this doc points at the shared owner, never forks it.

Legend: ✅ done · 🚧 in progress · ⛓ depends on · 📏 measured/tested · S/M/L/XL effort.

---

## Non-negotiable constraints (every slice)

Carried from the research + locked decisions. A slice that violates one is wrong, not clever.

- **Almost everything draw.io brags about at the CANVAS level is already in React Flow** — drawable
  connectors (`onConnect`), orthogonal/bezier/straight routing (path-builder swap, NOT an
  `mxEdgeStyle` port), fixed/floating anchors (named `Handle`s + `PreviewEdge.borderPoint()`),
  containers (`parentId`+`extent:'parent'`), z-order (`node.zIndex`). **Do NOT rebuild any of these
  from draw.io.** The only non-redundant value lives INSIDE a Planning board.
- **One undo checkpoint per gesture** + the `lastRecorded` phantom-undo discipline. Every new gesture
  hits this class (memory `undo-lastrecorded-phantom`; open Round-3 finding **WB-1**). D1.1
  (`withChange`) exists to make this structural rather than hand-maintained.
- **No second diagramming engine.** Never embed mxGraph / the draw.io app / `embed.diagrams.net`
  iframe — that's the two-canvas trap we rejected tldraw/Excalidraw to avoid, and it violates
  "Preview = WebContentsView, NOT iframe/webview" + the sandbox.
- **Persistence stays `canvas.json` JSON** — no mxfile XML, no per-board XML blobs, no stencil/style
  strings. Heavy blobs go to `assets/` by path, never inlined.
- **Sandbox/isolation locked** — pasted/loaded/agent-emitted content stays in renderer DOM, NEVER
  near the PTY.

---

## Sequencing rationale

1. **Internal refactors first (D1).** `withChange` + the dead-`z` decision + the license addendum are
   S, low-risk, and de-risk everything after: every later schema-touching slice adds undo gestures, so
   landing the centralized undo rail first means they ride a clean rail.
2. **Mermaid is the headline win AND the decision gate (D2).** Highest-value shapes-free borrow,
   covers ~80% of "real diagram on my canvas" via rendered SVG with canonical source text. **Ship it,
   then measure demand** — if it satisfies the formal-diagram need, the shapes epic stays deferred
   indefinitely. This is the single most important ordering call in the track.
3. **Export + durable generators last (D3).** PNG-with-embedded-source is standalone. The text→diagram
   generator is demo-ware UNLESS anchored arrows land first (generated connectors go stale on drag),
   so anchored arrows (D3.2) sequence before the generator (D3.3).
4. **Shapes epic stays deferred** — gated behind a new ADR + the Mermaid demand signal. Shared with
   the whiteboard track; owned in § Deferred, NOT forked here.

---

## Phase D1 — Internal discipline (S) ⛓ none

No user surface. Land together — all S, no locked-decision reversal.

### D1.1 — `withChange()` transaction-wrapper refactor ✅ done — PR #18 (`f7ffbbf`)
Shipped as `trackedChange`. The 5 mutating actions (`tidyBoards`/`tileBoards`/add/remove/duplicate)
now route through the centralized rail; `lastRecorded` is set in one place, eliminating the
hand-maintained scatter. Phantom-after edge intentionally not closed (would break granular move-undo —
see memory `undo-lastrecorded-phantom`). 495 unit + e2e 24/24 green post-merge.

### D1.2 — Resolve the dead `BoardCommon.z` field (decision, not feature)
`boardSchema.ts:31` `z` is validated/migrated/persisted but NEVER honored on render; `duplicateBoard`
deletes it. Latent inconsistency.
- **Pick one:** **(a)** delete `z` from `BoardCommon` + `createBoard` + `assertBoard` + clone/migration
  paths; OR **(b)** map `board.z`→RF `node.zIndex` in `Canvas.tsx` + add bring-to-front/send-to-back
  board-menu actions. Recommend **(a)** unless a bring-to-front UX is wanted. **Don't leave it
  half-wired.**
- **📏** if (a): clone/migration round-trips without `z`; if (b): z-order render + menu actions.

### D1.3 — License + offline-posture ADR addendum (doc only)
- **Why:** everything is branded "draw.io" but licenses split — **jgraph/drawio, drawio-desktop,
  mxGraph = Apache-2.0** (vendorable with NOTICE); **hediet/vscode-drawio = GPL-3.0** (copyleft —
  lifting its TS into our unsigned Electron product poisons the whole app). Expensive-to-discover-late
  trap.
- **How:** one paragraph in `decisions/0001-stack.md` + a one-liner in CLAUDE.md Locked decisions.
  Note drawio-desktop's strict-CSP/offline-isolation + "app holds nothing" model as external
  corroboration of our locked `contextIsolation`/`sandbox` + project=folder decisions, and the
  env-gated update kill-switch (`DRAWIO_DISABLE_UPDATE` → `CANVAS_DISABLE_UPDATE`) as a Phase-5 idea.
- **📏** none (doc).

---

## Phase D2 — Mermaid-as-element (M) ⛓ D1.1 · 🚦 **decision gate**

The single highest-value shapes-free borrow, and the gate that decides whether the shapes epic ever
starts. A dev pastes version-controlled Mermaid (flowchart/sequence/class/ERD/C4/state/gantt) from a
README or an agent's output; it renders visually while the source stays canonical and re-editable.
Same "authored as text, rendered visually, source canonical" pattern the design already endorses for
checklists. Covers ~80% of "I need a real diagram on my canvas" WITHOUT reopening ADR 0001.

- **How:** add `MermaidElement {kind:'mermaid'; x;y;w;h; source:string}` to the `PlanningElement`
  union (`boardSchema.ts`); bump `SCHEMA_VERSION` **7→8** (after the v7 text-typography slice + v6 board-groups; see ADR 0004) + no-op `MIGRATIONS` entry; new `assertPlanningElement`
  case (string source, finite positive w/h). Add a `'mermaid'` tool to `PlanTool` + the `TOOLS`
  cluster. Render via the MIT `mermaid` npm lib (**lazy-loaded** so non-mermaid boards don't pay the
  d3+dagre bundle) into a new `MermaidCard` sibling to `NoteCard`/`FreeText`/`ChecklistCard`;
  double-click opens a textarea of the source → re-render (explicit, never live).
- **Security:** `securityLevel:'strict'`; **namespace SVG ids per element-id** (same class as the
  existing per-board `arrowheadMarkerId` fix); theme config mapping to our design tokens; wrap render
  in try/catch → show source + parse-error instead of crashing the board.
- **After shipping — MEASURE.** Does Mermaid satisfy the formal-diagram need? **Yes → the shapes epic
  stays deferred.** No → revisit § Deferred conditions.
- **📏** schema migrate round-trip; per-element-id namespacing unit; e2e: paste source → renders →
  edit → re-renders → persists + reloads; malformed source shows error, board survives.

---

## Phase D3 — Export + durable generators (M) ⛓ D1.1, D2

### D3.1 — PNG export with embedded editable source (M) ⛓ none
The board-scoped primitive now exists: **W5** (PR #33) shipped PNG/SVG export of a single Planning
board. D3.1 is the *whole-canvas, reopenable-project* cut — still unbuilt, but can reuse the
`WhiteboardSvg`/`capturePage` helpers W5 established. draw.io's "PNG carries the source" pattern
maps onto our strictly-better setup — a versioned lossless JSON source AND a raster path already
exist.
- **How:** promote the `CANVAS_SHOT` capture in `src/main/index.ts` into a frame-guarded
  `ipcMain.handle('export:png')` (mirror `projectIpc.ts`). Reuse `toObject(boards,viewport)` as the
  embedded payload (no new serializer); inject it into a PNG `tEXt` chunk before `write-file-atomic`.
  Import = read chunk → `JSON.parse` → `fromObject` (validates + migrates) → hydrate store. Use
  fit-all bounds (reuse `FIT_FRAME` in `canvasView.ts`).
- **CRITICAL trap (ADR 0002):** a full-window `capturePage` will NOT include live Browser
  `WebContentsView`s (native layer paints above HTML) — composite the per-view `capturePage`
  snapshots `preview.ts` already produces, or export only at zoom levels where the LOD snapshot card
  shows. Ship PNG+JSON first; **decline HTML export** (CDN dep) and **URL export** (no single-user use
  case).
- **Overlap:** the Excalidraw track's **W5 (PNG/SVG of a single Planning board, shipped PR #33)** is
  the *board-scoped* cut; this D3.1 is the *whole-canvas, reopenable-project* cut. Same
  `WhiteboardSvg`/`capturePage` primitives — **build the shared capture/serialize helper once**, expose
  both surfaces. W5 landed first and owns the helper; D3.1 extends it.
- **📏** round-trip: export PNG → reopen → boards/viewport restored lossless; native-view composite
  correct (no blank Browser regions).

### D3.2 — Anchored Planning arrows (M) ⛓ D1.1
The most defensible single step toward diagramming that does NOT need the full shapes epic, and the
de-risking prerequisite for D3.3. Today an arrow between a note and a checklist is a free-floating
line — drag the note and it detaches. Binding endpoints via 0..1 relative anchors makes connectors
survive moves.
- **How:** extend `ArrowElement` with optional `from?:{id;ax;ay}` / `to?:{id;ax;ay}` (ax/ay finite
  0..1 = draw.io `exitX/exitY`), keep `x/y/x2/y2` as resolved fallback. `SCHEMA_VERSION` bump +
  additive migration; validate optional bindings in `assertPlanningElement` case `'arrow'`. Add
  `resolveArrowEndpoints()` near `svgPaths.ts` resolving a bound anchor to absolute via target
  `x/y/w/h` **at render time** — so move/resize needs NO per-arrow write. `'arrow'` tool gains drop
  hit-testing: endpoint landing on a note/checklist binds. On delete of a bound element, **orphan the
  binding (drop to fallback)**, mirroring `previewSourceId` cleanup.
- **Risks:** gateway-drug to the full epic — **restrict targets strictly to note+checklist** (text/
  stroke have no w/h). Arrow endpoints currently double as drag handles → re-detaching a bound endpoint
  needs a deliberate UX. REJECT pixel `exitDx/exitDy` offsets + stencil `<constraint>` ports as YAGNI.
- **Note vs whiteboard track:** the Excalidraw track parks "bound-arrow reflow" in its Deferred shapes
  epic; THIS slice is the cheap, note+checklist-only relative-anchor cut that does NOT need shapes —
  the two are consistent (full shape-bound reflow stays epic-gated; this minimal anchor binding does
  not).
- **📏** anchor-resolution math unit (move/resize keeps the arrow attached, no write); e2e: bind →
  drag target → arrow follows; delete target → arrow orphans to fallback.

### D3.3 — Text / outline / CSV → Planning elements generator (M) ⛓ D3.2
draw.io's lightweight tree (`A->B`, `A->label->B`) + `#`-header CSV syntaxes map onto primitives we
already have. "Paste an outline / CSV, get a planning board" — on-brand + AI-friendly (a Terminal-board
agent emits the outline).
- **How:** a pure, unit-testable parser module under `canvas/boards/planning/` (mirror `elements.ts`,
  no React/store) producing `PlanningElement[]`. LIST/CSV block → `ChecklistElement` per block; TREE
  line → `NoteElement` per unique token + `ArrowElement` per edge (the 3-part `A->label->B` drops a
  `TextElement` at the arrow midpoint — `ArrowElement` has no label field). Shelf layout reusing
  `tidyLayout.ts`. Commit via one `store.updateBoard` as a SINGLE undo checkpoint (wrap in
  `withChange` — D1.1). UI = a small textarea modal from the `PlanTool` cluster; no new board type.
- **Risks:** generated connectors go STALE on later drag **unless D3.2 landed first** — hence the
  dependency. Layout is the real 30% (text gives topology, not coordinates) → bound scope to small
  outlines. Guard pathological input (cycles, huge line counts); renderer-only, never reaches PTY.
- **📏** parser unit per syntax (list/CSV/tree/3-part); e2e: paste outline → board populated as one
  undo step; generated arrows bind (post-D3.2) and survive a drag.

---

## Deferred — the shapes epic (L tight / XL if it sprawls)

**Shared with the Excalidraw whiteboard track — owned in ONE place, not forked.** See
[`roadmap.md`](roadmap.md) › Deferred (and `archive/2026-06-03-whiteboard-epic.md` › Deferred). Both research passes independently
converge here: the absence of geometric SHAPES (rect/ellipse/diamond/compartment-box) + shape-bound
connectors is THE structural blocker for every classic dev diagram (flowcharts, all 14 UML types, ERD,
C4, mind maps, BPMN, wireframes).

- **What (MVP, hold the line):** `ShapeElement {kind:'shape'; shapeKind:'rect'|'ellipse'|'diamond'|
  'roundedRect'; x;y;w;h; text?; fill?; stroke?}` + the D3.2 `ArrowElement`→bound-connector upgrade
  (reuse the 0..1 relative-anchor scheme + `PreviewEdge.borderPoint()` for render-time resolution).
- **Conditions (ALL three):**
  1. **Reverses a LOCKED decision (ADR 0001 / CLAUDE.md "custom whiteboard, NO geometric shape
     primitives") → explicit user sign-off via a NEW ADR, not a silent build.**
  2. **Sequence D3.2 (anchored arrows) as the de-risking first step** — already in this track.
  3. **Ship D2 (Mermaid) FIRST and validate demand** — if Mermaid satisfies the formal-diagram need,
     this epic can stay deferred indefinitely.
- **MUST NOT sprawl** into stencils / UML-compartments / orthogonal-routing / alignment-distribute /
  rotate / stencil palettes. UML/ERD/C4 become thin **notation presets** on the generic shape layer
  later — NEVER bespoke per-type modes.

---

## Reject (XL traps) — do not schedule

| Trap | Why not |
|---|---|
| Embed mxGraph/maxGraph / draw.io app / `embed=1` postMessage / `embed.diagrams.net` iframe | Second engine beside React Flow (own coords/selection/undo/persistence) — the two-canvas trap; iframe route violates WebContentsView+sandbox; our MessagePort bridge is already strictly more capable. |
| Bespoke per-type modes — UML class/sequence/activity/state, ERD crow's-foot, C4, BPMN, wireframe lib, native Gantt | Each XL = shapes epic + a specialized layer; lowest ROI for an AI-dev canvas. Mermaid (D2) is the S–M substitute (native C4/class/sequence/ER/state/gantt). |
| mxfile XML format · stencil DSL · `mxEdgeStyle` routing catalog · SQL→ERD · **PlantUML import** · cloud-storage SDKs | mxfile = type-safety+diffability regression vs our JSON; routing mostly covered by `getSmoothStepPath`/`getBezierPath`; **PlantUML sunset end-2025 → target Mermaid, never PlantUML**; cloud-storage conflicts with single-user/no-multiplayer (substitute = "point the project folder at a synced Drive dir" = docs). |

---

## Status

| Phase | Status |
|---|---|
| D1.1 — `withChange` (`trackedChange`) undo-rail refactor | ✅ done — PR #18 (`f7ffbbf`, squash). Pure centralization; phantom-after edge **not** closed (would break granular move-undo — see plan + memory `undo-lastrecorded-phantom`). 495 unit · e2e 24/24 green |
| D1.2 — dead `z` field decision · D1.3 — license ADR | not started |
| D2 — Mermaid-as-element 🚦 decision gate | not started |
| D3.1 — PNG export (embedded source) | not started |
| D3.2 — Anchored Planning arrows | not started |
| D3.3 — Text/outline/CSV → elements generator | not started |
| Deferred — shapes epic (shared, ADR-gated) | deferred |

Promote a slice's detailed spec/plan into `docs/superpowers/specs/` when scheduled; update this table
as slices land. Per-slice *why/how/risk* depth lives in
[`research/drawio-feature-borrowing.md`](research/drawio-feature-borrowing.md). The shapes epic is
co-owned with the whiteboard track ([`roadmap.md`](roadmap.md) › Deferred) — schedule it from ONE track only.
