# Diagram / Visualization System — Review & Redesign Plan

**Date:** 2026-07-19 · **Status:** decision review — no implementation started
**Scope:** the Planning-board `DiagramElement` (Mermaid) subsystem + its MCP contract; touches the
Data-Flow board only as a related surface. Written against the actual repo at v0.22.x.

---

## 1. Current-state review

### 1.1 Correction to the brief's premise

The system does **not** render "plain, unstyled Mermaid." It renders **deliberately neutral,
design-token-themed Mermaid**: `diagramTheme.ts` maps the app's CSS custom properties
(`--surface`, `--text`, `--border-strong`, `--accent`…) into Mermaid `theme:'base'`
themeVariables — neutral surfaces, Geist, one accent, no rainbow — because the default Mermaid
palette violates the repo's explicit no-slop design contract (CLAUDE.md; DESIGN.md). The perceived
plainness is a *decision*, not an absence. What is genuinely missing is: **semantic color** (state/
category encoding), **animation**, and **any in-diagram interactivity**. Theming already follows
dark/light automatically (tokens are read live from `:root` at render time).

### 1.2 Stack (verified)

| Layer | Actual |
|---|---|
| Desktop shell | Electron 42, sandbox + contextIsolation everywhere, strict CSP (`script-src 'self'`, no eval in the app window) |
| UI | React 19 + TypeScript strict, electron-vite 5 / vite 7 |
| Canvas engine | **`@xyflow/react` (React Flow) v12 — already the app's core canvas** (every board is a custom RF node; ADR 0001, tldraw rejected on license) |
| Diagram engine | **Mermaid 11.15.0, vendored** single-file IIFE (`resources/diagram-worker/mermaid.min.js`, 3,312,967 bytes, jsdelivr-pinned + SRI). Not an npm dep; never in the renderer bundle |
| State | Zustand; JSON-per-project persistence (`.canvas/canvas.json`), two-tier schema versioning (ADR 0007) |

### 1.3 How a diagram works today (render pipeline)

```
MCP agent ──add_planning_elements {kind:'diagram', source}──► MAIN sanitize+cap (≤4000 ch)
                                                          ──► human confirm modal (full source shown, ADR-0003 discipline)
                                                          ──► renderer materializes DiagramElement (schema v11)
User (Planning toolbar 'd' tool / '</>'-toggle textarea) ──► same element, direct edit

DiagramElement { kind:'diagram', source, engine:'mermaid', w, h, svgCache? }   ← source is canonical
        │
        ▼  window.api.diagram.render({source, themeVars, id})  (IPC, frame-guarded)
Hidden sandboxed BrowserWindow (diagramWorker.ts) — the ONLY window with 'unsafe-eval'
  bridge.js: mermaid.initialize memoized per themeVars; securityLevel:'strict',
  htmlLabels:false, theme:'base', maxTextSize 50k, maxEdges 2000; parse → render → SVG string
  (serialized queue, 8s timeout → worker recycled)
        │
        ▼
SVG → content-addressed asset (.canvas/assets/<sha1>.svg, untracked write — never an undo step)
        ▼
DiagramCard displays it as an INERT <img src=blob:> — pointer-events:none
  card-level UX only: select, drag, resize, zoom/pan the *image*, edit-source textarea,
  inline parse-error ribbon
```

**Consequence that drives this whole review:** the diagram is a *picture*. No node is clickable,
draggable, collapsible, or animatable, because nothing of the diagram exists in the DOM — by design
(Mermaid has real XSS history, CVE-2025-67744 cited in the research docs; the inert-`<img>` +
hidden-worker + strict-CSP stack is the security answer).

### 1.4 The MCP contract today

- Server: sibling repo `M:\expanse\canvas-ade-mcp`, published as `@expanse-ade/mcp`, app pin
  **0.20.1** (`package.json`; note CLAUDE.md's stated pin `0.18.0-rc.7` is stale).
- Emit: `add_planning_elements` op `{ kind:'diagram', source: string, section? }` — **raw Mermaid
  text**, ≤4000 chars, control-chars stripped in MAIN (`mcpPlanning.ts`), whole batch ≤16 KB so the
  confirm modal stays human-reviewable.
- Update: `update_planning_element` patch `{ source }` — **whole-source replacement**. Incremental
  only at element granularity, never node/edge granularity. The agent re-emits the full diagram to
  change one label.
- Host adds smarts around the text: `diagramFootprint(source)` infers landscape/portrait card
  sizing from the Mermaid header; `diagramTypeLabel(source)` labels the card chip.
- Every write is human-confirm-gated; declined proposals change nothing; nothing drawn ever runs.

### 1.5 Adjacent surfaces (relevant, do not ignore)

- **Data-Flow board** (`DataFlowBoard.tsx`) — a second, *separate* in-house graph renderer:
  bespoke SVG edge layer + absolutely-positioned div cards (`DataFlowGraphView.tsx`), custom
  3-column layered layout (`graphLayout.ts` — dagre was evaluated and rejected as overkill for it).
  It infers entities from captured API traffic and **exports the ER model as a Mermaid
  `DiagramElement`** (`erMermaid.ts` → "→ Planning"). Proof-in-repo that a token-styled,
  cheap, DOM-native graph renderer works well here.
- **Source editor** — plain `<textarea>`; no CodeMirror Mermaid grammar wired (the lockfile's
  `codemirror-lang-mermaid` is an unused transitive of the langs barrel the code deliberately avoids).
- **e2e coverage exists**: `diagram.e2e.ts` (render, error, resize, ER contrast, source toggle),
  `mcpPlanning.e2e.ts` (agent-written diagram end-to-end), `dataFlow.e2e.ts` (ER export).

### 1.6 Constraints in play (all verified in-repo)

1. **Security posture is load-bearing and non-negotiable**: strict CSP, sandbox, agent content is
   attacker-influenceable by definition (ADR 0003 confirm-gate), SVG kept inert. Any interactive
   engine must render agent strings as **React text nodes, never markup**.
2. **Local-first / offline**: Mermaid vendored + SRI-pinned; no runtime CDN anywhere. A new engine
   must be bundled, not fetched.
3. **Bundle discipline** is a live convention (`fileBoardSyntax.ts` hand-picks grammars to avoid a
   103-grammar barrel). Mermaid's 3.3 MB is tolerated only because it stays out of the renderer
   bundle entirely (worker-window asset).
4. **Performance on a busy canvas**: many boards live at once; the app already paint-gates
   off-screen previews and caps live offscreen windows. Dozens of diagram cards must stay cheap —
   a full interactive editor instance per card, always mounted, is not acceptable.
5. **Schema discipline** (ADR 0007): new element fields/kinds follow the two-tier version rules;
   `engine: 'mermaid'` was explicitly pinned in v11 *"for future engines"* — the schema anticipated
   this redesign.
6. **Design contract**: calm, one accent, no gradient/glow. "Color encodes meaning" is compatible
   but must stay restrained.
7. **Deferred-epic gate**: the "whiteboard shapes" epic (drag-and-drop shapes) is deferred and
   locked behind: a new ADR + explicit user sign-off, anchored arrows first, and demonstrated
   Mermaid shortfall (`roadmap-drawio.md`). A drag-and-drop diagram palette re-opens that gate —
   it needs the ADR, not a silent reversal.
8. **Reject list already on record**: mxGraph/draw.io embedding (two-canvas trap), PlantUML,
   tldraw (license), Excalidraw (technical fit). Don't re-litigate these.

### 1.7 File map (diagram subsystem)

```
resources/diagram-worker/
  worker.html · bridge.js · mermaid.min.js (11.15.0, 3.3 MB) · mermaid.LICENSE.txt
src/main/
  diagramWorker.ts        hidden-window render host, queue, timeout, IPC 'diagram:render'
  csp.ts                  DIAGRAM_WORKER_CSP (scoped unsafe-eval) vs locked PROD_CSP
  mcpPlanning.ts          MAIN-side sanitize/caps for agent planning ops (incl. diagram source)
src/shared/mcpTypes.ts    PlanningOp {'diagram', source} · PlanningEditPatch {source}
src/renderer/src/
  lib/boardSchema.ts      DiagramElement (v11): source, engine:'mermaid', w, h, svgCache
  canvas/boards/planning/
    DiagramCard.tsx       card UX: inert <img>, zoom/pan, resize, textarea editor
    diagramTheme.ts       app tokens → Mermaid themeVariables; dialect label
    diagramResize.ts · diagramZoom.ts
  store/planningMcpApply.ts   op → element materialization, footprint, masonry layout
  — adjacent —
  canvas/boards/DataFlowBoard.tsx + osr/DataFlowGraphView.tsx   bespoke graph renderer
  lib/graphLayout.ts · entityInfer.ts · erMermaid.ts            custom layout · ER → Mermaid export
e2e/diagram.e2e.ts · mcpPlanning.e2e.ts · dataFlow.e2e.ts
docs/roadmap-drawio.md · docs/research/2026-06-15-planning-board-optimization/ · ADR 0001/0003/0007
M:\expanse\canvas-ade-mcp   sibling repo — MCP server source (@expanse-ade/mcp)
```

---

## 2. The decision

### Recommendation: **Direction C (hybrid pipeline), scoped — with Direction A's theming work shipped first as Phase 0**

Concretely: introduce a **structured diagram spec** (`engine:'expanse'`) rendered by an in-house,
token-native, animatable DOM renderer — while **keeping Mermaid 11 as a permanent second engine**
for the long-tail dialects (sequence, gantt, class, git, journey…) and as an import format. Not a
Mermaid replacement; a second engine behind the discriminator the schema already carries.

### Why C, in this codebase specifically

1. **The ceiling of A is structural, not cosmetic.** The inert-`<img>` display is the security
   model. Interactivity (click-to-focus, drag, collapse) requires live DOM, and putting *Mermaid's*
   live SVG into the app window means either relaxing the CSP/sanitization posture or re-auditing
   Mermaid output forever. A won't ever reach the stated interactivity goals.
2. **The renderer is nearly free here.** React Flow v12 is already the app's canvas engine (zero
   new bytes), and `DataFlowGraphView` proves the cheap static pattern (SVG edges + positioned
   divs, token-styled, ~600 lines). The expensive part of Direction B — adopting a graph canvas —
   is already paid.
3. **Structured spec is a *security upgrade*, not a cost.** Spec fields are short typed strings
   rendered as React text nodes — no `innerHTML`, no SVG sanitization question, no
   `unsafe-eval`, no hidden window for the new engine. The existing MAIN sanitize/cap + confirm
   pipeline extends field-by-field, and the confirm modal can finally show a *semantic diff*
   ("~ node `build`: status queued→running") instead of a wall of re-emitted Mermaid text.
4. **It fixes the MCP quality-compounding problem directly.** Today an agent re-emits the whole
   source to tick one node. A spec with stable node ids gives idempotent, incremental,
   human-reviewable ops — the exact `update_planning_element` read-then-update discipline the
   repo already enforces for checklists.
5. **The schema anticipated it** (`engine` field pinned in v11), and the Data-Flow board is a
   second consumer waiting to be unified onto the same model eventually.

### Rejected: Direction A alone (supercharge Mermaid)

*Would deliver:* semantic color (Mermaid `classDef`/themeCSS from tokens), better typography/
spacing, limited animation — CSS/SMIL animations declared inside SVG do run in Chromium `<img>`,
so animated edge dashes are feasible without any security change (verify in Electron 42 first).
*Why not as the destination:* no interactivity ever; per-dialect theming whack-a-mole against
Mermaid internals (the `rowOdd`/`rowEven` a11y fix in `diagramTheme.ts` is the existing evidence —
each dialect has private styling paths that shift across versions); MCP contract stays raw text.
*Disposition:* **not rejected as work — adopted as Phase 0.** It ships user-visible value in days
and everything (token mapping, worker, cache) is already in place.

### Rejected: Direction B (node-canvas replaces Mermaid; Mermaid = import/export only)

*Why not:* (a) Mermaid's breadth is load-bearing — agents emit sequence/ER/gantt today (ER export
from the Data-Flow board is a shipped feature); re-implementing those as interactive editors is
quarters of work with no payoff over a rendered image. (b) Text-as-source must stay first-class:
the `</>` textarea, the ≤16 KB confirm-modal reviewability premise, and "text is exactly the
modality an agent emits" (recorded rationale in the 2026-06-15 research) all argue for keeping a
text engine. (c) Full drag-and-drop editing as the *primary* interface re-opens the deferred
whiteboard-shapes epic wholesale — the locked gate says prove Mermaid's shortfall first.
*What survives from B:* the React-Flow-based interactive editor — as the **focused-mode editor for
`expanse`-engine diagrams only** (Phase 4), behind the required ADR.

### Tradeoffs accepted with C

- **Two engines to maintain.** Mitigated: Mermaid path is frozen-stable (vendored, pinned,
  e2e-covered) and gets only Phase-0 theming love; new features accrue to the spec engine only.
- **Not all diagrams become rich.** Sequence/gantt/ER stay static images. Accepted: the
  graph-class diagrams (flowcharts/state/architecture — the bulk of agent plan output) are where
  interactivity pays.
- **Mermaid→spec import is best-effort.** Flowchart-subset only, via Mermaid's own parser in the
  already-sandboxed worker (`getDiagramFromText().db` — semi-internal API, safe because the vendor
  file is pinned). Unconvertible sources simply stay `engine:'mermaid'`. Never lossy-in-place:
  conversion is an explicit action that keeps the original source in an `importedFrom` field.

---

## 3. Target architecture

### 3.1 Data model — `DiagramSpec` (engine `'expanse'`)

Design goals encoded: color-is-meaning via a closed `status`/`kind` vocabulary (host maps to
tokens — agents can never pick raw colors), stable ids for incremental updates, optional pinned
positions so auto-layout and hand-placement coexist.

```ts
/** schema bump: DiagramElement gains engine:'expanse' + spec (breaking → writer+floor per ADR 0007) */
interface DiagramSpec {
  version: 1
  title?: string
  direction: 'right' | 'down'            // layout main axis
  nodes: SpecNode[]                       // ≤ 200 (MAIN cap)
  edges: SpecEdge[]                       // ≤ 400
  groups?: SpecGroup[]                    // collapsible clusters
}
interface SpecNode {
  id: string                              // slug, ≤ 64 ch — the incremental-update key
  label: string                           // ≤ 200 ch, rendered as text node
  detail?: string                         // secondary line, ≤ 300 ch
  kind?: 'step' | 'decision' | 'data' | 'service' | 'artifact' | 'actor' | 'note'   // → shape/icon
  status?: 'neutral' | 'active' | 'done' | 'error' | 'warn' | 'muted'               // → color
  icon?: string                           // name into the HOST icon registry (Icon.tsx); unknown → none
  group?: string                          // SpecGroup id
  pos?: { x: number; y: number }          // user-pinned; absent ⇒ auto-layout owns it
  href?: { file: string; line?: number }  // click-to-open via existing File-board path (host-gated)
}
interface SpecEdge {
  id: string
  from: string; to: string                // node ids (dangling refs rejected in MAIN)
  label?: string                          // ≤ 120 ch
  kind?: 'flow' | 'data' | 'dependency'   // → line style
  status?: SpecNode['status']
  animated?: boolean                      // marching-dash flow animation (honors reduced-motion)
}
interface SpecGroup { id: string; label: string; collapsed?: boolean; status?: … }
```

Element persistence (schema v-next):

```ts
interface DiagramElement extends ElementCommon {
  kind: 'diagram'
  engine: 'mermaid' | 'expanse'
  source?: string        // mermaid engine: canonical text (unchanged today)
  spec?: DiagramSpec     // expanse engine: canonical model
  importedFrom?: string  // original Mermaid source when converted (never destroyed)
  w: number; h: number
  svgCache?: string      // mermaid engine only; expanse renders live
}
```

### 3.2 Render pipeline (expanse engine)

```
spec ──validate──► layout (ELK layered, in a Web Worker; only nodes without pos)
     ──► STATIC VIEW (default): the DataFlowGraphView pattern — SVG edge layer +
         absolutely-positioned token-styled divs. Cheap enough for dozens of cards.
         CSS transitions animate node position/status changes (layout morph = FLIP on
         top/left), entrance = stagger fade/rise, edge flow = stroke-dashoffset keyframes.
         All gated on prefers-reduced-motion (matchMedia; also an app setting).
     ──► FOCUS MODE (selected/expanded, Phase 4): swap the static view for a nested
         React Flow instance (separate ReactFlowProvider; the .nowheel/.nopan carve-out
         DiagramCard already uses) — drag nodes (writes pos, one undo step per drag),
         collapse groups, click-to-focus dims non-neighbors, palette drops new nodes.
```

Key calls:

- **Static-by-default, editor-on-focus** satisfies the canvas-perf constraint (constraint 4): an
  unfocused diagram costs a handful of divs, like Data-Flow today. No always-mounted RF instances.
- **No hidden worker, no SVG cache, no `unsafe-eval` for expanse diagrams** — the renderer is
  plain React over typed strings. The diagram worker remains for Mermaid only.
- **Layout: ELK (elkjs) in a Web Worker**, chosen over dagre (§4). Deterministic input →
  deterministic output; layout runs off-thread so a 200-node graph never janks the canvas.
- **Theming: one tokens→spec-style bridge module** (`specTheme.ts`, sibling of `diagramTheme.ts`):
  maps `status`→color (done=muted green tint, error=red, active=the one accent, warn=amber,
  muted=low-contrast) and `kind`→shape/icon, all derived from `index.css` tokens so dark/light and
  future restyles flow through automatically. Agents never see color names.

### 3.3 MCP contract v2 (the compounding loop)

New/extended tools in `@expanse-ade/mcp` (sibling repo; remember the publish-coupling: npm publish
→ app pin bump → `pnpm install`, per the established pipeline):

1. **Emit**: `add_planning_elements` gains
   `{ kind:'diagram', engine:'expanse', spec: DiagramSpec }` (existing raw-Mermaid form stays).
   MAIN validates structurally: id format, closed enums, per-field char caps, node/edge counts,
   dangling-edge rejection, total-bytes cap (the 16 KB confirm-reviewability premise holds — a
   spec is *denser* than Mermaid text).
2. **Incremental update**: `update_planning_element` patch gains
   `specOps: SpecOp[]` where
   `SpecOp = {op:'upsertNode',node} | {op:'removeNode',id} | {op:'upsertEdge',edge} |
   {op:'removeEdge',id} | {op:'upsertGroup',group} | {op:'removeGroup',id} | {op:'setMeta',title?,direction?}`.
   Upserts are idempotent by id; ops apply in order; the whole batch is one undo step and one
   confirm. The agent loop becomes: read `canvas://board/{id}/planning` (returns the spec incl.
   ids) → send the minimal delta — same read-then-update discipline the repo mandates for
   checklists.
3. **Confirm rendering**: MAIN renders a semantic diff for the modal —
   `+ node "deploy" (step, neutral)` / `~ node "build": status active→done` / `− edge build→test`.
   Strictly better human review than re-reading 4000 chars of Mermaid.
4. **Migration nudge in the tool docs**: prefer `engine:'expanse'` for flow/state/architecture
   diagrams; keep raw Mermaid for sequence/gantt/ER. Old agents keep working untouched.

---

## 4. Library / tech evaluation

Sizes approximate (min+gz) except the measured vendored file. "Cost here" = *marginal* cost to
this app.

| Option | Size | Cost here | Layout | Animation | Interactivity | License | Verdict |
|---|---|---|---|---|---|---|---|
| **Mermaid 11.15 (vendored)** | 3.3 MB raw file | **0 (paid)** — worker asset, not in bundle | built-in per dialect | CSS/SMIL-in-`<img>` only | none (inert image) | MIT | **Keep** as engine #2 + importer |
| **@xyflow/react 12** | ~45 KB | **0 (already bundled)** — app's canvas engine | none (BYO) | CSS/React, first-class | pan/zoom/drag/select, nested-flow support | MIT | **Use** for focus-mode editor |
| Static DOM renderer (in-house, DataFlowGraphView pattern) | ~0 | small, pattern proven in-repo | BYO | full CSS control | click/hover cheap | — | **Use** as default view |
| **elkjs** (layout) | ~350 KB gz (bundled ELK) | new dep; Web-Worker-friendly, lazy-chunk | best-in-class layered; ports, groups | n/a | n/a | EPL-2.0 (dep-safe) | **Adopt** (lazy-loaded) |
| @dagrejs/dagre (layout) | ~25 KB | tiny | decent DAG, weak with groups/ports | n/a | n/a | MIT | Fallback if elkjs weight stings; groups matter → ELK first |
| tldraw | large | license key + watermark + ~$6k/yr | — | — | excellent | proprietary-ish | **Rejected** (ADR 0001, stands) |
| Svelte Flow | — | wrong framework (React 19 app) | — | — | — | MIT | Reject |
| Rete.js | ~100 KB+ | dataflow-programming editor, concept mismatch | plugin | plugin | node-editor | MIT | Reject |
| JointJS+ | large | commercial for the useful tier | good | good | good | MPL/commercial | Reject (license posture) |
| Cytoscape.js | ~120 KB | canvas-rendered → token/CSS theming awkward, not React-native | many | limited | analysis-oriented | MIT | Reject |
| G6 (AntV) | ~500 KB | overlaps RF; churny API surface | good | good | good | MIT | Reject (redundant with RF already paid) |

---

## 5. Phased roadmap

Effort keys: S ≈ days · M ≈ 1–2 wk · L ≈ 2–4 wk. Each phase independently shippable; every phase
follows house rules (plan-viz board first, design artifact before UI code, version bump, e2e gate).

**Phase 0 — Mermaid polish (Direction A as a floor). S.**
Semantic `classDef` palette generated from tokens (status classes agents can reference in Mermaid
today), typography/spacing themeVariables pass, optional edge-flow animation via CSS injected into
the SVG (verify CSS-animation-in-`<img>` in Electron 42 first; skip entirely under
reduced-motion), CodeMirror Mermaid highlighting in the source editor (grammar already in the
tree — import it directly, not via the barrel). No schema change, no MCP change.
*Milestone: agent-emitted Mermaid visibly on-brand + optionally alive.*

**Phase 1 — Spec + schema + static renderer. M.**
`DiagramSpec` types + validators (shared module), schema bump (`engine:'expanse'`, `spec`,
`importedFrom`; breaking → writer+floor), `specTheme.ts`, ELK worker, static view in DiagramCard
(render-only: no editing beyond existing card affordances). Unit tests mirror the
`boardSchema`/`planningMcpApply` test discipline.
*Milestone: a hand-authored spec renders themed, laid-out, dark/light, offline.*

**Phase 2 — Motion + focus. M.**
Entrance stagger, FLIP layout-morph on spec change, edge-flow animation, click-to-focus
(dim non-neighbors), group collapse/expand — all in the static renderer; reduced-motion +
app-setting gate.
*Milestone: diagrams animate on update; a status flip visibly pulses the changed node.*

**Phase 3 — MCP contract v2. M (cross-repo).**
Spec emit + `specOps` incremental patch in `@expanse-ade/mcp`; MAIN validation + semantic-diff
confirm body; `canvas://board/{id}/planning` returns specs; publish → pin bump → e2e
(`mcpPlanning.e2e.ts` extension). Mermaid→spec importer (flowchart subset, in the existing worker)
as an explicit convert action.
*Milestone: agent ticks one node's status with a 3-line op; human confirms a readable diff.
This is where quality starts compounding.*

**Phase 4 — Interactive editing + palette. L. ⚠ Gate: requires the whiteboard-shapes ADR + explicit user sign-off (locked decision).**
Focus-mode nested React Flow editor: drag nodes (persist `pos`, lazy undo checkpoint per drag, the
DiagramCard resize discipline), edge re-route, icon/shape palette (host Icon registry), inline
label editing. Design artifact (mock) before code, per convention.
*Milestone: drag-and-drop diagram editing without ever leaving the calm-UI contract.*

**Phase 5 (optional) — unify Data-Flow onto the spec renderer; extraction prep. M.**
`DfGraph → DiagramSpec` adapter; delete one bespoke renderer; battle-test the API for §6.

---

## 6. Open-source packaging

**Verdict: worth doing, but only after Phase 3 stabilizes the spec and Phase 5 proves the API with
a second consumer.** Extracting earlier freezes an API that hasn't survived contact.

- **Package:** e.g. `@expanse-ade/diagram` — the spec types + validator, ELK layout adapter,
  static renderer components, theme bridge (token-name → CSS-var indirection), motion presets.
  Peer deps only: `react`, `elkjs` (and `@xyflow/react` for the optional editor subpath export).
  Dependency-light by construction; no Electron, no Mermaid.
- **Stays app-specific:** the Mermaid engine + worker + CSP machinery, asset cache, MCP
  validation/confirm pipeline, schema migration, DiagramCard chrome (drag/resize/undo wiring).
- **Honest niche check:** "Mermaid-to-React-Flow" converters exist; the differentiated surface is
  the *semantic, token-themed, animatable spec* + incremental-update contract designed for
  agent/MCP emission. That's the pitch; it's real but modest — treat extraction as a
  nice-to-have, not a driver of architecture (the architecture above is justified app-internally).
- **License: MIT** — matches the dependency chain (RF MIT, elkjs EPL-2.0 is fine as a peer dep)
  and the repo's own posture (tldraw was rejected *because* of license friction; don't recreate it).
- Publish pipeline can clone the existing sibling-repo OIDC trusted-publishing setup.

---

## 7. Risks & open questions

**Risks**

1. **Mermaid internal parser API** (`getDiagramFromText().db`) is semi-internal → importer breaks
   on a Mermaid bump. Mitigation: vendor file is pinned + SRI'd; importer is best-effort and
   isolated in the worker; a failed import just leaves the element as `engine:'mermaid'`.
2. **Nested React Flow event handling** (focus mode) — wheel/drag capture inside an RF node.
   Mitigation: DiagramCard already ships the `.nowheel/.nopan` + pointer-capture pattern; e2e it.
3. **elkjs weight** (~350 KB gz) creeps the renderer bundle. Mitigation: dynamic-import chunk
   loaded on first expanse-diagram render; measured in the bundle-size check.
4. **Schema floor bump** locks older app builds out of new docs (ADR 0007 accepted cost —
   same as v11 itself). Batch the bump into one PR.
5. **Confirm-gate erosion**: structured ops must never become rubber-stampable. The semantic diff
   must show *every* changed field; byte-cap stays.
6. **Undo semantics** for drag/edit interleaved with agent `specOps` — define op-application as one
   tracked commit, drags as one checkpoint per gesture (existing card discipline), and test
   undo/redo across both.
7. **Two-engine drift**: e2e must pin that both engines respect tokens (extend the ER-contrast
   test pattern to the spec renderer).
8. **CSS-animation-in-`<img>` assumption (Phase 0)** — verify in Electron 42 before promising;
   if frozen, Phase-0 animation drops and motion waits for Phase 2 (spec renderer owns it anyway).

**Open questions**

1. **Dialect census**: what do agents actually emit? Grep real `.canvas/canvas.json` corpora for
   diagram headers before sizing the importer (if ~90 % flowchart, importer scope shrinks).
2. **Sequence diagrams interactive ever?** Current stance: no — stays Mermaid. Revisit only on
   demonstrated need (the roadmap-drawio gate logic, reused).
3. **Icon vocabulary**: extend the hand-drawn `Icon.tsx` set (on-brand, effort) vs. vendor a
   subset of Lucide (fast, licensing fine, style drift)? Needs the design-artifact step.
4. **Where does `spec` live for very large graphs** — inline in `canvas.json` vs. `.canvas/assets`
   sidecar? Inline is fine under the 200/400 caps; decide only if caps ever lift.
5. **Data-Flow unification timing** (Phase 5) — worth it for deletion of `graphLayout.ts` +
   `DataFlowGraphView.tsx`, but Data-Flow's ephemeral/derived model may not want persistence
   semantics; adapter design open.
6. **Does `visualize_plan` grow a `diagram` suggested-shape** (spec-emitting) alongside
   checklist/kanban? Natural Phase-3 extension; needs MCP-side design.

---

*Process note: per repo convention this doc belongs on the feature's `feat/*` worktree branch when
work starts (docs live with their feature). It is deliberately left uncommitted here.*
