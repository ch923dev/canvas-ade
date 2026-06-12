# Research — Visual Spec Output: a source-owned, themed Diagram element

> **Status:** research / proposal (no code). **Date:** 2026-06-05. **Method:** 5-thread parallel
> read-only research workflow (render-tech · competition · beautiful-design · UX · internal-feasibility)
> + synthesis. **Scope:** a CLI coding agent emits its work **visually** on the canvas — the harness
> flow **spec → plan → implement** becomes *visible* — centered on a **source-owned, brand-themed
> diagram primitive** (the agent and the human author mermaid SOURCE; the app renders it to a themed
> SVG; re-renderable + editable, NOT a flattened screenshot).
>
> **Relationship to other docs:** this is the **simplified, higher-leverage v1** the orchestrator-harness
> research (`docs/research/2026-06-05-orchestrator-harness.md`, PR #71) pointed at. It drops the swarm
> (orchestrator/roles/multi-agent dispatch) and keeps the most valuable, most *visible* core: agent →
> canvas authoring. PR #71 stays open as the someday-map. This feature can proceed in parallel with the
> MCP swarm work.

---

## TL;DR

- **Feasible, beautiful, and ~80% reuses existing infra** (the Planning element model + asset store +
  full-view + SVG/PNG export pipeline). The new primitive is a **`diagram` element** (mermaid source +
  cached themed SVG) on the Planning board.
- **One assumption was overturned by the research:** mermaid must **NOT** be rendered in MAIN via a
  jsdom/svgdom shim — that path silently breaks text-measurement for every diagram type except basic
  flowcharts. The robust path is a **hidden BrowserWindow render-worker** (real Chromium, scoped CSP,
  zero new deps). This is the single most important technical decision below.
- **"Make it ours" = theming** — `theme:'base'` + full `themeVariables` mapped to our design tokens +
  **ELK orthogonal layout**. That turns off-brand default-purple mermaid into Linear/Vercel-grade
  diagrams that match the app. This is the differentiator, and it's cheap.
- **The market white space is real.** Eraser / Napkin / Whimsical / Claude artifacts each do *part* of
  this; **nobody** ships agent-authored, brand-themed, source-owned diagrams living *inside an IDE
  canvas next to the terminals that implement them*, with spec→plan→implement as spatial boards.
- **Coordination flag:** the schema bump is **v6** (MCP M2, the other session, takes v5) and
  `boardSchema.ts` is a shared file — declare the cross-zone on `ACTIVE-WORK.md` before implementing.

---

## 1. Render architecture — the load-bearing decision

### 1.1 Why mermaid can't run in our renderer

The app's CSP has **no `'unsafe-eval'`** (`src/main/csp.ts`; prod `script-src 'self'`), and the window
is `sandbox:true` / `contextIsolation:true` / `nodeIntegration:false` (`src/main/windowSecurity.ts`).
Mermaid v11 has **two** CSP problems: (a) v11 lazy-loads diagram-type chunks via dynamic `import()` —
blocked by strict `script-src`; (b) its dagre layout engine uses `new Function()` (= `eval`) — blocked
without `'unsafe-eval'`. Renderer-side mermaid is therefore impossible without weakening the locked
security model. (Refs: Roo-Code #3680, streamdown #344, Mozilla bug 1607143.)

### 1.2 Ranked options (where to render)

| Rank | Option | Verdict |
|---|---|---|
| **1 ✅** | **Hidden BrowserWindow render-worker** — `show:false` window with its OWN permissive CSP (`script-src 'self' 'unsafe-eval'`), loads mermaid + `@mermaid-js/layout-elk` normally, renders via real Chromium, returns the SVG string over IPC. **Zero new deps** (Electron's own Chromium). Full fidelity, all diagram types, ELK web-workers work, text-measurement correct. Main window CSP stays fully locked. ~300ms cold boot once (keep-alive), ~2–5ms warm. Same isolation model Obsidian/VS Code use. | **RECOMMENDED** |
| 3 ✗ | jsdom/svgdom/happy-dom shim in MAIN (the earlier "cheap path") | **NOT production-grade** — `getComputedTextLength()` is stubbed → wrong auto-sizing for sequence/ERD/class/state; ELK web-workers don't run in Node; mermaid v11 ESM+chunks fragile in Node. Works for basic flowcharts only. |
| ✗ | `UtilityProcess` (Node) | Same text-measurement breakage as the shim — no DOM. |
| ✗ | `mermaid-isomorphic` (Playwright) | Correct, but ships a 2nd Chromium (~200MB) on top of Electron's. Absurd for desktop. |
| ✗ | mermaid-cli (`mmdc`, Puppeteer) spawn | Slow (~1–2s), heavy. |
| ✗ | pre-render at build | Can't live-re-render on source edit. |

**Decision: a dedicated hidden BrowserWindow render-worker** (`mermaid` v11 + `@mermaid-js/layout-elk`).
The worker loads only a local file, never network content, exposes no privileged IPC, and returns an
SVG string that is sanitized + displayed via `<img>` (inert). This is the one place a scoped
`'unsafe-eval'` is acceptable — an invisible window with no user-reachable attack surface.

### 1.3 Robustness checklist

- `mermaid.initialize()` once at worker boot with the full themed config (§3) + `securityLevel:'strict'`.
- Register `@mermaid-js/layout-elk`; default `layout:'elk'` for flowchart/state.
- Vite `manualChunks` to bundle mermaid as one chunk (kills the lazy-chunk CSP fetch even in the worker).
- Debounce source edits ~400ms before re-render; **LRU cache keyed on `sha1(source+config)`** in MAIN.
- On parse error: keep the **last-good SVG**, show a friendly inline error (don't blank the preview).
- Parse `viewBox` → store intrinsic `{w,h}`; display via `<img>` with `object-fit:contain` (vector stays
  crisp at any board zoom — never rasterize except for PNG export).
- DOMPurify the SVG (svg profile) before display = defense-in-depth.

### 1.4 Security — the cautionary precedent

**CVE-2025-67744** (CVSS 9.6): DeepChat, an Electron AI app, got **XSS→RCE** because it rendered
agent-emitted mermaid with `securityLevel:'loose'` and exposed privileged IPC to the rendering context.
Our defenses: **never `loose`** (use `strict`); render in the isolated worker (no privileged IPC); display
the result via `<img>` (scripts in an SVG loaded as an image do **not** execute); `img-src 'self' data:
blob:` already blocks external loads. (Refs: Sentrium Security write-up; OneUptime GHSA-wvh5-6vjm-23qh.)

---

## 2. Competition — how others turn agent output into diagrams, and the white space

### 2.1 The three "beautiful" poles

1. **Editorial** (Napkin.ai) — infographic-quality, brand-matched, multi-layout; prose→visual; **no
   code/agent integration**. The prettiest output in the market.
2. **Code-beauty** (D2, Eraser) — diagram-as-code with pro auto-layout + dark themes; D2 beats mermaid
   on default aesthetics; Eraser adds AI generation + a doc-canvas.
3. **Canvas-beauty** (Excalidraw, Whimsical, tldraw) — editable shapes on an infinite canvas, agent- or
   human-writable. `mermaid-to-excalidraw` bridges code→canvas.

### 2.2 Closest rivals + their gaps

| Tool | What it does | Gap vs Canvas ADE |
|---|---|---|
| **Eraser** (DiagramGPT + Eraser AI) | AI generates diagram-as-code DSL from code/prose; source-owned + editable; doc+diagram canvas | no IDE/terminal; proprietary DSL (not mermaid); limited theming (3 color × 3 style modes); no spec→implement |
| **Napkin.ai** | prose → beautiful editable visuals; 700+ fonts, brand styles | no agent/MCP/code input at all; pure marketing-doc lane |
| **Whimsical + MCP** | Claude/Cursor write diagrams to the board over MCP; codebase viz | not an IDE; fixed visual language; no spec→plan linking |
| **Claude.ai artifacts / Claude Code** | renders agent mermaid inline | Claude Code mermaid render is **requested but unshipped** (issues #14375, #20529 OPEN); no brand theme; stateless |
| **tldraw + agent** | agent reads/writes shapes via API + screenshot context | no diagram-as-code primitive; no theming; no spec workflow |

### 2.3 White space (none do all of these together)

Agent emits **mermaid source** (not a blob) → stored re-renderable → rendered with **custom brand
theme** → living **inside the IDE canvas next to the terminals/browsers that implement it** →
**spec→plan→implement** as spatially-linked boards → planning output (checklist/dep-graph) visually
adjacent to the architecture diagram → human can edit the source in place (or "promote to freehand").
**This is exactly Canvas ADE's slot.**

### 2.4 Borrowable ideas (named)

1. **mermaid-to-excalidraw "Make editable"** button — `parseMermaidToExcalidraw()` →
   `convertToExcalidrawElements()` turns a flowchart into editable freehand shapes (image fallback for
   other types). Closes the "source-owned AND freehand-editable" loop. (`excalidraw/mermaid-to-excalidraw`)
2. **Eraser's clarifying-question refinement loop** — agent asks "sequence or architecture? data-flow or
   call-flow?" before committing the diagram.
3. **Napkin's "pick a variant"** — show small previews (seq / arch / ERD) of the same content; human
   picks; keeps agent output non-committal until chosen.
4. **Swimm's live-code-token tracking** — diagram node tracks `src/foo.ts:FooClass` and goes green/red as
   the implementation lands. Powerful for the Implement phase.
5. **Whimsical's MCP-native write path** — expose the diagram board as an MCP surface so *any* agent
   (Claude Code/Cursor) can push mermaid source to a named board → Canvas ADE becomes the "diagram sink."
6. **D2 as a premium alt later** — cleaner default aesthetics + **renders headless via WASM in Node (no
   Chromium)**; but LLMs emit mermaid natively, so mermaid is primary and D2 is an opt-in for
   human-authored architecture. (Flag: D2's node-WASM path is thinly documented — treat as exploratory.)

---

## 3. "Make it ours" — the beautiful-diagram style spec

Key off the authoritative tokens (`src/renderer/src/index.css` + `exportColors.ts`): `--void #0a0a0b`,
`--surface #141416`, `--surface-raised #1a1a1d`, `--inset #0e0e10`, `--text #ededee`, `--text-2 #9b9ba1`,
`--accent #4f8cff`, Geist / Geist Mono.

### 3.1 Layout = ELK (80% of "premium")

- Use **`@mermaid-js/layout-elk`** (`elk.layered`), **orthogonal edge routing**, `BRANDES_KOEPF` node
  placement. Dagre (mermaid default) is unmaintained since 2015 and looks amateur; orthogonal routing
  (H/V segments, no diagonals) is the Linear/Vercel/Stripe/UML signature that reads as engineering-grade.
- Spacing: `nodeNode 40`, `nodeNodeBetweenLayers 60`, `edgeRouting ORTHOGONAL`. Fit to board: strip root
  `width/height`, set `viewBox` + 16px pad, `preserveAspectRatio="xMidYMid meet"`.

### 3.2 One-accent color discipline

The accent does all the semantic work; everything else is structured grayscale; color appears only when
it carries meaning (the Linear/Geist principle). **`#4f8cff` appears ONLY as a node border / critical
edge / the `--accent-wash` highlight fill — never as a solid node fill.** No gradients, no glow (the only
elevation allowed is the existing true-black `--shadow-board`).

| Element | fill | stroke | text |
|---|---|---|---|
| Default node | `#1a1a1d` | `~#2e2e34` | `#ededee` |
| Active/highlighted | `rgba(79,140,255,0.14)` | `#4f8cff` | `#ededee` |
| Cluster/container | none | `1px dashed ~#1e1e24` | `#6a6a70` title (uppercase, 0.06em) |
| Default edge | — | `~#2e2e34` 1.5px | — |
| Critical edge | — | `#4f8cff` 1.5px | — |
| Edge label bg | `#141416` (never mermaid's default white) | — | `#9b9ba1` |

### 3.3 Mermaid `themeVariables` (the recipe)

`theme:'base'` + `darkMode:true` (the built-in `dark` theme hardcodes purple and can't be fully
overridden; **only `base` is fully customizable, and it accepts hex only — no CSS vars**). Map
`background #141416`, `mainBkg #1a1a1d`, `nodeBorder #2e2e34`, `clusterBkg #0e0e10`, `lineColor #3a3a42`,
`primaryTextColor #ededee`, `secondaryTextColor #9b9ba1`, `activationBorderColor #4f8cff`,
`activationBkgColor rgba(79,140,255,0.14)`, `noteBkgColor #16202b`, `fontFamily 'Geist, system-ui'`,
`fontSize 12px`. (Embed Geist as `@font-face` in the worker HTML, else SVG text falls back to system.)

### 3.4 Polish

- Card enter / re-render: `opacity 0→1` + `scale 0.99→1`, 180ms `cubic-bezier(0.2,0.7,0.2,1)` (reuse the
  full-view pattern; gate on `prefers-reduced-motion`). Cross-fade old→new SVG on re-render.
- 10px font floor; truncate labels > ~22 chars. Contrast: all data text ≥ AA (`#6a6a70` only for
  non-informational titles — fails AA, never for data labels).

---

## 4. UX / interaction

### 4.1 Element-first, board later

**Add a `diagram` element kind to the Planning board** — do NOT build a new board type yet. The Planning
board already provides positioning, drag, select, group, lock, duplicate, full-view, and SVG/PNG export
for free; `ImageElement`+asset store is a direct template (a diagram is an image element + `source`). A
spec = diagram + prose + tasks → composing them on one Planning board is natural.

**Promote to a dedicated `Spec` board type only when** (observable triggers, not speculation): the diagram
needs its own title-bar tool cluster that conflicts with the planning tools · specs become
diagram-dominated · full-view needs diagram-specific chrome · the agent emits multiple diagrams per spec
that want a board-level outline/tabs.

### 4.2 Source ↔ preview

Default = **preview** (themed SVG, like ImageCard). A `</>` badge (or double-click) enters **source mode**
— a `--mono` textarea + an inline error bar that **keeps the last-good render visible** on parse failure
(D2-playground discipline). Debounced re-render ~400–800ms; exit on Escape/outside-click. The human edits
**mermaid text** (the canonical form); the agent also writes mermaid text. No WYSIWYG editor in v1.

### 4.3 Diagram types — priority

Ship **flowchart · sequence · ERD** first (90% of software specs, simplest source for an agent to emit
correctly). Auto-detect type from the source's first keyword (`graph`/`flowchart`, `sequenceDiagram`,
`erDiagram`) → a small type badge (`FLOW`/`SEQ`/`ERD`). Add **state** when the agent emits state-machine
reasoning; **C4/class/gantt/mindmap** later.

### 4.4 Composing a visual spec + linking

Canonical layout the agent emits in **one `commit()`**: DiagramCard (large, top, ~480×320) +
NoteCard (context, bottom-left) + ChecklistCard (tasks, bottom-right) + Arrow elements connecting them;
board auto-grows (`growBoardHeight`). **Node↔task linking** — start Tier 1 (spatial proximity + an arrow,
free); Tier 2 (label-match highlight); Tier 3 (`nodeId?` on `ChecklistItem`, schema change) only if the
workflow proves it needs the data link. A node can carry a `%% boardId: <id>` annotation → clickable
hotspot that navigates the canvas to a worker board (annotation-driven, no connector schema change).

---

## 5. Internal feasibility — the net-new change-set (app-only)

Reuses the existing element/asset/export pipeline almost entirely. Render backend = the hidden-window
worker from §1 (NOT the happy-dom-in-MAIN sketch — that's the fragile path).

| Item | Status | Location |
|---|---|---|
| `DiagramElement {kind:'diagram', source, engine:'mermaid', svgCache?:assetId, w, h}` + `DiagramEngine` | NET-NEW | `boardSchema.ts` |
| `PlanningElement` union += `DiagramElement` | MODIFY | `boardSchema.ts` |
| `assertPlanningElement` `case 'diagram'` | MODIFY | `boardSchema.ts` (before the throwing `default`) |
| `SCHEMA_VERSION 5 → 6` + no-op migration | MODIFY | `boardSchema.ts` (**v5 is reserved by MCP M2 — must be v6**) |
| `makeDiagram()` factory + `elementBBox` case | NET-NEW/MODIFY | `planning/elements.ts` (copy `makeImage`) |
| `DiagramCard.tsx` (preview = ImageCard pattern + `</>` source mode) | NET-NEW | `planning/DiagramCard.tsx` |
| element-loop `case` + `onCacheUpdate`/`onSourceChange` patches | MODIFY | `PlanningBoard.tsx` |
| `renderElement` `case 'diagram'` (embed cached SVG) | MODIFY | `whiteboardExport.ts` |
| `gatherAssets` collect `diagram.svgCache` | MODIFY | `exportBoard.ts` |
| `collectAssetIds` collect `diagram.svgCache` (GC) | MODIFY | `projectStore.ts` |
| **Render worker**: hidden BrowserWindow + `render-worker.html` (scoped CSP) + `diagramRenderer.ts` (boot/keep-alive/render/cache) | NET-NEW | `src/main/` |
| `planning:renderDiagram(source,engine) → {assetId,w,h}|{error}` IPC (frame-guarded) | NET-NEW | `src/main/projectIpc.ts` |
| `window.api.planning.renderDiagram` bridge | MODIFY | `src/preload/index.ts` (+ `index.d.ts` derives) |
| `WhiteboardSvg.tsx` · `csp.ts` (main) · `windowSecurity.ts` · `electron-builder.yml` · `electron.vite.config.ts` | NO CHANGE | mermaid is pure-JS; render-in-worker needs no main-CSP relax / no asarUnpack |

### 5.1 Gotchas (must-not-miss)

1. **Validator + migration in one commit** — `assertPlanningElement`'s `default` throws; a v6 file in an
   old renderer crashes on load.
2. **GC + export must include `diagram.svgCache`** — else project-open sweeps the rendered SVG (forces
   re-render every open) and export drops the diagram.
3. **Undo discipline** — background `onCacheUpdate` (render completing) must be **silent** (a
   `patchElementSilent`/`growBoardHeight`-style action, no undo step); only user source-edits checkpoint
   via `beginChange`. Clear `svgCache` **atomically** with the source change (one patch).
4. **DOM-global cleanup** — if any node-side DOM is touched, reset `globalThis.document/window` per call
   (MAIN is single-threaded, IPC serialized — but don't leak). N/A for the hidden-window path.
5. **`<img>` display, not `innerHTML`** — keeps SVG inert; switching to inline-SVG later requires DOMPurify.

---

## 6. Phasing

- **Slice 1 — render + element MVP:** hidden-window render-worker + themed config (§3) + `diagram`
  element (flowchart/seq/ERD) + DiagramCard preview/source + export/GC wiring. Demo: paste/emit mermaid →
  themed diagram on a Planning board, editable, exportable.
- **Slice 2 — agent authoring:** `add_diagram(boardId, source, title)` MCP tool (the `author` tier +
  `.mcp.json` bootstrap from the agent-canvas-authoring research) → an agent writes its spec diagram to
  the board. Composes with `add_task`/`add_note` (the visible spec).
- **Slice 3 (optional):** "Make editable" (mermaid-to-excalidraw) · variant-picker · D2 engine · live
  code-token tracking · dedicated Spec board type.

---

## 7. Decisions, risks, open questions

### Decisions
- **Render in a hidden BrowserWindow worker** (NOT jsdom-in-MAIN). Scoped `'unsafe-eval'` on the invisible
  window only; main window CSP unchanged.
- **Source-owned** (`source` is canonical, SVG is a cache), **`theme:'base'` + token map + ELK** — "ours".
- **`diagram` element on the Planning board first**; promote to a `Spec` board type on observable triggers.
- **Mermaid primary** (LLMs emit it natively); **D2 later** as a premium opt-in.
- **flowchart/sequence/ERD** first.

### Risks
- mermaid `loose` → RCE (CVE-2025-67744): mitigated by `strict` + isolated worker + `<img>`.
- Render-worker lifecycle (boot cost, crash recovery): keep-alive one worker, restart on crash, queue
  renders.
- ELK spacing race in the mermaid bridge (#1312): prefer native ELK property names.

### Open questions
1. Worker model: one shared keep-alive render window vs spawn-per-render (lean: one keep-alive).
2. Editability: ship the `</>` source editor in Slice 1, or preview-only first?
3. `add_diagram` confirm tier: canvas-write is outside the lethal-trifecta (no exec) → likely no confirm,
   like `write_result`. Confirm against the agent-canvas-authoring research.
4. **Schema coordination:** v6 + `boardSchema.ts` is shared with the MCP M2 session → sequence the bump
   on `ACTIVE-WORK.md`.

---

## 8. Sources

**Render/tech:** [Mermaid usage](https://mermaid.js.org/config/usage.html) ·
[theming](https://mermaid.js.org/config/theming.html) ·
[layout-elk](https://www.npmjs.com/package/@mermaid-js/layout-elk) ·
[Roo-Code CSP #3680](https://github.com/RooCodeInc/Roo-Code/issues/3680) ·
[svgdom SSR #6634](https://github.com/mermaid-js/mermaid/issues/6634) ·
[DeepChat XSS→RCE (Sentrium)](https://www.sentrium.co.uk/labs/deepchat-ai-agent-xss-to-rce-via-mermaid-and-electron-ipc) ·
[Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window) ·
[D2](https://github.com/terrastruct/d2) · [D2.js arch](https://deepwiki.com/terrastruct/d2/8.1-d2.js-architecture).

**Competition:** [Eraser AI](https://www.eraser.io/ai) · [DiagramGPT](https://www.eraser.io/diagramgpt) ·
[Napkin](https://www.napkin.ai/) · [Whimsical AI](https://whimsical.com/ai) ·
[mermaid-to-excalidraw](https://github.com/excalidraw/mermaid-to-excalidraw) ·
[Claude Code mermaid #14375](https://github.com/anthropics/claude-code/issues/14375) ·
[tldraw agent](https://tldraw.dev/starter-kits/agent) · [Swimm mermaid](https://swimm.io/blog/create-up-to-date-diagrams-with-swimm-s-mermaid-integration) ·
[Mermaid vs D2](https://aaronjbecker.com/posts/mermaid-vs-d2-comparing-text-to-diagram-tools/).

**Design:** [Mermaid themeVariables](https://mermaid.js.org/config/schema-docs/config-properties-themevariables.html) ·
[ELK spacing (Eclipse)](https://eclipse.dev/elk/documentation/tooldevelopers/graphdatastructure/spacingdocumentation.html) ·
[orthogonal layout (yFiles)](https://www.yfiles.com/the-yfiles-sdk/features/automatic-layouts/orthogonal-layout) ·
[Vercel Geist colors](https://vercel.com/geist/colors) · [The Linear Look](https://frontend.horse/articles/the-linear-look/) ·
[Material dark theme](https://m2.material.io/design/color/dark-theme.html).

**UX:** [Mermaid Live Editor](https://mermaid.live/) · [Eraser diagram-as-code](https://docs.eraser.io/docs/diagram-as-code) ·
[D2 Playground](https://play.d2lang.com/) · [C4 model](https://c4model.com/diagrams).

**Internal:** `boardSchema.ts`, `planning/elements.ts`, `PlanningBoard.tsx`, `ImageCard.tsx`,
`whiteboardExport.ts`, `exportBoard.ts`, `projectStore.ts`, `projectIpc.ts`, `csp.ts`,
`windowSecurity.ts`, `index.css`, `exportColors.ts`. Sibling research:
`docs/research/2026-06-05-orchestrator-harness.md` (PR #71). Memory: `whiteboard-feature-research`,
`whiteboard-w5-export`.
