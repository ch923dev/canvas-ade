# Handoff — Phase 4: cross-board drag (the LAST phase)

**For:** a worker session (own worktree). **Feature:** cross-board element transfer between Planning
boards. **Umbrella (integration target):** `feat/planning-cross-board-transfer` — **Phases 1 (engine) +
2 (picker) + 3 (clipboard) are merged** (tip `603b07e7`). **You do NOT merge.** A separate integration
session verifies (e2e) and merges your PR into the umbrella. After this lands, the umbrella → main.

This is the **hardest** phase (it fights React Flow's clipped nodes) — but the *drop itself reuses the
already-merged `transferElements`*. The new work is the **gesture + a ghost overlay + a hit-test**.

Paste the prompt below into a fresh Claude Code session.

---

## PROMPT

You are a worker session for the Canvas ADE **cross-board element transfer** feature — **Phase 4:
cross-board drag** (drag a selection out of one Planning board and drop it into another). Plain drag =
**Move**; **Alt-drag = Copy**. Deliver on ONE branch off the umbrella, open ONE PR into the umbrella, then
STOP (the integration session verifies + merges).

### 0. Read first (do not re-litigate locked decisions)
- Spec — `docs/research/2026-06-24-planning-cross-board-transfer.md` › **§3.C (cross-board drag — read in
  full)**, §4.2–4.3 (the store action + placement), §5–6 (constraints + edge cases), §10.
- What you REUSE (already merged on base `603b07e7`):
  - `transferElements(sourceId, targetId, ids, mode: 'copy'|'move', at) → { newIds }`
    (`store/canvasStore.ts`) — **the drop calls THIS** (one undo step; removes from source on move). Same
    atomic path the Phase 2 picker uses. Do NOT reinvent it.
  - `usePlanningPointer.startElementDrag` already `setPointerCapture`s the well + records `drag.current =
    { mode:'move', ids, grabX, grabY, alt, … }` (grab point in source board-local; `alt` = `e.altKey` at
    grab). Captured pointer events keep flowing to the SOURCE well even when the cursor is over another
    board → you get continuous `clientX/Y` across the whole canvas, and React Flow's pane never steals it.
  - `lastPointerRef` (added Phase 3) + `expandGroups`/`elementBBox`/`unionBBox`/`screenToBoard`/`screenScale`.
- Project contract — `CLAUDE.md` (scene/session split, undo invariants, single commit path).

### 1. Worktree off the UMBRELLA (has Phases 1+2+3)
```
pwsh .claude/tools/new-worktree.ps1 -Name planning-xfer-drag -Branch feat/planning-xfer-drag \
  -Base origin/feat/planning-cross-board-transfer \
  -Zone "planning/usePlanningPointer.ts + CrossBoardDragGhost.tsx (new) + PlanningBoard.tsx (data-board-id + ghost) — cross-board drag"
```
Open a session in `.worktrees/planning-xfer-drag`. Verify reuse is present:
`grep -n "transferElements" src/renderer/src/store/canvasStore.ts`. Set
`$env:CANVAS_DEV_TITLE='worker — xfer drag'`.

### 2. What to build (spec §3.C)
The within-board element drag already works. **ADD** a cross-board sub-mode without changing within-board
behavior:
1. **Detect leaving the source well** — in `usePlanningPointer.onWellPointerMove` (move-drag mode only),
   when the cursor leaves the source well's rect, enter cross-board sub-mode. Expose a transient
   `crossBoardDrag` state: `{ cursor:{x,y} (screen), count, target:{ boardId, rect } | null } | null`.
2. **Hit-test the board under the cursor** — `document.elementFromPoint(clientX, clientY)` →
   `closest('[data-board-id]')` → board id. Add `data-board-id={board.id}` to the `.pl-well` in
   `PlanningBoard.tsx` so only Planning wells match (dropping over a terminal/browser board → no match →
   no target). Verify via the store: the board exists, `type==='planning'`, and `id !== sourceId`. Stash
   its `getBoundingClientRect()` as `target.rect`. (Pointer *capture* redirects EVENTS, not
   `elementFromPoint` — this works. The ghost MUST be `pointer-events:none`, §2.3, or it returns itself.)
3. **`CrossBoardDragGhost.tsx`** (new) — a `createPortal(…, document.body)` overlay,
   **`pointer-events:none`**, `position:fixed`, `zIndex` above boards. Renders: a small chip at the cursor
   (`"${count} item${s}"` + a faint union-bbox outline — v1, NOT full-fidelity cards) AND, when
   `target` is set, a highlight **ring** at `target.rect` (the drop-target affordance). All drag UI lives
   in the SOURCE board's portal — no cross-board ephemeral state needed.
4. **Drop** — in `onWellPointerUp`, **branch on `crossBoardDrag.target` FIRST**:
   - **Target set (foreign Planning well):** compute the drop placement in the TARGET board's local space,
     then `useCanvasStore.getState().transferElements(sourceId, target.boardId, drag.ids,
     drag.alt ? 'copy' : 'move', at)`. **Skip the within-board commit entirely** (do not also move/duplicate
     in the source). One undo step (the engine's).
     - Placement (grab-anchor-preserving, §4.3): `grabOffset = { x: grabX − unionMinX, y: grabY − unionMinY }`
       (union = the dragged selection's bbox at drag start, source-local); `cursorTargetLocal =
       screenToBoard(cursor, { originX/Y = target.rect, zoom = screenScale(target.rect.width,
       targetWell.offsetWidth, getZoom()) })`; `at = { x: cursorTargetLocal.x − grabOffset.x, y: … }`,
       clamp ≥ 0. (The payload is origin-normalized, so this lands the grabbed point under the cursor.)
   - **No target (back over source / empty canvas / non-planning board):** the **existing** within-board
     drop, UNCHANGED (move-delta commit, or alt-duplicate). Clear `crossBoardDrag`.
5. **Alt semantics:** plain cross-board drag = **Move** (removes from source); Alt-drag = **Copy** (source
   intact) — consistent with the existing within-board alt = duplicate. `drag.alt` is already captured at
   grab.

### 3. Honor (hard constraints)
- `crossBoardDrag` is **ephemeral** transient gesture state — never serialized / into `elements[]` /
  `PATCHABLE_KEYS`.
- **Within-board drop behavior must be byte-for-byte unchanged** when there is no foreign target (the big
  regression risk — the existing planning drag/duplicate e2e must still pass).
- The drop is `transferElements` (one undo step) — do NOT add a second `beginChange`/`updateBoard` path.
- No schema bump. No new IPC. Renderer-only, sandbox-safe.

### 4. Tests
- Unit: the screen→target-board-local mapping + grab-anchor placement math (pure); the hit-test
  board-resolution (`data-board-id` → planning + not-source) if extractable.
- **E2E (`@planning`) — use REAL OS input (`webContents.sendInputEvent`), NOT synthetic
  `dispatchEvent`:** this gesture is ENTIRELY about `elementFromPoint` hit-testing across CSS-transformed
  boards, and synthetic events bypass hit-testing → **false green** (memory `e2e-sendinputevent-vs-
  dispatchevent`). Seed two planning boards; pointerdown on an element in A → pointermove across to B's
  well → pointerup → assert (`getBoards()`) B gained N at the drop point and A lost them (Move); drop back
  over A / empty canvas → within-board behavior unchanged (no transfer). **Alt-copy caveat:**
  `sendInputEvent` mouse modifiers do NOT reach `e.altKey` (memory `e2e-modifier-keys-synthetic`) — drive
  the Alt-copy variant by holding Alt via a real keyDown, or cover the alt→copy branch by a unit test if
  e2e can't set the flag (note which you chose).

### 5. Gate — all green BEFORE you report done
- `pnpm typecheck && pnpm lint && pnpm format:check` ; `pnpm test`.
- e2e: **run MANUALLY** (pre-push SKIPS the matrix on a new branch's first push) — `pnpm test:e2e`
  (Windows leg) green; your new `@planning` drag e2e must pass. (Known unrelated env flakes:
  `browserNetwork`/`osrCropSupersample` @preview — pass on rerun; ignore.)
- Verify `git config core.hooksPath` == `.githooks`.
- **Manual dev check** (`$env:CANVAS_DEV_TITLE='worker — xfer drag'; pnpm dev`): actually drag a selection
  from one planning board into another (Move), Alt-drag (Copy), confirm the ghost + drop-target ring, and
  confirm dropping back in the source / on empty canvas is unchanged. Confirm the window title stamp.
- Open ONE PR: base `feat/planning-cross-board-transfer`, head `feat/planning-xfer-drag`; CI `check` green.

### 6. Do NOT
- Do NOT merge into the umbrella; do NOT target/branch off `main`.
- Do NOT `pnpm install` from the worktree. Use junctioned deps; `pnpm rebuild` if truly needed.
- Do NOT reinvent the drop commit (use `transferElements`); do NOT change the within-board drop path; do
  NOT let the ghost capture pointer events (`pointer-events:none`); do NOT bump `schemaVersion`.

### 7. Report back
- PR link, green CI, `pnpm test` + `pnpm test:e2e` results, manual-dev-check notes (Move/Copy/ghost/ring/
  unchanged-within-board), which approach you used for the Alt-copy e2e, any deviation. Then STOP.

---

## Integration session's job (the other/main session) — for reference
On "done": fetch `feat/planning-xfer-drag`, confirm it is on the current umbrella tip (rebase if it
advanced), re-run the gate + Windows e2e (`@planning`), confirm CI `check` green, eyeball the diff
(within-board drop unchanged, drop = `transferElements` one step, ghost `pointer-events:none`,
hit-test restricted to planning + not-source, coord mapping across zooms, no schema), then squash-merge
into the umbrella and tear down the branch/worktree. **This is the last phase** → after it lands, open the
**umbrella → main** PR: first `git fetch origin && git rebase origin/main` the umbrella (main has advanced
well past the umbrella's base), resolve any drift, then the FULL e2e matrix (both legs) is mandatory at
that pre-merge gate.
