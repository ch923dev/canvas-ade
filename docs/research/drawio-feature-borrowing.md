# Research — borrowing the best of draw.io (diagrams + dev tooling) for our canvas

> **Status:** feeds the open `docs/roadmap-drawio.md` track (D1.1 shipped #18; D1.2/D2/D3 open). Collapse into the build-log when that track ships.

> Deep-research output (2026-06-01), web-sourced + grounded in the actual codebase +
> adversarially feasibility-checked. **Report only — nothing built or committed.** Borrow
> IDEAS, not the engine: draw.io/mxGraph (Apache-2.0) is a diagramming tool we study, not
> adopt wholesale (`../decisions/0001-stack.md`). Method: 4 parallel web-research facets
> (diagram-types · engine/data-model · dev-integrations · text-to-diagram) → codebase
> grounding → per-finding feasibility verify (44 raw → 36 feasible, each flagged
> `needs_shapes_epic` + canvas-RF-vs-in-board) → prioritized synthesis. 50 agents.
>
> **Companion to the Excalidraw whiteboard pass (shipped W1–W5; compiled in
> `../archive/2026-06-03-whiteboard-epic.md`). Both passes independently converge on one
> conclusion (see § Shapes-epic verdict).**

## TL;DR

draw.io's entire software-dev value (UML, ERD, C4, flowcharts, BPMN, cloud stencils) sits on
**one subsystem we deliberately lack: geometric SHAPES** (rect/ellipse/diamond/compartment-box)
plus **shape-bound, anchored, rerouting connectors**. This is the **second** research pass (after
Excalidraw) to converge on exactly that gap — the decisive signal of the report.

Borrowable ideas split three ways:
1. **Cheap, shapes-free, on-brand wins** that ride our existing schema/persistence/React-Flow
   stack (Mermaid-as-element, outline/CSV → elements, anchored arrows, PNG-with-embedded-source,
   the transaction-wrapper refactor).
2. **The SHAPES EPIC** — the heavyweight foundation that unlocks every classic diagram type but
   reopens a locked decision (ADR 0001); L–XL.
3. **A pile of XL traps** that all reduce to "embed mxGraph" or "build the shapes epic to render
   one niche diagram type" — explicitly reject.

**Crucially, almost everything draw.io is praised for at the CANVAS level is REDUNDANT — React
Flow already ships it; we've just not surfaced it.** The canvas half is "turn on RF features," not
"borrow draw.io." The genuinely new (and expensive) work lives INSIDE a Planning board.

## What React Flow already covers — do NOT rebuild from draw.io

RF v12 already gives us, at the **canvas (node-to-node) level**, essentially everything draw.io's
connector/container/layer story brags about. We've simply not surfaced it (`edgeTypes` has ONE entry
`'preview'`, handles are `isConnectable=false`, no `onConnect` wired). With **no draw.io/mxGraph code**:

1. **User-drawable connectors** — `onConnect` + `connectionMode` + draggable connectable `Handle`s.
2. **Multiple edge path styles** — `getStraightPath`, `getBezierPath`, `getSimpleBezierPath`, AND
   `getSmoothStepPath` (orthogonal/manhattan with auto-turns + `borderRadius` corner rounding =
   draw.io's `rounded=1`). "Orthogonal/elbow/straight/curved" routing is a **path-builder swap**,
   not an `mxEdgeStyle` port.
3. **Fixed vs floating connection points** — named `Handle`s with `id`+`Position` = fixed anchors
   (draw.io `exitX/exitY` = a CSS-%-positioned handle); our `PreviewEdge.borderPoint()` already IS
   draw.io's floating-perimeter routing.
4. **Multi-node chains A→B→C** — native to the node/edge graph.
5. **Containers / swimlane grouping** — `parentId` + `extent:'parent'` gives bounded children,
   group-drag, re-parent-on-drop (draw.io's `container=1` "comes for free").
6. **Z-order / layers** — per-node `zIndex` (we even have a dead `BoardCommon.z` field).
7. **Edge labels.**

The ONE thing RF lacks is a declarative child auto-arrange engine — but we own that too
(`tidyLayout.ts` shelf-pack + `tidyBoards`/`tileBoards`). **Net: do NOT rebuild node connectors,
handles, routing, containers, or z-order from draw.io.** The only non-redundant draw.io value lives
INSIDE a Planning board (geometric shapes + in-board connectors), because RF operates *between*
boards, not between sub-elements of one board.

---

## Quick wins (shapes-free, no locked-decision reversal)

### 1. Mermaid-as-element in Planning boards (Image + round-trip model, NOT native-shape mode)
**Effort: M.** The single highest-value shapes-free borrow. A dev pastes version-controlled Mermaid
(flowchart/sequence/class/ERD/C4/state) from a README or an agent's output and renders it visually
while the source stays re-editable. Same "authored as text, rendered visually, source canonical"
pattern the design already endorses for checklists; sidesteps the entire shapes epic by treating the
diagram as a rendered SVG, not editable geometry. Covers ~80% of "I need a real diagram on my canvas."

**How.** Add `MermaidElement {kind:'mermaid'; x;y;w;h; source:string}` to the `PlanningElement` union
(`boardSchema.ts`), bump `SCHEMA_VERSION` + no-op `MIGRATIONS` entry (house discipline), new
`assertPlanningElement` case (string source, finite positive w/h). Add a `'mermaid'` tool to the
`PlanTool` union + `TOOLS` cluster in `PlanningBoard.tsx`. Render via the MIT `mermaid` npm lib
(**lazy-loaded** so non-mermaid boards don't pay the d3+dagre bundle) into a new `MermaidCard` sibling
to `NoteCard`/`FreeText`/`ChecklistCard`; double-click opens a textarea of the source → re-render.
Set `securityLevel:'strict'`, **namespace SVG ids per element-id** (same class as the existing
per-board `arrowheadMarkerId` fix), pass a theme config mapping to our design tokens, wrap render in
try/catch showing source + parse-error instead of crashing the board.

### 2. PNG export with embedded editable source
**Effort: M.** We have ZERO user-facing export today (only internal LOD snapshots + `canvas.json`).
draw.io's "PNG/SVG/PDF carries the XML" pattern maps onto our strictly-better setup: we already have a
versioned lossless source (`CanvasDoc` `toObject`/`fromObject`) AND a raster path
(`capturePage().toPNG()` behind `CANVAS_SHOT`). Embedding the JSON `CanvasDoc` in a PNG `tEXt` chunk
makes one `.png` both a shareable image and a re-openable project.

**How.** Promote the `CANVAS_SHOT` capture in `src/main/index.ts` into a frame-guarded
`ipcMain.handle('export:png')` (mirror `projectIpc.ts`). Reuse `toObject(boards,viewport)` as the
embedded payload (no new serializer); `fromObject` validates+migrates on import for a lossless,
forward-safe round-trip. Inject a custom `tEXt` chunk before `write-file-atomic`; import = read chunk,
`JSON.parse`, `fromObject`, hydrate store. **CRITICAL trap (ADR 0002):** a full-window `capturePage`
will NOT include live Browser `WebContentsView`s (native layer paints above HTML) — composite the
per-view `capturePage` snapshots `preview.ts` already produces, or export only at zoom levels where
the LOD snapshot card shows. Ship PNG+JSON first; decline HTML export (CDN dep) and URL export (no
single-user use case). Use fit-all bounds (reuse `FIT_FRAME` in `canvasView.ts`).

### 3. `withChange()` transaction-wrapper refactor of the undo path
> **SHIPPED.** Landed as `trackedChange` in PR #18 (f7ffbbf). All listed actions (`tidyBoards`,
> `tileBoards`, `addBoard`, `removeBoard`, `duplicateBoard`, `undo`/`redo`) are routed through it.
> The analysis below is retained as design rationale.

**Effort: S.** Borrow mxGraph's nested `beginUpdate`/`endUpdate` counter — "emit a change/undo event
only when the counter returns to 0 AND state actually changed" — which is structurally exactly the
guarantee that prevents the documented phantom-undo class (`undo-lastrecorded-phantom` memory / #BUG
M3). Today that logic is a module-scoped `lastRecorded` ref + per-action `changed` flags + manual
`lastRecorded = boards` syncs scattered across `tidyBoards`/`tileBoards`/add/remove/duplicate/undo/redo
— four hand-maintained copies, each a future regression. One `withChange(mutator)` wrapper centralizes
it. Pure-internal, no user surface, no new dep.

**How.** Add `withChange(mutator)` to `canvasStore`: snapshot `s.boards`, run mutator, diff by
reference, push via `recordPast` only if changed, then set `lastRecorded` internally in ONE place.
Collapse `tidyBoards` (`canvasStore.ts:326`), `tileBoards` (`:352`), `addBoard`, `removeBoard`,
`duplicateBoard`, `undo`/`redo` into it. Touches the undo rails → MUST re-run `canvasStore.test.ts`
(covers phantom-step cases) + the e2e harness before handoff (`e2e-before-handoff` memory).

### 4. Resolve the dead `BoardCommon.z` field (decision, not feature)
**Effort: S.** `boardSchema.ts:31` has an optional `z` that is validated, migrated, and persisted but
NEVER honored on render (no z-sort in `Canvas.tsx`; `duplicateBoard` deletes it to re-stack via array
order). Stacking is already "array index = draw order" by accident — exactly mxGraph's child-index =
z-order model — but the orphan field is a latent inconsistency. Either **(a)** delete `z` from
`BoardCommon` + `createBoard` + `assertBoard` + clone/migration paths, OR **(b)** map `board.z` →
RF `node.zIndex` in `Canvas.tsx` + add bring-to-front/send-to-back board-menu actions. Recommend (b)
only if a bring-to-front UX is wanted; otherwise (a). **Don't leave it half-wired.**

### 5. Document the draw.io licensing split + offline posture as ADR addenda (no code)
**Effort: S.** Everything is branded "draw.io" but licenses differ: **jgraph/drawio, drawio-desktop,
mxGraph = Apache-2.0** (vendorable/studyable with NOTICE), while **hediet/vscode-drawio = GPL-3.0**
(copyleft — lifting its TS into our unsigned Electron product triggers copyleft on the whole app). An
easy, expensive-to-discover-later trap. Separately, drawio-desktop's strict-CSP/offline-isolation and
"bring-your-own-storage, app holds nothing" model externally corroborate our locked
`contextIsolation`/`sandbox` + project=folder/`canvas.json` decisions.

**How.** One-paragraph addendum to `decisions/0001-stack.md` + a one-liner in CLAUDE.md Locked
decisions. Note the env-gated update kill-switch (`DRAWIO_DISABLE_UPDATE` → `CANVAS_DISABLE_UPDATE`)
as a Phase-5 packaging idea alongside electron-updater→GitHub Releases.

---

## High value

### A. Geometric SHAPES subsystem — minimal rect/ellipse/diamond + bound connectors (THE EPIC)
**Effort: L (tight MVP) / XL if it sprawls.** The foundation BOTH research passes independently
identify as the single biggest unlock — prerequisite for EVERY classic dev diagram (flowcharts, all
14 UML types, ERD, C4, mind/concept maps, BPMN, wireframes), none of which can render into our
note/text/arrow/stroke/checklist union today. Strategic value is **not** "become draw.io" but "have
geometric primitives so the Planning board can express architecture/flow sketches and so
text-to-diagram has something to render INTO."

**How (MVP, NOT a clone).** (1) `ShapeElement {kind:'shape'; shapeKind:'rect'|'ellipse'|'diamond'|'roundedRect'; x;y;w;h;text?;fill?;stroke?}`
behind a `SCHEMA_VERSION` bump + migration + new `assertPlanningElement` branch; render in
`WhiteboardSvg.tsx` alongside arrows/strokes; resize handles + shape tools in the `PlanTool` cluster.
(2) Upgrade `ArrowElement` into a real connector (see slice B). Use a `getSmoothStepPath`-equivalent
for orthogonal in-board routing only if demand appears; default bezier.

**Risks.** Reopens a LOCKED decision (CLAUDE.md / ADR 0001: "custom whiteboard, NO geometric shape
primitives") → **requires explicit user sign-off via a new ADR, not a silent build.** Scope-creep
magnet (once arrows snap to shapes, users want alignment/distribute/rotate/stencil palettes — hold the
MVP line). Touches persisted schema (.bak fallback, migration), undo rails (new gestures hit the
phantom class), selection/hit-test/drag, dangling-ref cleanup (mirror `previewSourceId` orphan-drop).
Half-built shapes under-deliver vs mature libs → lean on the Mermaid quick win to cover formal-diagram
needs WITHOUT this epic.

### B. Anchored Planning arrows — the `exitX/exitY` 0..1 relative-anchor borrow (STANDALONE pre-shapes)
**Effort: M.** The most defensible single step toward diagramming that does NOT need the full epic.
Today an arrow between a note and a checklist is a dumb free-floating line — drag the note and it
detaches (`translateElement` moves only the dragged element). Binding endpoints via 0..1 relative
anchors makes connectors survive moves — the foundational behavior every diagram type needs, and what
makes the Mermaid/outline generators durable instead of demo-ware.

**How.** Extend `ArrowElement` with optional `from?:{id;ax;ay}` / `to?:{id;ax;ay}` (ax/ay finite
0..1), keep `x/y/x2/y2` as resolved fallback. `SCHEMA_VERSION` 2→3 + additive migration; validate the
optional bindings in `assertPlanningElement` case `'arrow'`. Add `resolveArrowEndpoints()` near
`svgPaths.ts` that resolves a bound anchor to absolute via target `x/y/w/h` **at render time** — so
move/resize needs NO per-arrow write. `'arrow'` tool gains drop hit-testing: endpoint landing on a
note/checklist binds with a relative anchor. **Restrict targets to note+checklist** (text/stroke have
no w/h). REJECT pixel `exitDx/exitDy` offsets + stencil `<constraint>` port-advertisement as YAGNI.

**Risks.** Gateway-drug to the full epic — keep strictly to note+checklist anchoring. Arrow endpoints
currently double as drag handles, so re-detaching a bound endpoint needs a deliberate UX. Migration
risk low (additive optional fields). Pairs with + de-risks the generators and the shapes epic.

### C. Text/outline/CSV → Planning elements generator (draw.io "Insert from Text" + CSV, shapes-free subset)
**Effort: M.** draw.io's lightweight tree (`A->B`, `A->label->B`) and entity-list syntaxes + the
`#`-header CSV pattern map onto primitives we ALREADY have: list/CSV rows → `ChecklistElement.items`
(near 1:1) or `NoteElement`s; tree lines → a `NoteElement` per token + an `ArrowElement` per edge.
"Paste an outline / CSV, get a planning board" is on-brand + AI-friendly (an agent in a Terminal board
emits the outline). No shapes epic required.

**How.** A pure, unit-testable parser module under `canvas/boards/planning/` (mirror `elements.ts`,
no React/store) producing `PlanningElement[]`. LIST/CSV → `ChecklistElement` per block; TREE →
`NoteElement` per unique token + `ArrowElement` per line (the 3-part `A->label->B` drops a
`TextElement` at the arrow midpoint — `ArrowElement` has no label field). Assign board-local x/y with
a shelf layout reusing `tidyLayout.ts`. Commit via one `store.updateBoard` as a SINGLE undo checkpoint
(wrap in `withChange` — phantom class). UI = a small textarea modal from the `PlanTool` cluster; no
new board type.

**Risks.** `ArrowElement` is point-to-point, so generated connectors go STALE on later drag **unless
slice B lands first** — frame as one-shot "generate then plain-editable," OR sequence after anchored
arrows. Layout is the real 30% (text gives topology, not coordinates) — bound scope to small outlines.
Guard pathological input (cycles, huge line counts); renderer-only, never reaches PTY.

---

## Avoid (XL traps)

| Feature | Why not |
|---|---|
| **Embed mxGraph/maxGraph / the draw.io app in a board** (incl. the VS Code-extension embed + `embed=1&proto=json` postMessage protocol) | Contradicts ADR 0001 + the locked stack: a SECOND diagramming engine beside React Flow with its own coords, selection, undo, and persistence (mxfile XML islands) — the exact two-canvas trap we rejected tldraw/Excalidraw to avoid. The iframe route (`embed.diagrams.net`) violates "Preview = WebContentsView, NOT iframe/webview" + sandbox; the self-hosted-WebContentsView route re-incurs every ADR-0002 native-layer occlusion problem AND ships a heavy SPA. Our MessagePort+contextBridge bridge is already STRICTLY MORE capable than draw.io's single-channel postMessage. Dense UML chrome fights the calm Linear/Raycast contract. |
| **Bespoke per-type modes** — UML class/sequence/activity/state/use-case/object, ERD crow's-foot, C4, BPMN, wireframe library, native Gantt | Each is XL = a strict SUPERSET of the shapes epic PLUS a specialized layer (sequence = time-ordering layout; activity = concurrency bars + swimlanes; ERD = row-level ports + compound crow's-foot terminators + orthogonal routing; class = typed-member compartment editors; wireframe = open-ended widget library). Lowest-ROI for an AI-dev canvas — the agentic terminal can READ a live DB/source and emit a schema or Mermaid, so hand-drawing formal UML competes with mature free tools. The **Mermaid quick win** (native C4/class/sequence/ER/state/gantt) is the S–M substitute. If shapes ever land, UML/ERD = thin notation **presets** on the generic layer, never dedicated subsystems. |
| **Adopt the mxfile XML format · stencil DSL interpreter · `mxEdgeStyle` routing catalog · SQL→ERD · PlantUML import · cloud-storage SDKs** | All redundant/premature/off-target. mxfile XML as our persistence = throwing away a working validated JSON schema for a stringly-typed format that round-trips terminal/browser/checklist only as opaque blobs (type-safety + diffability regression); our `canvas.json` + `.bak` already implements draw.io's own "uncompressed, pretty, git-diffable" lesson. Stencil DSL = elegant format for shapes we don't have (roadmap note only). Routing catalog mostly covered by `getSmoothStepPath`/`getBezierPath`. SQL→ERD + PlantUML are XL+shapes-gated, and **PlantUML is sunset end-2025 → target Mermaid, never PlantUML.** Native cloud-storage = XL auth/conflict plumbing conflicting with single-user/no-multiplayer + last-writer-wins atomic write; 90%-value substitute = "point your project folder at a synced Drive/Dropbox dir" = documentation. |

---

## Shapes-epic verdict

**Justified as a deliberately-greenlit, separately-ADR'd epic — but NOT started first, and only at
MINIMAL MVP scope.** The signal is real and decisive: **TWO independent research passes (Excalidraw,
now draw.io) converge on the identical conclusion** — the absence of geometric shapes
(rect/ellipse/diamond/compartment-box) + shape-bound, anchored, rerouting connectors is THE structural
blocker, and the single foundation that unlocks every classic dev diagram. Nothing else borrowed from
draw.io needs it; everything valuable that ISN'T it is either already-shipped (RF
connectors/containers/z-order, local-first persistence, git-diffable JSON) or a cheap shapes-free win.

- **Unlocks:** real in-Planning-board diagramming (architecture/flow sketches as first-class editable
  geometry); durable generated diagrams (the outline/CSV generator stops being demo-ware once arrows
  bind to shapes); a future home for thin UML/ERD/C4 notation **presets** — explicitly NOT bespoke
  per-type modes.
- **Cost:** **L** for a tight MVP (`ShapeElement` rect/ellipse/diamond/roundedRect + the
  `ArrowElement`→bound-connector upgrade using the 0..1 relative-anchor scheme, render-time resolution
  reusing `PreviewEdge.borderPoint()`); **XL** if it sprawls into stencils/UML-compartments/
  orthogonal-routing/alignment — which it MUST NOT.
- **Conditions:** (1) it reverses a LOCKED decision (ADR 0001 / CLAUDE.md) → **explicit user sign-off
  via a new ADR, not a silent build**; (2) sequence the anchored-arrows slice (M) as the de-risking
  first step; (3) **ship the Mermaid-element quick win FIRST to validate demand — if it satisfies the
  formal-diagram need, the shapes epic can stay deferred indefinitely.**

---

## Data-model changes (additive to `boardSchema.ts` unions; existing `SCHEMA_VERSION`+`MIGRATIONS`+assert discipline)

**Quick-win tier (shapes-free):**
1. **`MermaidElement`** → `PlanningElement` union: `{kind:'mermaid'; x;y;w;h; source:string}`. Additive
   new kind; bump `SCHEMA_VERSION 7→8` (after the v7 text-typography slice; see ADR 0004) + no-op migration;
   new assert case (finite x/y, positive w/h, string source). Source persists verbatim in `canvas.json`
   (strictly better than draw.io's embedded-XML-in-PNG); re-render is an explicit user action, never live.
2. **PNG export** — NO schema change; reuse `toObject`/`fromObject` as the embedded payload, add only
   an IPC handler.
3. **`z` field** — DELETE `BoardCommon.z` (`:31`) + createBoard/assertBoard/clone paths, OR honor it
   by mapping `board.z` → RF `node.zIndex` (no schema change, render only).
4. **`withChange`** — NO schema change; internal `canvasStore` refactor only. ✓ **Done** (shipped as `trackedChange`, PR #18 f7ffbbf).

**Shapes-epic tier (gated behind a new ADR + user sign-off):**
5. **`ArrowElement` upgrade** (currently `{kind:'arrow'; x;y;x2;y2}`) — add optional
   `from?:{id;ax;ay}` / `to?:{id;ax;ay}` (ax/ay 0..1 relative anchors = `exitX/exitY`), keep
   `x/y/x2/y2` as resolved fallback. Bump + additive migration; validate optional bindings in case
   `'arrow'`. Resolve at RENDER time via `resolveArrowEndpoints()` reading the target's live
   `x/y/w/h`. On delete of a bound element, orphan the binding (drop to fallback), mirroring
   `previewSourceId` cleanup. Optionally add `label?:{text;t;-1..1;offset}` (draw.io edge-label
   anchoring, resize-stable for free).
6. **`ShapeElement`** → `PlanningElement` union:
   `{kind:'shape'; shapeKind:'rect'|'ellipse'|'diamond'|'roundedRect'; x;y;w;h; text?; fill?; stroke?}`.
   Additive; bump + migration + new assert branch. Restrict arrow-binding TARGETS to elements with w/h
   (note, checklist, shape) — not point-only text/stroke.

**Explicitly DO NOT change:** (a) `CanvasDoc` keeps `{viewport, boards[]}` JSON — no mxfile XML, no
user-editable canvas-level `edges[]` unless a separate "user board connectors" feature is greenlit
(today canvas edges are 100% derived from `BrowserBoard.previewSourceId` in `previewEdges.ts` — keep
`PreviewEdge` derived; any future user edges = a DISTINCT edge type). (b) No stencil/style-string
fields, no `containers/parentId` (defer to Feature-Workspaces zones, which should use RF native
`parentId`+`extent`, not an mxGraph cell tree), no per-board XML blobs. (c) Heavy data goes to
`assets/` by path per the persistence rule, never inlined — consider rounding `StrokeElement` floats on
persist for diff hygiene.

---

*Method note: 4 parallel web-research facets → codebase grounding (Explore over the board model + RF
edge wiring) → per-finding adversarial feasibility verify (flagging `needs_shapes_epic` +
canvas-RF-vs-in-board) → prioritized synthesis. 50 agents, 44 raw findings → 36 feasible.
Sequencing and scheduling of the remaining slices is owned by `../roadmap-drawio.md`, which points
here as the why/how/risk reference. Cross-reference the Excalidraw whiteboard pass
(`../archive/2026-06-03-whiteboard-epic.md`): both passes converge on the shapes epic.*
