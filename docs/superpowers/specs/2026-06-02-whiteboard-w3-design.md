# Whiteboard W3 — Selection follow-ons (design spec)

**Date:** 2026-06-02
**Branch:** `feat/whiteboard-w3` (off `feat/whiteboard` @ `8505a81`, post-W2)
**Track:** Whiteboard feature roadmap ([`docs/roadmap-whiteboard.md`](../../roadmap-whiteboard.md)) › Phase W3
**Depends on:** W2 selection core (`selectedIds: ReadonlySet<string>`, `elementBBox`/`anchors`/`unionBBox`/
`shiftElement`/`translateMany`, `measuredRef`).

## Goal

Ship all four W3 selection follow-ons in one cohesive slice, plus their shared prerequisite (an element
context menu): **alt-drag duplicate · align/distribute · `locked?` · lightweight `groupId` grouping.**
Everything hangs off a right-click **element context menu** (the chosen action surface — calm
Linear/Raycast, hidden until invoked). One PR into `feat/whiteboard`.

Out of scope (locked decisions, do not build): cross-kind z-reorder (structurally blocked by the
SVG-under-DOM split), resize/rotate handles, a props/Tweaks panel, shapes.

## Non-negotiable constraints (carried from the track)

- **One undo checkpoint per gesture** + the `lastRecorded` phantom-undo discipline — every committing
  action calls `beginChange()` exactly once, lazily, right before its `commit(...)`. Selection,
  group-expansion, and menu open/close are ephemeral → **zero** checkpoints.
- **Scene/session split** — `locked`/`groupId` are durable element data (persisted). Selection,
  menu-open, drag drafts stay ephemeral in React/Zustand, never serialized.
- **Calm aesthetic** — one accent, no clutter. Text-row menu with `⌘` hints; align glyphs only in the
  submenu.
- **Sandbox/isolation locked** — no change; whiteboard content stays in renderer DOM.

---

## A. Schema — `locked?` + `groupId?`

Add two **optional** fields to `ElementCommon` (`src/renderer/src/lib/boardSchema.ts:57`):

```ts
interface ElementCommon {
  id: string
  x: number
  y: number
  locked?: boolean   // absent = unlocked
  groupId?: string   // absent = ungrouped; a shared string = same group
}
```

- **Version bump `2 → 3`.** `SCHEMA_VERSION = 3`; add `MIGRATIONS[2] = (doc) => ({ ...doc,
  schemaVersion: 3 })` — a pure no-op marker (optional-absent is already valid; nothing to inject).
  - Old v2 docs migrate cleanly (fields stay absent → unlocked/ungrouped).
  - W3-saved v3 docs are intentionally **not** openable by pre-W3 builds (`migrate` throws on a
    newer-than-supported doc). Acceptable: single-user desktop, no downgrade path needed.
- **Asserts** (`assertPlanningElement`, before the `kind` switch — they are common fields):
  ```ts
  if (el.locked !== undefined && typeof el.locked !== 'boolean') fail('element locked is not a boolean')
  if (el.groupId !== undefined && typeof el.groupId !== 'string') fail('element groupId is not a string')
  ```
- **`toObject` contract comment:** extend the scene/session note to record that `locked`/`groupId` are
  the two new *persisted* element fields (durable, not ephemeral).

> **⚠️ Cross-zone — shared surface.** `boardSchema.ts` is the shared surface; the draw.io D2/D3
> branches may also bump the schema. Coordination rule: whoever lands first takes **v3**; the other
> rebases its bump to **v4** and renumbers its migration key. Flag on `ACTIVE-WORK.md` before editing.

---

## B. Pure helpers (no React, unit-tested)

### New `src/renderer/src/canvas/boards/planning/align.ts`

- `alignElements(els, ids, edge, measured): PlanningElement[]`
  - `edge ∈ {'left','centerX','right','top','centerY','bottom'}`.
  - Target coordinate from the selected set's extreme/center: `left`→min(left), `right`→max(right),
    `centerX`→union-bbox center X (and the Y analogues). Computed over `elementBBox(el, measured.get(id))`.
  - Each selected **unlocked** element shifts on the relevant axis only, by `target − itsAnchor`
    (`anchors()` + `shiftElement()`). Locked selected elements are not moved.
  - `< 2` selected (after excluding locked) → array returned unchanged.
- `distributeElements(els, ids, axis, measured): PlanningElement[]`
  - `axis ∈ {'h','v'}`, needs `≥ 3` movable. Sort by box center on the axis, pin the first and last,
    space the interior elements at equal gaps between them. Shift each by its computed delta on that axis.
  - `< 3` → unchanged.

### Additions to `planning/elements.ts`

- `duplicateElements(els, ids, newId): { next, idMap, cloneIds }`
  - Deep-clone each selected element (structuredClone) with a fresh id from the caller-supplied
    `newId()` (stays deterministic/testable, matching the existing factory convention).
  - **Remap `groupId` consistently:** all clones that shared one source group get one *new* shared
    group id (a fresh group), so a duplicated group stays a group but distinct from the original.
  - Returns the appended array, an old→new id map, and the clone ids (for selection).
- `expandGroups(els, ids): Set<string>` — given base ids, add every element sharing a selected
  element's `groupId`. Idempotent; ungrouped ids pass through unchanged.
- `notLocked(el): boolean` — `!el.locked`.

---

## C. `ElementContextMenu.tsx` (the spine)

New `src/renderer/src/canvas/boards/planning/ElementContextMenu.tsx`.

- **Render:** React **portal to `document.body`**, `position: fixed` at the `contextmenu` event's
  `clientX/clientY` (escapes the well's `overflow:hidden` and the canvas transform). On open the
  right-click handler `preventDefault()`s the native menu and `stopPropagation()`s so it never reaches
  React Flow's pane context handler.
- **Close on:** outside `pointerdown` · `Escape` · any action click · any camera move
  (`useOnViewportChange` → close, since a fixed-position menu desyncs from a moving board).
- **Preview-detach:** while open, register a `useId` token in `previewStore.menuOpen` (the **ref-counted
  `Set`** introduced by the PREV-C fix, already used by the board ⋯ menu). This detaches any overlapping
  Browser board's native `WebContentsView` to a snapshot so the always-on-top native layer can't paint
  over the menu. Token removed on close.
- **Contents — dynamic by selection state** (`count`, `allLocked`, `grouped`):
  | Row | Shown when | Shortcut |
  |---|---|---|
  | Duplicate | ≥1 | ⌘D |
  | Lock / Unlock (label flips on `allLocked`) | ≥1 | ⌘L |
  | Group | ≥2 and not already a single group | ⌘G |
  | Ungroup | selection is grouped | ⌘⇧G |
  | Align ▸ (L/C/R/T/M/B) | ≥2 | — |
  | Distribute ▸ (Horizontal/Vertical) | ≥3 | — |
  | Delete (disabled if `allLocked`) | ≥1 | ⌫ |
- **Style:** text rows + right-aligned `⌘` hints, hairline (`--border-subtle`) separators between
  groups, one accent on hover. The Align submenu uses 6 small align glyphs; everything else is text.
- **Icons:** ~8 additive glyphs to `Icon.tsx` (align-L/C/R/T/M/B + distribute-H/V; reuse existing
  trash/duplicate where present). **Additive only** (cross-zone `Icon.tsx`).

---

## D. PlanningBoard wiring

All in `PlanningBoard.tsx` + the card components.

- **Alt-drag duplicate.** New drag mode `{ mode:'dup'; clones: PlanningElement[]; ids: string[];
  grabX; grabY }`. In `startElementDrag` when `e.altKey`: build `duplicateElements` over the
  group-expanded moving set; render live as
  `viewElements = translateMany([...elements, ...clones], cloneIds, dx, dy)`; on pointer-up commit
  `[...elements, ...clones-shifted-by-final-delta]`, set selection to the clone ids, **one**
  `beginChange()`. Originals stay put (Figma grammar).
- **Lock gating.**
  - Move: `movingIds = movingIds.filter(notLocked)`; empty → no drag. (Locked stays selectable so it
    can be reached for Unlock; it simply never moves.)
  - Backspace/Delete + menu Delete: delete only **unlocked** selected (`elements.filter(el =>
    !(selectedIds.has(el.id) && !el.locked))`).
  - Erase swipe: skip locked in the hit accumulation.
  - Align/distribute: skip locked (handled in the pure helpers).
- **Grouping.**
  - `Group`: assign a fresh `groupId` to all selected (≥2), one checkpoint.
  - `Ungroup`: clear `groupId` on selected, one checkpoint.
  - **Selection auto-expands to the whole group** at every set-point — wrap `selectOnPress` and the
    marquee-hit result in `expandGroups(elements, …)`. Move/delete-together then fall out for free
    (the group is already fully selected).
  - **No z-reorder** (SVG-under-DOM split stays).
- **Keyboard (well-focused, `stopPropagation` so the global window handler never double-fires).** Added
  ahead of `shortcutTool` in the well `onKeyDown`: `⌘/Ctrl+D` duplicate-in-place at **(+12, +12)**;
  `⌘/Ctrl+G` group; `⌘/Ctrl+Shift+G` ungroup; `⌘/Ctrl+L` lock-toggle. Verified non-colliding with the
  Canvas globals (`Ctrl+Z`/`Y`/`Shift+Z` undo-redo, `Ctrl+Shift+D` diagnostics, bare `1`/`0`/`t`,
  `Esc`) — plain `⌘D`/`⌘G`/`⌘L` are all free.
- **Lock affordance.** Cards (`NoteCard`/`FreeText`/`ChecklistCard`) and vector elements
  (`WhiteboardSvg`) take a `locked` prop → a small corner lock glyph + a **muted (non-accent)** selection
  ring so a locked element reads distinct from an editable one. Minimal.
- **Undo discipline.** Each committing action = exactly one `beginChange()` at commit; selection,
  group-expansion, and the menu = zero checkpoints (`lastRecorded` phantom-undo rule).

---

## E. Testing · files · sequencing

### Unit
- `align.test.ts` — each of the 6 align edges; both distribute axes; `<min` no-ops; locked-skip.
- `elements.test.ts` additions — `duplicateElements` (fresh ids; groupId remap = one new shared group);
  `expandGroups` (member→whole group; ungrouped passthrough; idempotent).
- `boardSchema.test.ts` — `migrate` v2→v3 round-trip; a v2 doc (no new fields) still loads; asserts
  reject non-boolean `locked` / non-string `groupId`.

### e2e probes (W2 pattern — real DOM on `.pl-well`, assert off `getBoards()`)
- alt-drag duplicate → element count `+N`, clones at offset, **one** undo restores.
- align-left on 2 notes → both share left x; one undo.
- distribute on 3 → equal center gaps.
- lock → drag is a no-op + Delete leaves it present; unlock → movable again.
- group → click one member selects all (a drag moves the whole group); ungroup splits.
- context menu: synthesize a `contextmenu` event → menu DOM appears → an action click applies + closes.

### Files touched
`lib/boardSchema.ts`, `lib/boardSchema.test.ts`, `planning/elements.ts`, `planning/elements.test.ts`,
new `planning/align.ts` + `planning/align.test.ts`, new `planning/ElementContextMenu.tsx`,
`PlanningBoard.tsx`, `planning/NoteCard.tsx` / `FreeText.tsx` / `ChecklistCard.tsx` / `WhiteboardSvg.tsx`
(`locked` prop + onContextMenu), `Icon.tsx` (additive glyphs), the e2e harness probes,
`docs/roadmap-whiteboard.md` (mark W3 done).

### Internal commit order (one branch, reviewable in chunks)
1. Schema + migration + asserts (+ test).
2. Pure helpers — `align.ts`, `duplicateElements`, `expandGroups`, `notLocked` (+ tests).
3. `ElementContextMenu` shell wired with **Duplicate + Delete only** (proves portal/position/close/
   preview-detach).
4. Wire **lock** (gating + affordance + menu Lock/Unlock + ⌘L).
5. Wire **group** (group/ungroup + selection expansion + ⌘G/⌘⇧G).
6. Wire **align/distribute** (submenus) + **alt-drag dup** + ⌘D.
7. Lock affordance polish + e2e probes + roadmap doc.

Gate after the slice: `pnpm typecheck` + `pnpm lint` + unit (target ~all green) + board e2e (`CANVAS_SMOKE=e2e`)
all parts ok. (CI `format:check` is a known pre-existing repo-wide red — out of scope here.)

## Acceptance

- Right-click a selected element → context menu with the correct dynamic rows; Esc/outside/action/
  camera-move all close it; no native menu; no React Flow pane menu.
- Alt-drag (and ⌘D) duplicate the selection (group-aware) as one undo step; originals unmoved.
- Align (≥2) and Distribute (≥3) reposition the unlocked selection correctly as one undo step each.
- Lock blocks move/delete/erase but stays selectable + unlockable; affordance is visible.
- Group: selecting/marquee-ing one member selects the whole group; move/delete operate group-wide;
  ungroup splits. No z-reorder.
- Schema migrates v2→v3; locked/groupId persist + reload; corrupt types rejected.
- Full gate + board e2e green.
