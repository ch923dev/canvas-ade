# Planning-MCP — canvas-aware nudge (a grown plan never sits under a neighbour)

> Follow-up to Phase 2c, surfaced by a live eyeball. When an agent writes a multi-section plan, the
> host grows the planning board's width/height **in place** (`growBoardWidth`/`growBoardHeight` only
> change `w`/`h`, never `x`/`y`). A board grows from its top-left rightward + downward, so a wide/tall
> plan can grow straight **under** a neighbouring board (the user saw a plan slide beneath a Terminal
> board). Nothing on the MCP-write path was canvas-aware. This is the "host cluster auto-arrange"
> concern (Phase 3) in its minimal form.

## Decision (user-confirmed 2026-06-25)

**Nudge the grown board to open space.** After an MCP write grows the board, if its NEW rect overlaps
another board, move the **whole planning board** to the nearest free slot (reuse `freeSlot` — the same
expanding-ring spiral the spawn path already uses, `PLACE_GAP = 28`). **Other boards always stay put.**

Rejected: tidy-repack the whole canvas (rearranges boards the user didn't touch) and push-neighbours-aside
(moves the boards the user *was* looking at). Nudging only the grown board is the least-surprising and
reuses the existing, tested placement primitive.

## Behaviour / guards

- **Only on growth.** The nudge runs only when the write actually grew the board (`grewW || grewH`).
  A small write into a board the user deliberately placed overlapping does **not** move it.
- **Skip grouped boards.** A board in a Named Group / feature zone is left in place — the zone owns its
  own arrangement; never yank a member out of its cluster.
- **No-op when clear.** `freeSlot` returns the current position when the grown rect doesn't overlap
  anyone, so a plan growing into empty canvas never jumps.
- **Untracked, one undo step.** The reposition uses a new `repositionBoardUntracked` store action —
  the same rails-neutral contract as `growBoardWidth`/`growBoardHeight`: it never touches past/future,
  so the move reverts together with the write (undo restores the pre-write position **and** size **and**
  content) and pushes no separate undo step.

## Changes (renderer-only — no package bump, no schema bump)

- `src/renderer/src/store/canvasStore.ts`: new untracked `repositionBoardUntracked(id, x, y)` action
  (mirrors `growBoardWidth`).
- `src/renderer/src/store/useMcpCommands.ts`: after the grow block in `patchPlanning`, re-read the grown
  board and `freeSlot`-nudge it off any collision (gated on growth + not-grouped). Imports `freeSlot`.
- Tests (`useMcpCommands.test.ts`): collision → nudge clear (neighbour unchanged) · one-undo-step revert
  (position + size + content) · grouped board not moved · grows-into-empty-space not moved · no-growth
  not moved. Plus the two slice-test `CanvasState` stubs gain the new action.

## Out of scope
- **Camera follow** (panning the viewport to the nudged board) — left out so an off-screen write doesn't
  yank the user's view; can be a follow-up.
- **Full Phase 3** — multi-board-per-topic + whole-canvas cluster auto-arrange.
- **Checklist label wrap** (`<input>`→`<textarea>`) — the next follow-up; it touches `ChecklistCard.tsx`
  (the active `planning-cross-board-transfer` lane's zone) so it's coordinated separately.
