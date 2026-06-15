# Planning Board — Optimization & Improvement Research

> **Date:** 2026-06-15 · **Base:** `main` @ `7f835d4` (typecheck green)
> **Method:** multi-agent research workflow — 6 parallel survey dimensions (current-impl review · prior internal research · design contract · agent/MCP integration · diagram feasibility · external best-practices), each filling a structured schema, then one synthesis pass. 7 agents, adversarially cross-checked against source.
> **Topic:** optimizing the Planning board, adding diagrams, and enabling a terminal agent to render the current plan as a visual on a Planning board.
> **Status:** research only — no code changed. Open decisions in §7 await sign-off.

---
## 1. Executive summary

The Planning board is a mature, faithfully-built custom whiteboard: six element kinds (`note · text · arrow · stroke · checklist · image`), strong undo discipline, snapping/align/group/lock, image paste/drop, and PNG/SVG export — the build is actually *ahead* of the frozen design prototype (`PlanningToolbar.tsx:14-25` ships 7 tools vs the prototype's 5). Health is good on correctness and visual fidelity, but it has two structural ceilings: **no performance floor** (every gesture frame and commit is O(n) over all elements; cards aren't `React.memo`'d, so one keystroke re-renders the whole well — `PlanningBoard.tsx:524-594`, `canvasStore.ts:667-681`) and **no formal-diagram primitive** (the geometric "shapes epic" is deliberately deferred behind ADR 0001). The three highest-leverage moves, in order: (1) a cheap perf pass (`React.memo` the four cards + kill the dead `strokePaths` memo) that unblocks scale at near-zero risk; (2) a **Mermaid Diagram element** rendered in a hidden BrowserWindow worker (additive, ~80% reuses the image/asset/export pipeline, and is the explicit demand-gate that decides whether shapes ever get built); (3) an **MCP write-to-Planning path** so a terminal agent can render the current plan as a visual — today an agent can spawn an *empty* planning board but cannot place a single element on it (`mcpCommand.ts:20-28`).

## 2. Current state & review of existing work

**Capability inventory (shipped, verified in code):**

- **Tools** (`PlanningToolbar.tsx:14-25`): select · note · text · check · arrow · pen · erase + snap toggle + Export popover; shown only while the board is selected.
- **Notes** (`NoteCard.tsx`): 4 low-chroma tints, deterministic tilt, auto-size, hover re-tint, empty-prune.
- **Free text** (`FreeText.tsx` + `TextToolbar.tsx`): point + area text (v8 `width`), family/size/align/bold + 4-token color ramp; no-op-on-active (no phantom undo).
- **Checklist** (`ChecklistCard.tsx`): title, mono `done/total`, 3px accent progress bar, live toggle, Enter/Backspace item edit, board auto-grow; matches DESIGN.md §7.3 *verbatim* incl. the D0-2 a11y fix (done labels `--text-3`, not `--text-faint`).
- **Arrows / pen / images / eraser / marquee / align-distribute / group / lock / alt-drag duplicate** — all present, with strong undo discipline (gestures commit once on pointer-up, lazy `beginChange`, live-read `commit((cur)=>…)` guarding the BUG-023 lost-update class).
- **Export** (`runExport.ts → exportBoard.ts → whiteboardExport.ts`): pure board→SVG + offscreen-canvas PNG.
- **Schema**: `SCHEMA_VERSION = 10`, `minReaderVersion = 9`, two-tier (ADR 0007). The 6-kind `PlanningElement` union is at `boardSchema.ts:204-210`.

**Most important review findings / gaps:**

| # | Finding | Evidence |
|---|---|---|
| R1 | **No `React.memo` on cards** — `updateBoard` replaces the whole boards array; one note keystroke re-renders every NoteCard/FreeText/ChecklistCard/ImageCard + all SVG paths. Handlers are already stable `useCallback`s, so memoizing is cheap. | `PlanningBoard.tsx:524-594`; `canvasStore.ts:667-681` |
| R2 | **Dead `strokePaths` useMemo** — `strokes` is a fresh `.filter()` array every render, so the memo dep changes every frame and never skips; only the per-stroke WeakMap saves the math. | `WhiteboardSvg.tsx:108`; `PlanningBoard.tsx:420-421` |
| R3 | **O(n)/O(n²) hot paths, no spatial index** — snap rebuilds a statics bbox over all elements per frame; erase re-scans every element per frame; context-menu/keyboard do `.find()` inside `.filter()` loops. | `usePlanningPointer.ts:320-373`; `snapping.ts:42-57`; `usePlanningKeyboard.ts:160-165,221-224` |
| R4 | **Geometry encoded twice** — `elementBBox` (`elements.ts:293-337`) and `eraseHitTest` (`erase.ts:98-135`) each hand-encode per-kind geometry + nominal sizes (`TEXT_NOMINAL` vs `TEXT_HIT`); a card-layout change must be mirrored or selection/snap/erase/export silently desync. | `elements.ts:276-337`; `erase.ts:33,98-135` |
| R5 | **Three closure-based mutators** — `setItem`/`setTitle`/`setNoteText` use the stale `elements` closure, not the live-read `commit((cur)=>…)` their siblings use — latent BUG-023 lost-update. | `PlanningBoard.tsx:181-185,243-252` vs `236-266` |
| R6 | **Export drift** — `estimateTextWidth` is a glyph-count guess (no DOM); area-text wrap `width` is ignored, so wrapped/center/right text doesn't match the board. | `whiteboardExport.ts:155-182`; `textStyle.ts:74-86` |
| R7 | **No resize handle** for images or area-text (stuck at paste/fit size); no element registry — ~7 exhaustive `switch(el.kind)` sites a new kind must touch with no compile-time exhaustiveness. | `ImageCard.tsx:155-177`; deep-dive §2 |
| R8 | **Known-open W5 follow-up**: export/image-write errors are `console.error`-only — invisible in a packaged app (the error returns + cancel-vs-error distinction already exist; only the toast surface is missing). | deep-dive R1 |

**Doc/contract drift to be aware of:** DESIGN.md §7.3 and `design-reference/project/boards.jsx` are *stale* (list 5 tools, omit text/erase/snap/image/export). Treat DESIGN.md §1–4 tokens/principles as the live contract, but **cross-check `src/renderer/src/canvas/boards/planning/` for the real feature set** before designing anything new. Most decision-ready research (PR #72 diagram, PR #71 orchestrator, the 2026-06-06 deep-dive) lives on **un-merged branches / uncommitted on main** — a working-tree-only read misses it. Every schema number quoted in those docs (v6/v7/v8) is stale: live is **v10**, next additive bump is **v11**.

## 3. Optimization opportunities

**(a) Quick wins — land first, near-zero risk**

| Item | Effort | Impact | Why |
|---|---|---|---|
| `React.memo` the four card components | Low | **High** | Cuts a one-note edit from re-rendering N cards to 1; props are already stable `useCallback`s. Top ROI perf win. |
| Drop the dead `strokePaths` useMemo; lift `arrows`/`strokes` filters | Low | Med | Eliminates a per-frame array alloc in the drag/zoom hot path; rely on the WeakMap cache. |
| Move `setItem`/`setTitle`/`setNoteText` to `commit((cur)=>…)` | Low | Low | Closes the latent BUG-023 lost-update; one-line each, matches siblings. |
| User-visible failure **toast** for export/image-write (close W5 R1) | Low | Med | Only the surface is missing; closes the one open W5 follow-up *before* adding diagram/MCP failure surfaces. |
| Arc-length-adaptive bezier sampling in `nearArrow` | Low | Low | Fixes eraser skipping the middle of a long curved arrow (`erase.ts:61`). |
| Resolve dead `BoardCommon.z` orphan + add draw.io license-split ADR addendum | Low | Low | Hygiene; clears a known orphan field and the Apache/GPL copyleft note. |

**(b) Larger improvements — sequence behind the quick wins**

| Item | Effort | Impact | Why |
|---|---|---|---|
| **Element registry / per-kind descriptor table** | Med | Med | Collapses the ~7 `switch(el.kind)` sites into one table with compile-time exhaustiveness. **Land BEFORE any new kind (diagram/shape)** so they ride a clean rail — a missed branch crashes an old renderer on load. |
| Unify geometry (bbox + hit-test + nominal sizes) into one module | Med | Med | Removes the R4 dual-source drift; pairs naturally with the registry. |
| Element resize handles (images + area-text, optionally notes) | Med | Med | Removes "stuck at paste size" friction; reuses the arrow endpoint-handle pattern (`WhiteboardSvg.tsx:190-220`). |
| Export honors wrap width + uses OffscreenCanvas `measureText` | Med | Med | Fixes R6 drift; the rasterizer already builds a canvas. |
| Snap-to-grid + snap-to-board-frame | Med | Med | Makes the decorative 12px dot grid functional; gives the *first* element on an empty board something to align to. |
| Spatial bucket/grid index (cell ~256px) for hit-test/marquee/snap/erase | High | Med | Turns per-frame full scans into neighbor-cell lookups; prerequisite for scaling past a few hundred elements. Defer until the target element-count is known. |
| Anchored Planning arrows (0..1 relative anchors, note+checklist only) | Med | Med | The most defensible step toward diagramming **without** the shapes epic; the de-risking prerequisite for any text→diagram generator (generated connectors go stale on drag otherwise). Additive schema field. |

**(c) The shapes-epic question** — **Recommendation: defer; ship Mermaid first and measure.** Two independent passes (Excalidraw + draw.io) converge that the one primitive gating classic dev diagrams (flowcharts/UML/ERD/C4/BPMN) is geometric shapes + shape-bound rerouting connectors. But it is **extra-large**, it **reverses LOCKED ADR 0001** (requires a *new* ADR + explicit user sign-off, never a silent build), and crucially it does **not serve the "agent emits a diagram" ask** — an agent emits Mermaid text natively, not shape geometry. Everything draw.io brags about at the *canvas* level (connect, routing, containers, z-index) is already in React Flow; the only non-redundant value is *inside* a board, which Mermaid covers. Keep the epic parked unless Mermaid demonstrably fails to satisfy the formal-diagram need.

## 4. Diagrams on the planning board

**Recommended approach: a Mermaid `Diagram` element, NOT native geometric shapes.** Rationale:

- **Additive, agent-native, high reuse.** A new `DiagramElement` slots into the existing whiteboard chassis (like image/checklist) — reusing BoardFrame chrome, select/drag/marquee/group/lock, the W4 content-addressed asset pipeline, and the W5 export gatherer (~80% reuse). It does **not** reopen ADR 0001. Text-in/SVG-out is exactly the modality an agent emits.
- **Render in a hidden BrowserWindow worker, never jsdom-in-MAIN.** The production CSP is `script-src 'self'` with no `unsafe-eval` (`csp.ts:27`); Mermaid 11 needs eval (dagre/`new Function`/lazy ESM). jsdom-in-MAIN silently breaks `getComputedTextLength`, corrupting every non-trivial diagram. The fix: an invisible `BrowserWindow` (`show:false, sandbox:true`) with a **scoped `script-src 'self' 'unsafe-eval'` on that window only** — the `previewOsr.ts` precedent proves the lifecycle. The main-window CSP stays locked.
- **Source is canonical; SVG is a derived cache.** Persist `source` (Mermaid text); render to an SVG cached as a content-addressed asset (`svgCache?: assetId`), displayed via an **inert `<img>` blob URL** like `ImageCard` (`img-src 'self' data: blob:` already permits it — `csp.ts:28`). A source replace auto-invalidates the cache — no binary round-trip.

**Security impact.** Mermaid has real XSS→RCE history (CVE-2025-67744, DeepChat loose→RCE). Pin defense-in-depth: `securityLevel:'strict'` + `htmlLabels:false` + `click` off + namespaced SVG ids, in the **isolated worker only**; cap `maxTextSize` (DoS); SVG-as-`<img>` is inert; agent source stays renderer-side and **never reaches the PTY write channel** (ADR 0003). Pin all of this in `csp.ts` tests + a worker-specific test.

**Schema / versioning.** Add `DiagramElement {kind:'diagram', source, engine:'mermaid', svgCache?, w, h}` to the union, an `assertPlanningElement` branch, and an identity migration **in the same commit** (the default branch throws on unknown kind — `boardSchema.ts:642`). A new element kind is **breaking** per ADR 0007: bump **`SCHEMA_VERSION 10→11` AND `minReaderVersion 9→11`** so pre-11 builds get a clean "update the app" message via `assertReadableVersion` instead of a confusing `.bak` failure. Register `svgCache` in `collectAssetIds` (`projectStore.ts:246`) and the export gatherer, or GC sweeps the cached SVG on reopen (the documented backdrop-asset gotcha, `projectStore.ts:241-244`). Move the MAIN-duplicated `SCHEMA_VERSION` constant in lock-step (BUG-024). **Theme to the neutral palette** (`theme:'base'` + `themeVariables` mapped to app tokens; one accent on border/active only; Geist; no rainbow/gradient/glow — the default Mermaid theme directly violates the no-slop contract).

**Async/undo/perf.** Render off the React path; debounce while editing; reuse **one shared worker, serializing renders**; the async `svgCache` write-back must be a **silent, non-undoable** patch (follow the `lastRecorded` rule) or every render pollutes the undo rail.

**ASCII wireframe — Diagram element (selected state):**

```
┌─ Planning ─────────────────────────────[· · ·]┐   ← BoardFrame chrome (--surface)
│ · · · · · · · · · · · · · · · · · · · · · · · ·│      12px dot grid (--grid-dot)
│  ┌───────────────────────────────────┐ ◇      │
│  │ ◆ diagram            flowchart  </>│ ◇      │   ◆ kind glyph · type label · </> source toggle
│  ├───────────────────────────────────┤ ◇      │     border = --border  (selected = --accent 1.5px)
│  │   ┌──────┐        ┌──────┐         │        │   inert <img> of themed SVG (neutral palette):
│  │   │ Plan │──────▶│ Build │         │        │     nodes --surface-raised · text --text-1
│  │   └──────┘        └───┬──┘         │        │     edges/arrowheads --border-strong
│  │                       ▼            │        │     ONE accent only on the active/selected path
│  │                   ┌───────┐        │        │
│  │                   │ Verify│        │        │
│  │                   └───────┘        │        │
│  └──────────────────────────[ ⤢ resize]┘      │   resize handle (reuses endpoint-handle pattern)
│                                                │
└────────────────────────────────────────────────┘

  </> source mode (toggled):
  ┌───────────────────────────────────┐
  │ graph TD                          │   mono editor (--term-mono), --surface
  │   Plan --> Build                  │   live debounced re-render → SVG cache
  │   Build --> Verify                │   error → inline toast (closes W5 R1)
  └───────────────────────────────────┘
```

## 5. Agent → planning-board "live plan visual" (headline feature)

**The honest current answer is NO.** An agent can `spawn_board('planning')` but the factory hardcodes `elements: []` (`boardSchema.ts:375`), and the only MAIN→renderer write channel is the closed 4-variant `McpCommand` union — `ping | addBoard{id,type} | removeBoard{id} | configureBoard{shell?,launchCommand?,cwd?}` (`mcpCommand.ts:20-28`, verified). None carries content; `configureBoard`'s patch type cannot even express `elements`. The full agent-facing tool surface is 8 tools, all board/PTY-shaped (`spawn_board, close_board, configure_board, handoff/assign/relay_prompt, interrupt, write_result`) — **zero content tools**. All `canvas://` resources are strictly read-only.

**The gap is narrow and structural, not a model problem.** `PATCHABLE_KEYS.planning = [...COMMON_KEYS, 'elements']` already exists (`canvasStore.ts:489-509`) — the store-side apply path and the fully-expressive 6-kind schema are *ready*. What's missing is purely **transport + tool**. Critically, **do NOT close this by loosening `configureBoard`** (it's hardened against off-type forgery) — add a purpose-built command.

**Write path (recommended):**

1. **New pkg tool** `add_planning_elements(boardId, spec)` (+ a seed variant on `spawn_board` so an agent can mint a *pre-populated* board in one call).
2. **New `McpCommand` variant** `patchPlanning{id, ops}` (append/update notes + checklist items + text + arrows + diagram). MAIN validates against `assertPlanningElement`, **sanitizes text/markdown, and caps element count + size** (deep-dive R4: no upper bound today → canvas.json/undo-snapshot bloat risk).
3. **Renderer applies via the existing `updateBoard` → `PATCHABLE_KEYS.planning='elements'` channel**, through the same live-read `commit((cur)=>…)` + lazy `beginChange()` so human+agent edits chain (BUG-023) and land as discrete undo steps; agent auto-fit/layout bumps use the untracked `growBoardHeight` path so they push no phantom undo step (BUG-024).

**What the agent emits — recommend a hybrid, defaulting to structured elements:**

- **For plans/tasks → structured `ChecklistElement` + `NoteElement`** (stays within existing kinds → keeps `minReaderVersion` at 9, no breaking bump). This is the headline "live plan" surface: a checklist *is* the plan.
- **For architecture/flow → a `DiagramElement` with Mermaid source** (once §4 ships). Best practice (MermaidSeqBench, MermaidFlow) is that LLM Mermaid is syntactically strong but **semantically weaker** — so emit *validated structured JSON first, then convert*, keep the result editable, and run a bounded Mermaid auto-repair loop (Excalidraw's BFS: quote-fix, ~30 candidates, depth 4) before display.

**Trust / egress guardrails (ADR 0003 — this is the revisit trigger ADR 0003 §M-expose names).** An element-write tool is the **first MCP path writing attacker-influenceable *content* onto the durable canvas** (distinct from PTY-dispatch which writes into a shell). Mandatory:

- **Human-in-the-loop confirm at WRITE time**, not just dispatch time, reusing the shipped `requestConfirm` (fail-closed, MAIN owns the decision) + the closed `DispatchStatus` audit vocabulary (`mcpOrchestrator.ts:119-236`, `mcpConfirm.ts`).
- The confirm must show the **full rendered content** (not just a count) so injected text can't be rubber-stamped — **one batch confirm per write**, per-element is unusable.
- Treat all agent/LLM-emitted content as **untrusted passive context**: it renders but **never auto-arms an action**. A checklist item that is *also* pre-wired for terminal dispatch (the "Run" flagship) re-creates the lethal trifecta — it must require an **unconditional, separate human confirm before any dispatch**.
- `generate_plan(prompt)` via the M-brain LLM spends ADR 0003 egress (200/day, fail-closed to Tier-1) — count agent-triggered generation against the same user budget; a runaway agent loop must not drain it.

**ASCII mockup — agent-driven live plan visual on the canvas:**

```
  CANVAS (void · 24px lattice)
  ┌─ Terminal: orchestrator ──────┐        ┌─ Planning: "Auth refactor plan" ───────┐
  │ $ claude                      │        │ · · · · · · · · · · · · · · · · · · · · │
  │ > drafting plan…              │ ──────▶│  ┌─ Checklist ──────────────┐          │  ← orchestration
  │ ✎ writing 6 tasks to board    │ orch.  │  │ Auth refactor      2/6 ▓▓░░░░ │       │    connector
  │   [awaiting your confirm ▸]   │ conn.  │  │ ☑ Audit current session mw  │       │    (--connector
  └───────────────────────────────┘        │  │ ☑ Add ADR for token tiers   │       │     #5a6573,
                                            │  │ ☐ Wire confirm gate    [▸Run]│       │     arrowhead)
   ┌─ CONFIRM (MAIN-owned, fail-closed) ─┐  │  │ ☐ Update boardSchema → v11  │       │
   │ Agent wants to write 6 plan items   │  │  │ ☐ Migration + assert branch │       │
   │ + 1 diagram to "Auth refactor plan" │  │  │ ☐ e2e: matrix both legs     │       │
   │ ┌ preview ────────────────────────┐ │  │  └─────────────────────────────┘       │
   │ │ ☐ Audit current session mw      │ │  │  ┌─ Diagram (mermaid) ─────────┐        │
   │ │ ☐ Add ADR for token tiers …     │ │  │  │  [mw]──▶[token tier]──▶[gate]│       │
   │ └─────────────────────────────────┘ │  │  └─────────────────────────────┘        │
   │            [ Decline ]  [ Apply ▸ ] │  └────────────────────────────────────────┘
   └─────────────────────────────────────┘
   ☐ "Run" on an item = a SECOND, separate confirm before any PTY dispatch (lethal-trifecta guard)
```

## 6. Phased plan

Each phase ends runnable + committed; feature work on a `feat/*` worktree, sequential merge with the full e2e matrix at the pre-merge gate. Declare the `boardSchema.ts` bump on `ACTIVE-WORK.md` before P2/P3 (cross-zone shared file).

- **P0 — Quick-win perf + hygiene (no schema change).** `React.memo` the four cards; drop the dead `strokePaths` memo + lift filters; move the three mutators to live-read `commit`; add the export/image-write failure toast (close W5 R1); arc-length bezier sampling; resolve `BoardCommon.z` + license ADR addendum. *Runnable: planning board faster, edits no longer re-render the whole well; gate green.*
- **P1 — De-risk rail (internal refactor, no schema change).** Land the **element registry / per-kind descriptor table** and unify geometry (bbox + hit-test) into one module. Verbatim-move per-extraction with e2e:matrix after each. *Runnable: identical behavior, one place to add a kind; this is the clean rail P2/P3 ride.*
- **P2 — Mermaid Diagram element (schema v11, breaking floor bump).** Hidden BrowserWindow render worker (modeled on `previewOsr`), scoped `unsafe-eval` on that window only; `DiagramElement` + `assertPlanningElement` branch + identity migration **in one commit**; `DiagramCard` (= ImageCard + `</>` source mode); `svgCache` registered in `collectAssetIds` + export gatherer; `securityLevel:'strict'` + `htmlLabels:false`; theme to tokens. Bump `SCHEMA_VERSION 10→11` **and** `minReaderVersion 9→11` (lock-step the MAIN constant). **Design artifact (the §4 wireframe) signed off + title-stamped dev check** before merge. Ship flowchart/sequence/ERD first. *Runnable: users author themed diagrams on the board; CSP tests pin the security posture.*
- **P3 — Agent → plan visual (MCP write path).** Add `patchPlanning{id,ops}` to `McpCommand` + `add_planning_elements`/`spawn_board` seed in the pkg; MAIN-side validate + sanitize + element-count cap; route through `requestConfirm` (batch confirm showing full rendered content) + audit; renderer applies via existing `updateBoard`/`PATCHABLE_KEYS`. **Default to structured checklist/note elements** (keeps floor at 9 for this slice); diagram emission rides P2. *Runnable: an agent spawns/populates a live plan board, human-confirmed; egress + trust guardrails enforced.*
- **P4 (optional, gated) — Closed loop + generate-plan-from-prompt.** Checklist-item "Run" → bound Terminal PTY (second confirm); `generate_plan(prompt)` via M-brain (new ADR extending 0003). Defer until P3 is proven and the lethal-trifecta confirm UX is validated.

## 7. Open decisions for the user

- **Diagrams: Mermaid element vs the geometric shapes epic.** *Recommend: Mermaid element now; keep the shapes epic parked and measure demand — ship Mermaid as the explicit demand-gate before ever reopening ADR 0001.*
- **Agent emits Mermaid text vs native structured elements.** *Recommend: hybrid — default to structured checklist/note for plans (no breaking bump), use Mermaid for architecture/flow once P2 lands; always emit validated structure → convert → keep editable.*
- **Reader floor: bump `minReaderVersion 9→11` on the diagram kind, or keep agent-write within existing kinds to hold the floor at 9.** *Recommend: keep the first agent-write slice (P3) within note/text/checklist to stay at floor 9; pay the breaking bump only when the diagram kind (P2) lands, where a clean "update the app" message is worth it.*
- **MCP write tool: default-on vs flag-gated.** *Recommend: flag-gated + mandatory write-time human confirm for the first release; it's the first agent-content-onto-canvas path (ADR 0003 revisit trigger).*
- **Render worker: one shared keep-alive window (serialize renders) vs one-per-diagram.** *Recommend: single shared worker, serialized — lighter, and `previewOsr`'s per-view map isn't needed for an off-screen rasterizer.*
- **Persist the SVG cache vs re-render on open.** *Recommend: persist `svgCache` for instant open, accepting the GC-registration cost (must add to `collectAssetIds` + export gatherer).*
- **Plan↔worker link representation: an `orchestration` connector (visual cable, reuses the existing edge model) vs a `linkedBoardId` field vs both.** *Recommend: the existing `orchestration` connector first (already designed + tokened); add a data field only if proximity/label matching proves insufficient.*
- **DESIGN.md §7.3 + prototype: reconcile to the shipped 7-tool board now, or leave frozen as original intent.** *Recommend: reconcile now (doc-only update on main) so diagram/agent contributors inherit the correct baseline; promote the 4 note tints + connector colors to named CSS tokens in the same pass.*
- **Maestri's on-disk notes idea: make Planning notes real markdown files agents read/write, vs stay in canvas.json.** *Recommend: defer — stay in-app state; revisit only if a filesystem interchange becomes a concrete agent requirement.*