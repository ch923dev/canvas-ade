# Planning Board — Deep Dive + Improvement Research

**Date:** 2026-06-06 · **Method:** 7-agent research workflow (4 internal code/doc deep-reads + 2 external
web-research legs + 1 synthesis), adversarially grounded in `file:line`. Pulled the branch-only
Excalidraw/canvas-impl research via `git show feat/planning-research:…`.
**Status:** research only — no code changed. Uncommitted artifact (main is integration-only).
**Inputs folded in:** `docs/research/drawio-feature-borrowing.md`, `excalidraw-feature-borrowing.md`
(branch), `file-editor-board-integration-research.md`, `docs/roadmap-{drawio,whiteboard}.md`,
`docs/archive/2026-06-03-whiteboard-epic.md`, PR #72 (Diagram).

---

## 1. How the Planning board is built (implementation)

A Planning board is a **React Flow node** whose content is a flat, ordered **discriminated-union array**
`board.elements: PlanningElement[]` — 6 kinds (`note · text · arrow · stroke · checklist · image`) all
extending `ElementCommon {id,x,y,locked?,groupId?}` (`boardSchema.ts:61-134`).

| Layer | Where | Notes |
|---|---|---|
| Element model | `planning/elements.ts` | Pure/immutable factories + array transforms (`makeNote…`, `patchElement`, `translateMany`, `toggleItem`, group/lock/duplicate). Zero React/store/DOM coupling, caller-supplied ids → deterministically testable. |
| Interaction | `planning/usePlanningPointer.ts` | The pointer/draft/erase/marquee **state machine**. Tool-dispatched; arrow/pen seed a draft committed on pointer-up. |
| Render | `PlanningBoard.tsx` + `WhiteboardSvg.tsx` + per-element cards (`NoteCard`/`FreeText`/`ChecklistCard`/`ImageCard`) | DOM cards + one SVG vector layer (arrows/strokes). |
| Geometry | `marquee.ts`/`snapping.ts`/`align.ts`/`erase.ts` | **Kind-agnostic** — driven only by `elementBBox`, so they cover every current+future kind for free. |
| Strokes | vendored `perfect-freehand` → `svgPaths.ts` | Flat point list → one filled SVG `<path>`; committed strokes WeakMap-cached. |
| Store path | `canvasStore.updateBoard(id,{elements})` | The **single** commit channel. `PATCHABLE_KEYS.planning = [...COMMON_KEYS,'elements']` (`canvasStore.ts:328`) — the only key content reaches the store through. |
| Persistence | `boardSchema.ts` | `SCHEMA_VERSION = 5`; in-order migration pipeline (1→5); hand-rolled deep validation (no zod); only `{schemaVersion,viewport,boards,connectors}` serialized. |
| Undo | shared `canvasStore` history | Lazy `beginChange()` at **commit**, not grab; `HISTORY_LIMIT=50`. |

**What's strong:** rigorously-enforced **scene/session split** (ephemeral tool/draft/marquee/hover/measured
sizes never serialized — matches Excalidraw's `cleanAppStateForExport` discipline); pure unit-tested element
model (~130 cases); single immutable commit path with a no-op diff guard; disciplined lazy-checkpoint undo
(the hard-won Bug #7/#11/#29 invariants); strong load-time robustness (rejects malformed elements, clamps
sizes, falls back to `canvas.json.bak`).

**Already shipped (W1–W5 — assess/improve, do NOT re-propose as new):** notes · text · arrows · freehand
pen · checklists · images · marquee select · in-board snapping + alignment guides · alt-drag duplicate ·
lightweight `groupId` grouping · locking · element context menu · note tints · **PNG/SVG export** ·
full-view (camera fit, `rf.fitView`).

### Where the model is rigid
No element registry. Per-kind behaviour is hardcoded in **~7 exhaustive `switch (el.kind)` sites** a new
kind must each touch, with no compile-time exhaustiveness guarantee:
`elementBBox` (`elements.ts:279-320`) · `shiftElement` (`:355-368`) · `eraseHitTest` (`erase.ts:92-110`) ·
`assertPlanningElement` (`boardSchema.ts:387-438`) · `renderElement` SVG export (`whiteboardExport.ts:105-205`)
· render dispatch (`PlanningBoard.tsx:802-867`) · tool wiring. (marquee/snap/align/group/lock are free.)
Adding a note-like **rect shape** = easy-moderate (~7 files + a v6 migration). A **card-to-card connector**
is harder — a genuinely new anchoring sub-model, not a 7th kind.

---

## 2. Reliability findings

Strong at the **pure-logic layer** (~130 unit tests over geometry/transforms/snap/marquee/erase/export +
the phantom-undo invariants asserted at the store level; **0 skipped tests**). The gaps:

| # | Finding | Evidence |
|---|---|---|
| R1 | **Silent failures** — every user-facing error is `console.error`-only (invisible in a packaged app): image-write fail, undecodable bitmap, export save-error, per-asset read swallow. Code paths are correct (no crash/broken element) but the user sees nothing. *The known open W5 follow-up.* | `PlanningBoard.tsx:193,204,301,305`; `exportBoard.ts:56` |
| R2 | **Pen draft is O(n²)** — `pushBoardPoint` returns `[...points,x,y]` per pointer-move + `getStroke` re-runs over the full growing list each frame (only committed strokes cached). Long slow stroke = janky. | `pen.ts:70`; `svgPaths.ts:45`; `WhiteboardSvg.tsx:85` |
| R3 | **Snap recomputes every frame** — rebuilds all static-neighbour BBoxes+anchors per move frame (statics don't change during a drag). Dominant per-frame cost on a dense board. | `usePlanningPointer.ts:252-271`; `snapping.ts:42-56` |
| R4 | **No upper bounds** on stroke points / element count / board size — a 10k-element board validates, loads, bloats the single inline `canvas.json` and every 50-deep undo snapshot. No paste-image size cap. | `boardSchema.ts:403-407,530-535`; `canvasStore.ts:61` |
| R5 | **Zero-coverage behaviours** — `onWellPointerCancel` (palm-reject mid-erase), pen end-to-end, concurrent draft + tool-switch, undo of an in-flight drag. The lazy-checkpoint logic is hand-duplicated across 5 branches → a new gesture can silently re-introduce a phantom step. | `usePlanningPointer.ts:381,389,434-451` |
| R6 | **Full re-render per commit** — `viewElements`/`arrows.filter`/`strokes.filter` unmemoized; erase swipe allocates a new `Set` per growth frame. | `PlanningBoard.tsx:667-687` |
| R7 | **Export-color drift** — `exportColors.ts` is a hand-maintained duplicate of `tints.ts`/CSS tokens with only a "keep in step" comment; no parity test. | `exportColors.ts:6,22` |

---

## 3. Improvement roadmap (prioritized)

Grounded in current code + the existing draw.io/Excalidraw research + external best-practice (Excalidraw,
tldraw, draw.io internals; FigJam/Miro/Linear/Maestri feature landscape).

### Quick wins (S, do first)
- **#13 Resolve the v6 schema-version owner** (S, **P1**). v6 is **triple-contested** — draw.io D2 Mermaid,
  file-editor "editor" board, PR #72 Diagram each assume they own the next bump. Every research doc's bump
  numbers are **stale** (written at v2/v3/v4). Pick one owner (or sequence v6/v7/v8), update the four docs to
  bump from **5**. Pure coordination that de-risks every downstream element slice.
- **#1 User-visible failure toast** for image-write + export (S, **P1**). Closes the known W5 follow-up; the
  error returns + cancel-vs-error distinction already exist and are tested — only the surface is missing.
- **#16 Derive export colors from the single `tints.ts`/CSS source** + parity test (S, P3). Kills R7.
- **D1.2 Resolve the dead `BoardCommon.z` orphan field** (S) — validated + migrated but never honored on
  render. Delete it or wire `board.z → RF node.zIndex`.

### Reliability/perf (M, low-risk)
- **#2 Make the pen draft incremental** (M, P1) — mutate-in-place the session-only draft array; cache/append
  the outline instead of re-`getStroke`-ing the full list; pass `last:true` on commit. Kills R2.
- **#3 Cache static-neighbour BBoxes/anchors for a drag** (M, P2) — compute once on pointer-down. Follow-on:
  an **RBush R-tree** (pure-JS, sandbox-safe) over element bounds → O(log n) marquee/erase/hit-test (tldraw's
  proven fix; pays off once boards get dense).
- **#4 Soft caps + guards** (M, P2) — decimate stroke points on commit; warn past N elements; cap paste-image
  bytes/dimension. Depends on #1's toast.
- **#5 Add the 3 zero-coverage tests + extract one shared lazy-checkpoint helper** (M, P2) — closes R5 and
  removes the 5-way duplicated undo logic before any new gesture/element lands.
- **#6 Memoize derivations; move erase/drag transient state to refs + rAF** (M, med-risk) — mirrors the
  proven preview-sync rAF discipline.

### Big bets (the AI-native differentiator)
The decisive advantage: **executing agents (terminal boards) + the verification surface (browser preview)
already live on the same canvas as the plan**, and the MCP swarm layer (M0–M5, board-status events,
`Orchestrator.subscribeStatus`) + LLM brain/memory already shipped. No web competitor (FigJam/Miro/Linear)
can offer the closed **plan → dispatch → verify** loop; only native-Mac Maestri half-has it. But **M-expose
is read-only**, so the loop isn't wired yet.

- **#7 Checklist item → agent dispatch** (L, **P1, FLAGSHIP**). A "Run" affordance spawns/targets a terminal
  board with the item text as context; the item status bar reflects live state via M5 events. Status stays
  **ephemeral** (never in `elements[]`/`PATCHABLE_KEYS`). Constrain to terminal targets; browser content
  never reaches a PTY write channel. Exploits assets already on main.
- **#8 MCP write-to-Planning-board** (L, **P1**). Extend M-expose read→write so external agents
  append/check/update checklist items + notes in Markdown/Mermaid (the FigJam `figma-use-figjam` / Miro MCP
  pattern). Routes through the single commit path; generated content is untrusted passive context (ADR 0003).
  The M-expose write→read join is already proven (#74).
- **#9 Element registry / per-kind descriptor table** (L, P2). Collapse the ~7 switch sites into one table
  entry with exhaustiveness checks. **Land before** the diagram/shape work so they ride a clean rail.
- **#10 Mermaid Diagram element** (L, P2) — **MERGE draw.io D2 with PR #72** into one spec. Render in a
  **hidden BrowserWindow worker** (NOT jsdom-in-MAIN, NOT a native-shape parser): re-editable themed source,
  no parser to maintain. `securityLevel:'strict'`, namespaced SVG ids, lazy-load the MIT lib, try/catch
  parse-error. Mermaid is the validated agent-native winner over PlantUML. It's the **decision gate** for the
  shapes epic — ship it, then **measure demand**.
- **#11 Generate-plan-from-prompt** (M, P2) — turn the M-brain into a board seed: prompt → pre-populated
  checklist (+ optional Mermaid arch diagram), each item pre-wired for dispatch (#7). Reuses the LLM
  budget/keystore/ADR-0003 gate.
- **#12 Element-anchored connectors** (L, P2) — arrows that bind to note/checklist anchors and re-route on
  move (Excalidraw **focus+gap** math, resolved at render time). Restrict targets to note+checklist to hold
  the line against the full shapes epic. The de-risking prerequisite for any text→diagram generator. Needs
  the coordinated v6 bump.
- **#17 Dependency-aware checklist + kanban/sections + dispatch-aware templates** (XL, P3) — blocked-by gating
  for safe parallel fan-out, status-driven kanban columns (To-Plan/Dispatched/In-Progress/Verified automated
  from M5), and "Feature build"/"Bug triage"/"Architecture map" starter templates. The durable differentiator
  vs the crowded OSS field (OpenCove/TermCanvas/Horizon/Maestri). Sequence after #7/#8/#13.

### Lower priority
- **#14 Resize/rotate handle layer** keyed off `elementBBox` + optional per-element `z` (tldraw IndexKey
  fractional-index style) — needs v6 (L, P3).
- **#15 Keyboard nudge + element copy/paste** via JSON clipboard (M, P3; `Ctrl+V` fires at `document` — use
  a focus-gated document listener, Excalidraw pattern).

---

## 4. External best-practice borrows (patterns, NOT libs)

| Pattern | Source | Port into our custom engine |
|---|---|---|
| **focus+gap binding** (arrow holds `{elementId,focus,gap}` + reciprocal `boundElements`; `updateBoundPoint` projects onto perimeter) | Excalidraw `binding.ts` | #12 anchored connectors. MEDIUM. |
| **RBush R-tree** spatial index (O(log n) marquee/erase/cull) | tldraw | #3. Pure-JS, sandbox-safe, no node imports. |
| **IndexKey fractional z-order** (reorder = one element, not array splice) | tldraw | #14. Needs v6. |
| **mark + ignore-ephemeral undo** (squash gesture → one step; no-op → zero diff by construction) | tldraw `HistoryManager` | #5 — formalizes our Bug #7 ad-hoc guards. |
| **inverse-transform hit-test** (screen→world→local, slop ÷ zoom) | tldraw `getPointInShapeSpace` | hardens selection under `scale(z)`. Inverse math already exists in preview-sync. |
| **canonical freehand pipeline** (memoize `getStroke`, single filled `<path>` via `getSvgPathFromStroke`, `last:true`, real pressure) | perfect-freehand | #2. |

**Engine-choice note:** tldraw/Excalidraw both parse Mermaid into *native editable shapes*; PR #72's
hidden-worker *image* approach is the pragmatic middle (source-owned, themed, re-editable code; non-editable
individual nodes — a deliberate documented trade). Miro/FigJam adopting Mermaid as their "agent-friendly"
interchange means a Mermaid element doubles as the agent read/write contract.

---

## 5. Hard constraints (do NOT violate)

1. **No tldraw/Excalidraw as a dependency** (ADR 0001). Borrow *patterns/math*, not libs. The geometric
   **shapes epic** reverses ADR 0001 → stays DEFERRED behind a **new ADR + the Mermaid demand-gate**. Never a
   silent build.
2. **Schema bumps from v5** + an in-order migration. Never silently reuse v5. Sequence the triple-contested v6.
3. **Preserve the scene/session split absolutely** — never add ephemeral keys (tool/draft/marquee/hover/
   dispatch-status/measured sizes) to `PATCHABLE_KEYS` or route them into `elements[]` (`canvasStore.ts:320-323`).
4. **Respect the undo invariants** (Bug #7/#11/#24/#28/#29/#37) — lazy `beginChange` at commit; no phantom
   steps; transient-delta drag committed once; route new gestures through the *shared* checkpoint helper.
5. **Renderer stays sandboxed** — no node/native imports; RBush/perfect-freehand/Mermaid run as pure JS (or
   Mermaid in a hidden BrowserWindow worker, not jsdom-in-MAIN).
6. **AI-dispatch security** — browser content never reaches a PTY write channel; agent pipes are
   terminal→terminal only; all agent-authored content is untrusted passive context (ADR 0003), never
   auto-driving an action without a user gate.
7. **Don't re-propose W1–W5** as new; don't rebuild canvas-level (board↔board) connectors/routing/z-order
   (React Flow already provides them — new connector value lives only *inside* a Planning board); don't
   re-introduce a portal for full-view (it's a camera fit); don't embed a second canvas engine (mxGraph
   iframe = the two-canvas trap).
8. **Feature work on a `feat/*` worktree**, sequential merge to main, gate green (1273 unit+int / 95 files,
   lint 0 err, format:check). Coordinate with in-flight PRs (rebrand #17 merges LAST; PR #72; dependabot
   #76–80).

---

## 6. Recommended sequencing

```
1. #13 schema-owner decision  +  #1 failure toast        (S/P1 — unblocks + closes known gap)
2. #2 pen O(n²)  +  #5 tests/checkpoint-helper           (P1/P2 — reliability before features)
3. #9 element registry                                    (P2 — clean rail before new kinds)
4. #8 MCP write-to-board  →  #7 checklist→dispatch        (P1 FLAGSHIP — the closed loop)
5. #10 Mermaid element (D2 ⊕ PR#72)  →  MEASURE demand    (P2 — gates the shapes epic)
6. #12 anchored connectors  →  #11 generate-plan          (P2)
7. #17 dependency/kanban/templates                        (XL/P3 — the durable moat)
   (#3 RBush, #14 resize/z, #15 nudge/copy-paste — slot opportunistically)
```

**One-line thesis:** the planning board is a mature, well-tested whiteboard with a clean data model and a
couple of real perf/feedback gaps to close — but its *strategic* upside isn't more whiteboard parity, it's
wiring the checklist into the agent boards already on the canvas (dispatch + MCP-write + status-sync), which
no competitor can match. Fix R1/R2 + decide the v6 owner first; then build the closed loop.
