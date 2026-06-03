# Whiteboard W3 — Selection follow-ons (design)

**Date:** 2026-06-02 · **Branch:** `feat/whiteboard-w3` (off `feat/whiteboard` @ `2c4284f`) → targets
`feat/whiteboard`, NOT `main`. · **Track:** `docs/roadmap-whiteboard.md` › Phase W3.

W3 is the payoff for W2's selection set: every feature here is unlocked because selection is now a
`Set<string>` instead of a single id. All four are surfaced through one right-click
**ElementContextMenu**. This is a clean restart — the prior attempt (PR #23, branch deleted) is
**reference only**; it carried a lock-delete-via-X bypass and 3 false-green synthetic e2e probes, both
explicitly designed out below.

## Goal / acceptance

Right-click an element → context menu with lock/unlock, group/ungroup, duplicate, align/distribute
(align ≥2 selected, distribute ≥3). Locked elements resist move / erase / delete (including the
per-element X). Group move/delete acts on the whole group as **one** undo step. Alt-drag duplicates
the selection at the drag offset. Schema round-trips v2 → v3. e2e probes — real OS input where the
gesture maps through the camera transform — are green.

## Non-negotiable constraints (carried from the track + locked decisions)

- **One undo checkpoint per gesture.** Group / align / distribute / alt-dup each = ONE undo step.
  Use the `trackedChange` / `withChange` rail (D1.1, on `feat/whiteboard` via main) and sync the
  module-level `lastRecorded`. A no-op gesture must NOT push a phantom undo step (memory
  `undo-lastrecorded-phantom`; this is the WB-1 class). Mirror the existing defer-`beginChange()`-to-
  the-commit-branch discipline already used by move / arrow / pen / erase in `PlanningBoard.tsx`.
- **Calm one-accent aesthetic** (DESIGN.md): no decorative chrome; the menu uses existing tokens.
- **SVG-under-DOM two-layer split is fixed** — caps cross-kind z-ordering; W3 does NOT touch layering.
- **Scene/session split** — `locked`/`groupId` are PERSISTED element geometry (→ `canvas.json`);
  selection / open-menu / drag-draft stay ephemeral in React/Zustand, never serialized.
- **Sandbox/isolation locked** — whiteboard content stays in renderer DOM, never near the PTY.
- **Zone:** `src/renderer/src/canvas/boards/planning/*` + `PlanningBoard.tsx` + `boardSchema.ts` +
  `src/main/e2e/probes/whiteboard.ts` (+ playlist entry in `e2e/index.ts`). Do NOT touch
  `previewStore.ts`, `canvasStore.ts`, or other sessions' zones.

---

## A. Schema — `boardSchema.ts` v2 → v3

- Add two **optional** fields to `ElementCommon` (`:57`):
  ```ts
  interface ElementCommon {
    id: string
    x: number
    y: number
    locked?: boolean   // W3: resist move/erase/delete; absent ⇒ unlocked
    groupId?: string    // W3: lightweight grouping (move/delete-together)
  }
  ```
  Both optional → every existing v2 element stays structurally valid. Consumers read
  `el.locked ?? false`; group membership is `el.groupId` truthiness.
- `SCHEMA_VERSION = 3`.
- `MIGRATIONS[2]` = additive **no-op**: `(doc) => ({ ...doc, schemaVersion: 3 })`. We deliberately do
  **NOT** default-inject `locked: false` into every element — `?? false` reads identically and
  injection bloats every persisted element + every autosave. (Deviates from the brief's
  "default-inject false" Excalidraw nugget; the leaner form is chosen.)
- `assertPlanningElement`: at the `ElementCommon` level (before the `kind` switch), reject a present-
  but-wrong `locked` (must be boolean) or `groupId` (must be string). Keeps the deep-validation
  contract that backs the `canvas.json.bak` fallback.
- **Cross-zone (schema v3):** the draw.io track (D2 Mermaid / D3 anchored-arrows) also wants a bump.
  As of 2026-06-02 D2/D3 are NOT started → **v3 is W3's**. Re-verify before landing: first-to-land
  takes v3, the other rebases to v4.

## B. Pure helpers (no React, no store — unit-tested in isolation)

### New `planning/align.ts`
Pure math over the existing `BBox` / `elementBBox` / `anchors` / `unionBBox` helpers in `elements.ts`.

- `type AlignEdge = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'`
- `alignElements(els, ids, edge, measured?): PlanningElement[]` — compute the selection's union (or the
  target edge) and shift each selected element so its corresponding anchor matches. Horizontal edges
  (left/centerX/right) move x only; vertical (top/centerY/bottom) move y only. Uses `shiftElement` so
  arrows/strokes translate correctly (no top-left assumption). ≤1 selected ⇒ no-op (returns input).
- `type DistributeAxis = 'h' | 'v'`
- `distributeElements(els, ids, axis, measured?): PlanningElement[]` — sort selected by bbox min on the
  axis; pin the two endpoints; space the interior elements so the **gaps** between successive bboxes
  are equal. <3 selected ⇒ no-op. (Equal-gap, not equal-center — matches Figma "distribute spacing".)
- `measured?: Map<id, {w,h}>` threaded through for the auto-sized kinds (text, checklist), exactly as
  marquee/snap already do; falls back to `elementBBox`'s nominal sizes.

### `elements.ts` additions
- `isLocked(el): boolean` — `el.locked === true`. The single lock predicate.
- `expandGroups(els, ids): Set<string>` — for every selected id whose element has a `groupId`, add all
  elements sharing that `groupId`. Returns the expanded id set (superset of `ids`). Idempotent;
  ungrouped ids pass through unchanged.
- `duplicateElements(els, ids, dx, dy, newId): { elements, newIds }` — clone each element in `ids`
  (after the caller has expanded groups), assign a fresh `newId()` per clone, shift by `(dx,dy)` via
  `shiftElement`, and remap `groupId` so each ORIGINAL group becomes one FRESH group among the copies
  (a `Map<oldGroupId, newGroupId>`). Returns the new full elements array + the ids of the copies (for
  reselection). Originals untouched.
- `groupElements(els, ids, groupId): PlanningElement[]` — set `groupId` on every element in `ids`
  (one fresh shared id). `ungroupElements(els, ids): PlanningElement[]` — delete `groupId` on every
  element in `ids` whose group is represented in the set.
- `setLocked(els, ids, locked): PlanningElement[]` — set/clear `locked` across `ids`.

All immutable (map/filter), caller supplies ids (deterministic, testable).

## C. `ElementContextMenu.tsx` (new component)

A small popover menu, **portal-rendered to `document.body`**, positioned at the pointer's raw
`clientX/clientY` with viewport edge-flip (open up/left near an edge). Rationale:

- Positioning by raw screen coords (NOT `toBoard`) **sidesteps the camera-transform coordinate trap
  entirely** — there is no board-local mapping to get wrong (the class of bug that sank the prior
  full-view work).
- A portal escapes the well's `overflow:hidden`, so the menu is never clipped at board edges.

Props: `{ x, y, items, onClose }`. Items are computed by the board from the resolved target set:

| Item | Enabled when | Action |
|---|---|---|
| Lock / Unlock | always (label reflects whether all selected are locked) | `setLocked(set, !allLocked)` |
| Group | ≥2 selected AND not already exactly one group | `groupElements(set, freshId)` |
| Ungroup | any selected element has a `groupId` | `ungroupElements(set)` |
| Duplicate | always | `duplicateElements(expand(set), +12,+12)` → select copies |
| Align ▸ | ≥2 selected | submenu L/C/R/T/M/B → `alignElements` |
| Distribute ▸ | ≥3 selected | submenu H/V → `distributeElements` |
| Delete | always (excludes locked) | selection-based delete (group-expand, lock-filter) |

Close on: item pick, outside pointerdown, Escape, scroll/zoom. Each committing action takes ONE
checkpoint.

**Select-then-act (the approved right-click model):** on `contextmenu` over an element, if that
element is NOT in `selectedIds`, replace the selection with just it; if it IS already in a
multi-selection, keep the whole set. Then open the menu on the resolved set. (`onContextMenu` is
dispatched on the element node, so the target is unambiguous — no transform hit-test needed to know
which element was right-clicked.)

**Known minor limitation (documented, not fixed):** a portal menu opened directly over a Browser
board's native `WebContentsView` elsewhere on the canvas would be painted over by that native layer
(the inherent occlusion property). Rare + transient (cursor-anchored popover). Fully solving it means
registering the menu in `previewStore` so live previews detach while it is open — `previewStore.ts` is
OUT of this branch's declared zone, and the existing board ⋯ menu has the identical class. Deferred /
to-coordinate, consistent with the prior attempt.

## D. Wiring in `PlanningBoard.tsx`

- **`onContextMenu` on `.pl-well`** (and bubbling from element cards / the SVG layer): `preventDefault`,
  run select-then-act, set ephemeral `contextMenu: { x, y } | null` state, render `<ElementContextMenu>`.
- The menu's actions call the pure mutators (B) through the existing `commit` + deferred `beginChange()`
  pattern. Selection of duplicated copies via `setSelectedIds(new Set(newIds))`.

## E. Centralized lock gate (kills the lock-delete-via-X bypass)

`isLocked` applied at ALL FOUR mutation entry points — the prior attempt missed the X:

1. **`startElementDrag` (`:258`)** — if the pressed element is locked → return (no drag). When dragging
   a multi-selection, build `movingIds` then filter out locked siblings (lock wins; a locked member of
   a dragged set stays put). If the filtered set is empty → no drag.
2. **Keyboard Delete handler (`:594`)** — delete set = `expandGroups(selectedIds)` minus locked.
3. **Per-element X `deleteEl` (`:199`)** — early-return if `isLocked(el)`. (THE bypass the prior run
   shipped — explicitly closed + e2e-guarded.)
4. **Erase hit-test (`:339` down, `:395` move)** — skip locked elements in the `eraseHitTest` loop.

Locked elements remain **selectable** (marquee + click + right-click) so the user can unlock them.

## F. Group × lock precedence

**Lock always wins, applied AFTER group expansion.** For move and selection-based delete:
`set = expandGroups(selectedIds)` → then `movable/deletable = [...set].filter(id => !isLocked)`. A
locked element inside a moved/deleted group is left in place. Single-element X stays single (see C/E).

## G. Alt-drag duplicate mechanics

- `drag.current` for `mode:'move'` gains `alt: boolean`, read from `e.altKey` at pointer-down in
  `startElementDrag`. The moving/duplicating set = `expandGroups(selectedIds-or-[id])`.
- **Live render:** when `alt` is set, `viewElements` shows the originals IN PLACE plus translated ghost
  copies shifted by the live delta (a second branch beside the existing `dragPos` move branch), so the
  user sees the copy being dragged out — not the originals moving.
- **Commit (pointer-up):** if `alt` AND moved (`dx||dy`), `beginChange()` once, then
  `duplicateElements(expandedSet, dx, dy, newId)` → append copies, `setSelectedIds(newIds)`. Originals
  untouched. Snapping (W2) applies to the copy delta exactly as to a move. A zero-move alt-grab = no
  duplicate, no checkpoint (phantom-undo discipline).
- Non-alt drag is unchanged (normal move).

## H. Testing

### Unit (Vitest — sonnet authors with TDD)
- `align.test.ts` — each of the 6 align edges; distribute H/V equal-gap; degenerate 0/1/2-element
  cases are no-ops; mixed-kind sets (note + arrow + stroke) align by bbox, not by raw x/y.
- `elements.test.ts` extends — `duplicateElements` (fresh ids, fresh per-group `groupId`, correct
  shift across all kinds, originals untouched), `expandGroups` (pulls siblings, idempotent, ungrouped
  pass-through), `groupElements`/`ungroupElements`/`setLocked`/`isLocked`.
- `boardSchema.test.ts` extends — v2 doc migrates to v3 (round-trip, no element mutation);
  `assertPlanningElement` rejects non-boolean `locked` / non-string `groupId`; v3 element with both
  fields round-trips.

### e2e (`probes/whiteboard.ts`, registered in `e2e/index.ts` PLAYLIST before `seed`)
Four new probes. **Real OS input (`win.webContents.sendInputEvent`) for any gesture whose result maps
through the camera transform** (alt-drag offset, a click that must land at a board-local point under a
scaled board) — synthetic `dispatchEvent` false-greens transform hit-testing (memory
`e2e-sendinputevent-vs-dispatchevent`). **Poll for the post-action state** (a fixed delay flakes on a
contended host). Element-count / geometry / `locked` / `groupId` read off `window.__canvasE2E.getBoards()`.

1. `whiteboard-alt-dup` — select a note, alt-drag it +Δ via REAL input → element count +1, the copy
   sits at the offset, original unmoved, ONE undo step restores to the pre-dup count.
2. `whiteboard-align` — seed misaligned notes, marquee-select, invoke align-left (via the menu action
   or the exposed hook) → all share the min-left x; one undo step.
3. `whiteboard-lock` — lock a note, then prove it resists: a drag leaves x unchanged, an erase swipe
   over it leaves count unchanged, Delete with it selected leaves it, and the per-element X leaves it
   (the bypass guard). Unlock → it deletes normally.
4. `whiteboard-group` — group two notes; dragging one moves both; deleting one (selection-based)
   deletes both; each is ONE undo step; ungroup → they move independently again.

### Gate before handoff (memory `e2e-before-handoff`)
`pnpm typecheck && pnpm lint && pnpm run format:check && pnpm test` all green, AND
`CANVAS_SMOKE=e2e` → `E2E_DONE ok:true` (kill stray electron first; the browser-trio is a known env
flake — rerun for clean, memory `e2e-browser-trio-flake`). Unit/typecheck green ≠ working.

## I. Execution model

Subagent-driven via the Workflow tool (per the approved "use workflow"), mirroring the prior cadence:
pure helpers (`align.ts`, `elements.ts` mutators, schema) fan out to **sonnet** subagents each with a
failing unit test first (TDD); the React wiring (`PlanningBoard.tsx`, `ElementContextMenu.tsx`) on
**opus**. Per-task two-stage review + a final holistic review (the prior holistic pass is what caught
the lock-via-X bypass — keep it). Commits via the Bash tool use a quoted heredoc `git commit -F -`
(backticks in `-m` get shell-substituted — memory `bash-tool-commit-backticks`). The detailed
task breakdown + ordering lands in the implementation plan (next step).

## J. Out of scope (YAGNI / structurally blocked)

- Cross-kind z-reorder / bring-to-front (SVG-under-DOM split blocks it — whiteboard rewrite).
- Nested groups (flat `groupId` only).
- Resize / rotate handles (a transform subsystem; disproportionate for a sketch surface).
- Keyboard Ctrl+G / Ctrl+D / Ctrl+L shortcuts — menu + alt-drag are the only surfaces for v1.
- `previewStore` occlusion fix for the portal menu (out of zone; documented limitation).
