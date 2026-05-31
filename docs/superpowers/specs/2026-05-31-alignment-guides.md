# Smart Alignment Guides — Spec (2026-05-31)

**Status:** approved (decisions locked 2026-05-31). Research: `docs/superpowers/research/2026-05-31-alignment-guides.md`.

## Problem

Boards on the canvas are positioned by free drag — there is no help lining a set of boards up.
Users want Canva/Figma-style behavior: while dragging a board, show thin guide lines when the
dragged board's edges/centers line up with other boards, and snap it into alignment. Also show
equal-spacing (distribution) guides when the dragged board sits at an equal gap between neighbors.

## Goals

1. **Edge + center alignment** (slice 1): detect when the dragged board's left/centerX/right or
   top/centerY/bottom matches another board's corresponding stop within a zoom-invariant threshold;
   snap the dragged board onto that line; draw a guide line spanning the aligned group.
2. **Distribution / equal-spacing** (slice 2): detect equal horizontal/vertical gaps between the
   dragged board and two-or-more neighbors; snap to equalize; draw gap indicators + spacing labels.
3. Always-on snapping with a **Ctrl (or ⌘) held-mid-drag suppress** escape hatch (Figma parity).
4. Zero new runtime dependency. Pure, unit-tested detection logic mirroring the existing `lib/*.ts`
   convention.

## Non-goals

- Multi-select drag snapping (v1 snaps single-board drags only — canonical helper-lines limitation).
- Snap to viewport/canvas center or stage edges (meaningless on an infinite canvas).
- Snapping during **resize** (only node-drag triggers guides; resize is untouched).
- Persisting guide state (guides are ephemeral drag UI; only the resulting board position persists).
- A guide-line fade-in/animation (guides appear/disappear instantly — reduced-motion-safe by
  construction).

## Locked decisions (2026-05-31 Q&A)

| Topic | Decision |
|---|---|
| Scope | Edge+center **and** distribution, shipped as two slices (edge+center first). |
| Line style | Dashed blue `--accent` (`#4f8cff`), `stroke-dasharray 4 6`, 1px, screen-space (constant thickness at any zoom). |
| Snap behavior | Always-on; holding **Ctrl/⌘** during a drag suppresses snap + guides. |
| Threshold | **8 screen px ÷ current zoom** (world units). |
| Distribution badges | Include the "Npx" spacing label (slice 2), muted on-token text. |
| Render placement | Screen-space SVG overlay, sibling of `<ReactFlow>` inside the pane, `pointer-events:none`, above boards. |
| Snap integration | Mutate `change.position` inside `onNodesChange` **before** `nodeChangesToIntents` (NOT `setNodes` mid-drag — xyflow #4593 jitter). |

## Behavior detail

### Detection (pure)
Dragged rect = `{ x: change.position.x, y: change.position.y, w: board.w, h: board.h }`.
Per axis derive 3 stops:
- Vertical guides (X axis): `left = x`, `centerX = x + w/2`, `right = x + w`.
- Horizontal guides (Y axis): `top = y`, `centerY = y + h/2`, `bottom = y + h`.

For every **other** board, derive its 3 stops per axis. For all 3×3 pairs per axis, `diff =
abs(draggedStop - otherStop)`. Keep the **single smallest** diff per axis that is `≤ threshold`. A
winner yields a snap delta (`otherStop - draggedStop` applied to `x`/`y`) and a guide line at the
matched coordinate, spanning the union extent of the dragged + matched boards on the perpendicular
axis. Result: 0–2 guides (≤1 vertical, ≤1 horizontal).

### Threshold under zoom
`threshold = SNAP_THRESHOLD_PX / zoom` where `SNAP_THRESHOLD_PX = 8` and `zoom = rf.getZoom()` read
imperatively in `onNodesChange` (no re-render). This keeps the "feel" constant across zoom levels.

### Suppress
A global keydown/keyup listener tracks Ctrl/⌘ into a ref. When set during a drag, `onNodesChange`
skips snapping and clears guides — the drag is freehand.

### Rendering
Overlay subscribes to `useStore(s => s.transform)` (`[tx, ty, zoom]`). Each guide projects world →
screen: `screenX = worldX*zoom + tx`, `screenY = worldY*zoom + ty`. SVG `<line>` per guide, 1px
dashed `--accent`. Re-renders on camera move (transform changes) and on guide changes.

### Lifecycle
- `onNodeDragStart` → existing detach-previews + checkpoint (unchanged); guides start empty.
- During drag → `onNodesChange` computes snap + sets `guides`.
- `onNodeDragStop` → clears `guides` (alongside the existing `setNodeGesture(false)`).
- Board deleted mid-drag / no active single-board drag in a change batch → guides cleared.

## Constraints honored

- **Native-view occlusion:** previews are already detached for the whole drag (`Canvas.tsx:256`),
  so the HTML/SVG guide overlay is never occluded by an always-above `WebContentsView`.
- **Security model:** renderer-only, no IPC, no main changes. Untouched.
- **e2e gate:** must pass the `CANVAS_SMOKE=e2e` harness (incl. the known browser-trio env flake,
  rerun for clean) before handoff, per the repo "e2e before handoff" rule.

## Slices

- **Slice 1 — Edge + center alignment + snap + Ctrl-suppress + overlay.** Effort S–M. Plan:
  `docs/superpowers/plans/2026-05-31-alignment-guides.md`. Ships green + committed.
- **Slice 2 — Distribution / equal-spacing guides + spacing labels.** Effort L. Plan authored
  AFTER slice 1 ships (builds on slice-1 overlay + util; planning with real code in hand avoids
  drift). Port the Excalidraw gap algorithm (`getVisibleGaps`, gap-center, dedupe).

## Acceptance (slice 1)

1. Dragging a board whose left/right/center comes within 8px (screen) of another board's
   corresponding stop snaps onto it and shows a dashed blue guide spanning both boards.
2. Same for top/bottom/center (horizontal guide).
3. Holding Ctrl/⌘ during the drag disables snapping and hides guides.
4. Guide lines stay 1px and dashed at any zoom; track pan/zoom live.
5. Guides clear on drag stop. No guide ever persists in `canvas.json`.
6. Resize is unaffected (no guides during resize).
7. `pnpm typecheck`, `pnpm lint`, unit tests, and the e2e harness all green.
