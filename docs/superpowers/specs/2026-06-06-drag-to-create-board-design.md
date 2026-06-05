# Design — Drag-to-create board placement (+ dock → top-center)

**Date:** 2026-06-06 · **Branch:** `feat/redesign-pass` · **Status:** approved design, pre-plan.

## Summary

Replace the dock's instant click-spawn with a **placement gesture**: clicking a dock button
(`+Terminal` / `+Browser` / `+Planning`) *arms* a placement mode instead of spawning. The user then
either **clicks** the canvas (spawns a default-size board at the click point) or **drags out a
rectangle** (spawns a board at that exact position + size). The gesture mirrors the Planning
whiteboard's marquee (press → drag → release, corner-normalized rect, live ghost preview) — same
gesture, different outcome (marquee *selects*; this *creates*). The board dock also moves from
bottom-center to **top-center**.

This is the Figma/tldraw "draw a frame" interaction. Scoped, additive, no schema change.

## Goals

- Click a dock button → arm placement (no immediate spawn).
- **Click** on canvas → default-size board centered on the click point.
- **Drag** on canvas → free-form board sized to the dragged rect (clamped to the minimum).
- Move the dock to top-center (mirror of the current bottom-center island).
- Stay on-pattern (marquee / `usePlanningPointer` / HTML-overlay guides), perf-safe (no per-frame
  store writes), and keep `Canvas.tsx` thin.

## Non-goals (YAGNI)

Snap-to-neighbor while dragging · Shift-to-lock-aspect · sticky multi-board placement (tool reverts
to select after each create) · drag-create from the EmptyState (its buttons keep instant centered-add).

---

## Current behavior (grounded)

- `AppChrome.tsx` `Dock` (`:352`, styles `:462`) sits **bottom-center** (`bottom:18, left:50%,
  translateX(-50%)`). Buttons call `onAdd(type)` immediately.
- `onAdd` → `Canvas.tsx` `addCentered` (`:411`): board spawns at `DEFAULT_BOARD_SIZE[type]`
  (terminal `420×340`, browser `700×500`, planning `516×366` — `boardSchema.ts:179`), **centered in
  view**, nudged to a free slot via `freeSlot`, auto-selected.
- `addBoard(type, at, opts)` (`canvasStore.ts:337`) currently takes only `opts?: { id? }`.
- `MIN_BOARD_SIZE = { w: 240, h: 160 }` (`boardSchema.ts:176`).
- Planning marquee geometry: `rectFromPoints(ax,ay,bx,by)` normalizes any two corners to a
  positive-size box (`planning/marquee.ts:10`).
- The store only serializes `{schemaVersion, viewport, boards}` (`boardSchema.toObject`); store
  fields outside that slice are inherently non-persisted (scene/session split).
- React Flow pans on left-drag-on-pane by default (`panOnDrag`).

---

## Design

### 1 · State model — `store/canvasStore.ts`

Add an **ephemeral** field (auto-excluded from persistence — not in the serialized slice):

```ts
placement: BoardType | null         // armed type, or null = not armed
setPlacement(type: BoardType | null): void
```

`tool: 'select'` is unchanged. "Armed" ≡ `placement !== null`.

Extend `addBoard`:

```ts
addBoard(
  type: BoardType,
  at: { x: number; y: number },
  opts?: { id?: string; size?: { w: number; h: number }; exact?: boolean }
): string
```

- `const size = opts?.size ?? DEFAULT_BOARD_SIZE[type]` — back-compat (omitted = today's default).
- `exact === true` → place at `at` verbatim, **skip `freeSlot`** (drag-create: honor the exact
  rectangle the user drew). `exact` falsy → `freeSlot` nudge as today (click-spawn: avoid landing
  exactly on another board).
- Existing min-size clamp / `assertBoard` validation still applies (sub-min sizes already floored).

### 2 · Gesture — new `canvas/hooks/useBoardPlacement.ts`

A hook owning the pointer state machine + ghost-rect state, wired in `Canvas.tsx`. Active only while
`placement !== null`.

| Event | Action |
|---|---|
| pointerdown on the pane | record `start` in **screen** coords; begin drag; capture pointer |
| pointermove | ghost rect = `rectFromPoints(start, current)` in **screen px** (pixel-perfect under the cursor; no conversion mid-drag) |
| pointerup, displacement `< THRESHOLD` (5px) | **click** → default-size board centered on the click point. The hook reads `DEFAULT_BOARD_SIZE[type]`, computes the top-left `at = { x: pt.x - w/2, y: pt.y - h/2 }` (`pt` = `screenToFlowPosition(clickPt)`), calls `addBoard(type, at, { exact:false })` |
| pointerup, displacement `≥ THRESHOLD` | convert both ghost corners via `rf.screenToFlowPosition` → `placementRect` (normalize + min-clamp) → `addBoard(type, { x, y }, { size:{w,h}, exact:true })` (`{x,y}` = the rect's top-left) |
| Escape (while armed, drag or idle) | cancel: clear ghost + `setPlacement(null)` |
| after any create | `setPlacement(null)` → reverts to select |

- **Click point centering:** screen click → `rf.screenToFlowPosition` → world point; place the
  default-size board centered on it (`x = pt.x - w/2`, `y = pt.y - h/2`).
- **Pan conflict:** while armed, pass `panOnDrag={false}` to React Flow so left-drag draws instead of
  panning; re-enable on disarm. Wheel-zoom still works.
- **Board interactions:** while armed, the pane is in placement mode — pointerdowns draw a new board
  rather than hitting existing boards (tldraw tool-mode behavior). (Implementation: the placement
  pointer handler is on the pane wrapper and consumes the gesture while armed.)
- **Off-pane release:** use the last known pointer point; the world conversion + min clamp still yield
  a valid rect.

### 3 · Pure helper — new `lib/placement.ts`

Extract the conversion/threshold math as a pure, unit-testable unit (keeps the hook thin and matches
the `marquee.ts` / `tidyLayout.ts` "pure geometry" pattern):

```ts
/** screen displacement → is this a click (below threshold) or a drag? */
export function isClickGesture(dx: number, dy: number, threshold = 5): boolean

/** two world corners → normalized, min-clamped board rect */
export function placementRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  min = MIN_BOARD_SIZE
): { x: number; y: number; w: number; h: number }
```

`placementRect` reuses `rectFromPoints` for the normalize, then clamps `w/h` up to `min` (growing from
the top-left so the rect never inverts).

### 4 · Dock move — `canvas/AppChrome.tsx`

- `styles.dock`: `bottom: 18` → `top: 14` (aligns with the `tl`/`tr` islands at `top:14`); keep
  `left: '50%', transform: 'translateX(-50%)'`. Top-left (project switcher) + top-right (camera
  cluster) unchanged.
- `Dock` buttons (`:366`): `onClick` changes from `onAdd(type)` to `setPlacement(type)` (arm). The
  select `ToolBtn` clears placement (`setTool('select')` + `setPlacement(null)`). A `DockBtn` shows
  the `active` style when `placement === type`.
- `AppChromeProps.onAdd` stays (still used by `EmptyState`); the Dock no longer calls it.

### 5 · Ghost visual — overlay in `Canvas.tsx`

A screen-space `<div>` in the canvas overlay layer (sibling to `AlignmentGuides`), `pointerEvents:
'none'`:

- `1px solid var(--accent)` border, `var(--accent-wash)` fill, board border-radius.
- Corner chip: `TypeGlyph type={placement}` + the type label.
- Pane cursor → `crosshair` via a CSS class applied while `placement !== null`.
- Below-min drags simply clamp on release (no special hint — calm, per DESIGN.md).

### 6 · Folded-in defaults

- **Click-spawn position** = centered on the click point (not view-center).
- **Browser preset** (390/834/1280) is **independent** of the drag size — the frame is what you draw;
  the responsive preset stays the board's default and is switched via the existing segmented control.
- **Threshold** = 5px screen displacement separates click from drag.

---

## Files touched

| File | Change |
|---|---|
| `src/renderer/src/store/canvasStore.ts` | `placement` + `setPlacement`; `addBoard` `size` + `exact` opts |
| `src/renderer/src/canvas/AppChrome.tsx` | dock → top-center; buttons arm; select clears; active state |
| `src/renderer/src/canvas/hooks/useBoardPlacement.ts` | **NEW** — pointer state machine, ghost state, Esc cancel, `panOnDrag` toggle |
| `src/renderer/src/canvas/Canvas.tsx` | wire hook; render ghost overlay; gate `panOnDrag` on `placement`; crosshair class; keep `addCentered` for EmptyState |
| `src/renderer/src/lib/placement.ts` (+ `placement.test.ts`) | **NEW** pure helper: `isClickGesture` + `placementRect` |
| `e2e/placement.e2e.ts` | **NEW** real-OS-input drag-through-camera test |
| `docs/testing/TESTING.md` | add the placement e2e sliver to the Browser/canvas area row |

---

## Testing (Testing Trophy)

- **unit** `lib/placement.test.ts` — `placementRect` normalize + MIN clamp (incl. inverted / sub-min
  corners); `isClickGesture` threshold both sides.
- **unit** `canvasStore.test.ts` — `addBoard` with `size` → board has dragged `w,h`; without → default;
  `exact:true` skips `freeSlot` (places verbatim); `setPlacement` toggles and is absent from
  `toObject()`.
- **integration (jsdom)** `AppChrome` — clicking a dock button sets `placement===type` (does NOT add a
  board); the active style reflects it; the select button clears placement.
- **e2e** `e2e/placement.e2e.ts` — a genuinely new native surface (drag through the live camera
  transform, which synthetic `dispatchEvent` false-greens — memory `e2e-sendinputevent-vs-dispatchevent`):
  arm a dock button → `sendInputEvent` drag on the pane → assert a board of type T is created at the
  dragged **world** position + size (read via `__canvasE2E`); a sub-threshold click → default size
  centered at the cursor; Escape mid-arm cancels (no board). Reuse the whiteboard e2e probe shape.

**Tier rationale:** coordinate math is unit (pure fn); arming state is integration (store + render); the
real-drag-through-camera is the only e2e (native transform hit-testing) — same class as the full-view
add-note bug three synthetic probes missed.

---

## Risks / notes

- **`panOnDrag` toggle** is the subtle part: it must re-enable on every disarm path (create, Escape,
  switching to select) or the canvas gets stuck unpannable. Cover the re-enable in the e2e.
- **Rebrand #17 (MERGES LAST)** rewrites `index.css` + UI chrome strings; the dock-move touches
  `AppChrome.tsx` layout (not strings) and `index.css` only for the crosshair class + ghost tokens —
  low collision, but flag on the coordination board.
- No schema bump (placement is ephemeral; size persists via the existing `boards[].w/h`).
- `Canvas.tsx` is already thin post-Wave-5 B5; the new logic lands in `useBoardPlacement` + `placement.ts`,
  not inline (preserves the split).
