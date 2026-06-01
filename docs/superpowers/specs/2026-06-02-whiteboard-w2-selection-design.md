# Whiteboard W2 — Selection core (multi-select + snapping) · design

Status: approved 2026-06-02 · Branch `feat/whiteboard-w2` → PR into `feat/whiteboard` (NOT main).
Spec seed: `docs/roadmap-whiteboard.md` › Phase W2 + `docs/research/excalidraw-feature-borrowing.md`.
Base: `feat/whiteboard` @ `cef80d4` = W1 (`0324610`) **with `origin/main` merged in**, so the foundation
now carries **D1.1 (`trackedChange` undo-rail refactor, PR #18 `f7ffbbf`)** — see §0.

## 1. Goal & scope

Turn the Planning whiteboard's single-element selection into a real **selection set** with marquee
box-select, Shift-click additive toggle, multi-drag, and group-delete (**W2.1**), plus live
**edge/center snapping with alignment guides** while dragging (**W2.2**).

Ships as **one branch / one PR** into the `feat/whiteboard` umbrella. Internally TDD W2.1 first
(selection set is the structural unlock), then W2.2 (snapping rides the same drag path).

**Explicitly out of scope** (deferred per roadmap): resize/rotate handles, equal-gap *distribute*
pills (O(n²)/frame), grid snap, alt-drag duplicate, align/distribute, grouping (`groupId`) — those
are W3. No schema change, no `assets/` work (W4).

## 0. Base / integration with current main (D1.1)

`origin/main` advanced past the W1 fork-point (`cd588be`, PR #15) with **D1.1** — the `trackedChange`
undo-rail refactor (PR #18 `f7ffbbf`) plus the "mark D1.1 done" docs (`65442d9`). Per decision
2026-06-02, `origin/main` was **merged into the `feat/whiteboard` umbrella** (`cef80d4`) and W2 was
rebased on top, so W2 builds + gates against the **real post-D1.1 store**, not the stale one.

- **Merge was clean**: `canvasStore.ts` and `CLAUDE.md` auto-merged (W1's only `canvasStore` touch was
  a comment — the W1.3 scene/session contract — in a different region from D1.1's refactor); the two big
  draw.io docs were byte-identical; one trivial `docs/roadmap-drawio.md` status-row conflict resolved by
  taking main's (D1.1 marked done).
- **W2 store API is byte-identical post-D1.1** (verified on `origin/main`): `updateBoard(id, patch)`,
  `beginChange()`, `growBoardHeight(id, h)` all unchanged. `trackedChange(s, next, {selectedId?,
  reflectPresent})` is an **internal** helper for the 5 tracked store actions (add/remove/duplicate/
  tidy/tile) — **W2 calls none of them**.
- **W2 adds NO `canvasStore.ts` edits**, so it contributes **zero** new conflict to the eventual
  `feat/whiteboard → main` umbrella PR. The D1.1 reconciliation is already absorbed in the base.
- **Integration order unchanged**: W2 PRs into `feat/whiteboard`; the umbrella PRs to `main` later as
  one unit (now a smaller diff, D1.1 already integrated).

## 2. Confirmed UX decisions (2026-06-02)

- **Marquee predicate = intersect/touch.** Selects any element whose bbox the marquee rect touches
  (matches Excalidraw/Figma + the `erase.ts` "rect-overlaps-element" note). Not containment.
- **Snapping default = ON**, with a toggle **pill** in the board TOOLS cluster.
- **Drag grammar = Figma-standard.** Press an already-selected element → drag the whole set. Press an
  unselected element (no Shift) → replace selection with just it, then drag it. Shift+click toggles an
  element in/out of the set.

## 3. Architecture — what changes and why

### 3.1 No store changes (coordination-critical)

Today `selectedElId: string | null` is **local `useState` in `PlanningBoard.tsx:91`** — NOT in
`canvasStore`. W2 widens it to a `Set<string>`, still board-local. W2 only *calls* the existing
`beginChange()` + `updateBoard()` store API; it adds **no** store actions and edits **no** store file.

→ D1.1's `trackedChange` refactor is already in W2's base (§0) and **does not touch the API W2 uses**:
`beginChange()` + `updateBoard()` are byte-identical post-D1.1. So there is no collision to absorb — W2
is a pure selection-feature diff over a current-main foundation.

### 3.2 State (all local to `PlanningBoard`)

| Old | New |
|---|---|
| `selectedElId: string \| null` | `selectedIds: Set<string>` |
| `dragPos: {id, dx, dy} \| null` | `dragPos: {ids: string[], dx, dy} \| null` |
| `drag.current` modes `move\|arrow\|pen\|erase` | + `move` carries `ids: string[]`; + new `marquee` mode `{mode:'marquee', startX, startY, additive}` |
| — | `marqueeRect: {x,y,w,h} \| null` (transient, board-local) |
| — | `snapGuides: Guide[] \| null` (transient) |
| — | `snapEnabled: boolean` (default `true`) |
| — | `measuredRef: useRef<Map<string,{w,h}>>` (live DOM sizes for text/checklist) |

Selection mutators (small, local): `replaceSel(id)`, `toggleSel(id)`, `clearSel()`, `addManySel(ids)`.

### 3.3 Pure helpers (no React, no DOM — unit-tested like `elements.test.ts`)

**`planning/elements.ts`** (extend):
- `elementBBox(el, measured?: {w,h}): {x,y,w,h}` — discriminates on `kind`:
  - `note` → schema `x,y,w,h`.
  - `checklist` → `x,y,w`, `h = measured?.h ?? nominalChecklistHeight(items.length)` (nominal mirrors
    `erase.ts` header/row/footer metrics).
  - `text` → `x,y`, `w/h = measured ?? TEXT_NOMINAL` (no persisted w/h).
  - `arrow` → bbox of `(x,y)`–`(x2,y2)` (min/max; **no top-left assumption**).
  - `stroke` → min/max over `points` pairs.
- `anchors(bbox): {left, centerX, right, top, centerY, bottom}` — trivial derivation.
- `translateMany(els, ids: Iterable<string>, dx, dy)` — folds `translateElement` across the set in one
  immutable pass (per-kind correctness already in `translateElement`).

**new `planning/marquee.ts`**:
- `rectFromPoints(ax,ay,bx,by): {x,y,w,h}` (normalize to positive w/h).
- `rectIntersectsBBox(rect, bbox): boolean` (axis-aligned overlap = intersect predicate).
- `marqueeHits(els, rect, measured): string[]` (ids whose `elementBBox` intersects rect).

**new `planning/snapping.ts`**:
- `computeSnap(movingBBoxes: BBox[], staticAnchors: Anchored[], tol): {dx, dy, guides: Guide[]}` —
  given the moving set's union/box anchors and the static neighbors' anchors, find the nearest
  edge-to-edge / center-to-center alignment within `tol` (BOARD-LOCAL px) on each axis independently,
  return the snap correction to add to the raw `dx/dy` plus the guide line(s) to draw. Nearest wins;
  no match → zero correction, no guide.
- `Guide = {axis:'x'|'y', at:number, from:number, to:number}` (board-local extents).

Geometry from `erase.ts` (`distToSegment`, etc.) is reused where applicable; the marquee needs the new
**rect-overlaps-bbox** sibling predicate (point-near is wrong for box-select).

### 3.4 Pointer state machine (`onWellPointerDown/Move/Up` + `startElementDrag`)

- **Down — select tool, empty well** (`e.target === e.currentTarget`): start `marquee` (record
  board-local start, `additive = e.shiftKey`), `setPointerCapture` on the well. Do **not** clear
  selection yet (resolved on up).
- **`startElementDrag(e, id)`** (called by card grips + `WhiteboardSvg` vectors), selection-aware:
  - id ∉ selection, no Shift → `replaceSel(id)`; `movingIds = [id]`.
  - id ∈ selection → `movingIds = [...selectedIds]`.
  - Shift → `toggleSel(id)`; `movingIds = resulting set`.
  - Record grab point; `drag.current = {mode:'move', ids: movingIds, grabX, grabY}`; capture on well.
- **Move:**
  - `move` → raw `dx/dy = round(p − grab)`; if `snapEnabled`, `computeSnap` against anchors of elements
    **not in `movingIds`** → biased `dx/dy` + `snapGuides`; `setDragPos({ids, dx, dy})`.
  - `marquee` → `setMarqueeRect(rectFromPoints(start, p))`.
  - `arrow|pen|erase` unchanged.
- **Up:**
  - `move` → if `dx≠0 || dy≠0`: `beginChange()` once + `commit(translateMany(elements, ids, dx, dy))`.
    Clear `dragPos` + `snapGuides`. (Zero-move grab = no checkpoint — preserves #11/WB-1.)
  - `marquee` → `hits = marqueeHits(elements, rect, measured)`; selection =
    `additive ? union(prev, hits) : (rectMoved ? hits : clear)`; clear `marqueeRect`.
- **Delete/Backspace** (well `onKeyDown`, already `stopPropagation`): remove **all** `selectedIds` under
  **one** `beginChange()` → `commit(elements.filter(e => !selectedIds.has(e.id)))`; `clearSel()`.

### 3.5 Selection threading + visuals

- `NoteCard` / `FreeText` / `ChecklistCard` gain `selected: boolean` + `onSelect(id, additive)`. The grip
  press (select mode) calls `onSelect(id, e.shiftKey)` **before** `onDragStart` (mirrors the existing
  `WhiteboardSvg` order). Empty-note prune guards are untouched (only the grabbed card runs them).
- Selected card visual: **`outline: 1.5px solid var(--accent); outline-offset: 2px`** — calm,
  single-accent, no glow, rotates with the note. **No resize/rotate handles.**
- `WhiteboardSvg`: `selectedId: string|null` → `selectedIds: Set<string>`; highlight any id in the set.
  Renders, in the existing draft slot: the **marquee** (dashed `--accent` rect, faint accent fill) and
  **snap guides** (1px `--accent` lines).
- **Snap pill** in the TOOLS cluster (`IconBtn`, `active={snapEnabled}`). Adds one glyph (magnet/snap)
  to `Icon.tsx` — additive, declared as a cross-zone edit on the coordination board.

### 3.6 Auto-sized bbox strategy (the known risk)

`text` has no persisted w/h; `checklist` persists `h:0` (grows with content). `elementBBox` stays pure
with a **nominal fallback** so unit tests need no DOM. Live code supplies real sizes via `measuredRef`:
`ChecklistCard`'s existing `ResizeObserver` (today reports bottom) also reports `{w,h}`; `FreeText`
gains a small `onMeasure(id,w,h)`. Marquee/snap read `measuredRef.get(id)`. First-frame-stale is
bounded by the nominal fallback; guides recompute every move frame so they self-correct.

## 4. Undo / persistence discipline (locked, do not weaken)

One `beginChange()` per gesture, deferred to the actual commit (the WB-1 / W1 pattern):
multi-drag = 1 checkpoint (`translateMany`), group-delete = 1 checkpoint, marquee-select = **0**
checkpoints (ephemeral selection is never serialized), snap only biases the single move commit.

**D1.1 settled the phantom-undo question and validates this approach** (memory
`undo-lastrecorded-phantom`, D1.1 code comments in `canvasStore.ts`): the phantom-after edge **cannot**
be closed at the store layer by syncing `lastRecorded` — doing so makes the next *real* gesture's
`beginChange` skip its pre-edit checkpoint and breaks granular move-undo. It is closed **only at the
gesture layer** by lazy-checkpointing (`beginChange` at commit, not gesture-start). W2's deferred
`beginChange` IS that pattern, so W2 needs **no** `lastRecorded` handling and calls **none** of the
tracked store actions. No plan-time "verify lastRecorded" step is required.

Selection / `marqueeRect` / `snapGuides` / `snapEnabled` are **session-only**, never written to
`canvas.json` (scene/session split, W1.3 guardrail).

## 5. Testing

**Unit (vitest):**
- `elementBBox` per kind, with and without `measured`; arrow/stroke produce a correct extent box (no
  top-left assumption).
- `anchors` derivation.
- `translateMany` = N independent `translateElement`s, immutable, no-op for absent ids.
- `marquee`: `rectFromPoints` normalization; `rectIntersectsBBox` true on touch / false on disjoint;
  `marqueeHits` returns exactly the intersecting ids (incl. an arrow + a stroke).
- `snapping`: snaps within tol to nearest edge AND center; ignores out-of-tol; emits the right guide;
  axis-independent; board-local (zoom-invariant since inputs are board-local).

**e2e (`src/main/e2eSmoke.ts`, asserted off `getBoards()` — selection *effects*, not internal state;
memory `e2e-whiteboard-probes`):**
- `whiteboard-marquee-drag` — seed 2 notes; box both (down on empty well → moves → up); drag one →
  **both** translate; assert both positions shifted and it's **one** undo step.
- `whiteboard-group-delete` — box 2 → Delete → both removed; undo restores **both** in one step.
- `whiteboard-snap` — drag a note so an edge lands within tol of a neighbor's edge → committed coord
  equals the neighbor anchor (snapped).
- New harness helper `drag(fromBoardPt, toBoardPt)` = pointerdown → several pointermoves → pointerup on
  `.pl-well`, each `dispatchEvent` wrapped in try/catch (`setPointerCapture` throws on synthetic).
  Reuse `planId`; seed count stays `=== 4`.

**Gate before handoff:** `pnpm typecheck && pnpm lint && pnpm vitest run` + board e2e
(`$env:CANVAS_SMOKE='e2e'; pnpm start`). The browser/browser-gesture/focus-detach trio is a known
capturePage env flake (memory `e2e-browser-trio-flake`) — rerun for clean, not a regression.

## 6. Risk register (roadmap 📏 + mitigations)

| Risk | Mitigation |
|---|---|
| Marquee starts over a card | `mode:'marquee'` only when `target===currentTarget` + select tool; cards stop-prop in select mode. |
| Cross-kind bbox assumes w/h | `elementBBox` discriminates; arrow/stroke use point extents. |
| Auto-sized text/checklist stale bbox | nominal fallback (pure) + `measuredRef` live override; guides recompute per frame. |
| Snap not zoom-stable | all snap math in board-local px (dx/dy already board-local). |
| Phantom undo | defer `beginChange` to commit (gesture-layer lazy-checkpoint; D1.1 confirmed the store layer can't close it — §4). |
| Orphan checklist auto-grow on group-delete | delete just filters `elements`; `growForChecklist` is a measured no-op after. |
| Resize/rotate scope creep | selection ring only; **no handles**. |

## 7. File touch list

- `src/renderer/src/canvas/boards/PlanningBoard.tsx` (heavy — selection set, marquee, multi-drag, snap, pill).
- `src/renderer/src/canvas/boards/planning/elements.ts` (+ `elementBBox`, `anchors`, `translateMany`).
- `src/renderer/src/canvas/boards/planning/marquee.ts` (new, pure).
- `src/renderer/src/canvas/boards/planning/snapping.ts` (new, pure).
- `src/renderer/src/canvas/boards/planning/WhiteboardSvg.tsx` (Set selection, marquee + guides render).
- `src/renderer/src/canvas/boards/planning/NoteCard.tsx` · `FreeText.tsx` · `ChecklistCard.tsx`
  (`selected` + `onSelect`; FreeText `onMeasure`).
- `src/renderer/src/canvas/Icon.tsx` (one snap glyph — cross-zone, additive).
- Tests: `elements.test.ts` (extend) · `marquee.test.ts` (new) · `snapping.test.ts` (new).
- `src/main/e2eSmoke.ts` (3 probes + `drag` helper).
- `docs/roadmap-whiteboard.md` (mark W2 done when shipped).
- **`src/renderer/src/store/canvasStore.ts` — NOT touched** (D1.1 owns the undo rail; W2 only calls the
  unchanged `beginChange`/`updateBoard`/`growBoardHeight` API). Listed here to make the boundary explicit.
