# Handoff — Phase 2: "Send to board…" picker (SendToBoardPanel + menu entry + toast)

**For:** a worker session (own worktree). **Feature:** cross-board element transfer between Planning
boards. **Umbrella (integration target):** `feat/planning-cross-board-transfer` — **Phase 1 (the engine)
is already merged** (PR #243, tip `b163f95f`). **You do NOT merge.** A separate integration session
verifies (e2e) and merges your PR into the umbrella.

Paste the prompt below into a fresh Claude Code session.

---

## PROMPT

You are a worker session for the Canvas ADE **cross-board element transfer** feature — **Phase 2: the
"Send to board…" picker**. Wire the (already-merged) Phase 1 engine to a UI. Deliver on ONE branch off the
umbrella, open ONE PR into the umbrella, then STOP (the integration session verifies + merges). The design
artifact is already approved — go straight to implementation, matching the mock pixel-for-pixel.

### 0. Read first (do not skip; do not re-litigate locked decisions)
- Spec — `docs/research/2026-06-24-planning-cross-board-transfer.md` › §3.A (picker), §4.2–4.3
  (store action + placement), §5–6 (constraints + edge cases), §10 (locked decisions).
- **Approved mock (the visual contract)** — `docs/research/mocks/send-to-board-panel-mock.html` +
  `…-mock.png`. The panel must match it. Lift its styles into the real stylesheet.
- Phase 1 engine you build on (already on this branch's base, `b163f95f`):
  - `transferElements(sourceId, targetId, ids, mode: 'copy'|'move', at) → { newIds }`
    (`store/canvasStore.ts`) — ONE undo step, no-op-guarded. **This does the actual transfer.**
  - `selectOtherPlanningBoards(boards, sourceId) → PlanningBoard[]` (`store/canvasStore.ts`) — the
    destination list.
  - placement helpers, all exported from `planning/elements.ts`: `expandGroups`, `elementBBox`,
    `unionBBox`, `isLocked`.
- Patterns to clone: `BrowserPickPanel.tsx` (the board-picker look + `.ca-port-picker` classes),
  `terminal/usePickerDismiss.ts` (Esc / outside-pointerdown dismissal), `contextMenuEntries.ts` +
  `ElementContextMenu.tsx` (the menu), `store/toastStore.ts` (`showToast({ message, kind?, action } )`
  — `action: { label, run }` is the **Focus** button), `Canvas.tsx` › `focusBoardById` (the canonical
  camera-fit + dim focus path).
- Project contract — `CLAUDE.md` (scene/session split, undo invariants, single commit path).

### 1. Worktree off the UMBRELLA (which now has Phase 1)
```
pwsh .claude/tools/new-worktree.ps1 -Name planning-xfer-picker -Branch feat/planning-xfer-picker \
  -Base origin/feat/planning-cross-board-transfer \
  -Zone "planning/SendToBoardPanel.tsx (new) + contextMenuEntries.ts + ElementContextMenu.tsx + PlanningBoard.tsx + planning.css (Send-to-board picker)"
```
Open a session in `.worktrees/planning-xfer-picker`. **Verify the engine is present** (you are on the
merged tip, not the seed): `grep -n transferElements src/renderer/src/store/canvasStore.ts` must hit.
Set `$env:CANVAS_DEV_TITLE='worker — xfer picker'` for the dev check.

### 2. What to build (spec §3.A)
1. **`SendToBoardPanel.tsx`** (new, in `planning/`) — match the approved mock. Contents:
   - Title "Send N items to…" (N = the group-expanded selection count).
   - A **Copy / Move** toggle (radio), default **Move** (per the mock).
   - The destination list from `selectOtherPlanningBoards(boards, board.id)` (board titles).
   - A **"+ New planning board"** row (sentinel, like `BrowserPickPanel`'s `NEW_BROWSER`).
   - Picking a destination calls back `onPick({ target: <boardId | NEW>, mode })`; host routes + closes.
   - Reuse `usePickerDismiss` (Esc / outside pointerdown). Stop its own pointer/mouse-down like the
     other pickers (`nodrag`). Lift the mock's CSS into `src/renderer/src/styles/boards/planning.css`
     (e.g. `.pl-sendto-*`), using the real `index.css` tokens.
2. **Context-menu entry** (`contextMenuEntries.ts`) — add **"Send to board…"** (after Duplicate).
   - **Enabled** whenever the selection is non-empty (the "+ New planning board" row is always a valid
     destination, so do NOT disable it when there is no other planning board — resolves the spec §3.A
     wording).
   - `onSelect` captures the current (group-expanded) selection and calls a new dep
     `onOpenSendTo(sel)`; the menu closes. Add `onOpenSendTo` to `ContextMenuDeps` + thread it from
     `PlanningBoard` (no submenu primitive — the panel is a separate popover).
3. **Wire it in `PlanningBoard.tsx`** — hold the panel's open/close state + the captured source
   selection; render `SendToBoardPanel` (anchored at the menu/cursor, viewport-clamped like the menu).
   On `onPick`:
   - Compute placement `at` (spec §4.3): center the payload in the target's content box —
     `union = unionBBox(expandGroups(elements, sel).filter(non-locked-on-move).map(elementBBox))`;
     `at = { x: targetW/2 - union.w/2, y: targetH/2 - union.h/2 }`, clamped to ≥ (16,16). Use the
     target board's `w/h` (its defaults for a new board).
   - **Existing board:** `const { newIds } = transferElements(board.id, targetId, sel, mode, at)`.
   - **"+ New planning board":** `addBoard('planning', <free slot>)` → its id → `transferElements(...)`
     into it (center). (addBoard is its own undo step + the transfer one more — acceptable for the New
     case; do not over-engineer coalescing.)
   - **Toast** (spec §3.A / Q3): `showToast({ message: \`${mode==='move'?'Moved':'Copied'} ${newIds.length} item(s) to ${targetTitle}\`, action: { label: 'Focus', run: () => focusBoard(targetId) } })`.
     The **Focus** action must call the canonical `focusBoardById` camera path — thread a
     `onFocusBoard(id)` prop into `PlanningBoard` the SAME way `onFull`/`onDuplicate`/`onStartConnect`
     are threaded from the board-node wrapper (do NOT invent a new camera path; no auto-pan).
   - Reselect nothing in the source on move; close the panel.

### 3. Honor (hard constraints)
- Scene/session split: the panel open-state, the Copy/Move toggle, the captured selection are
  **ephemeral** React state — never serialized, never into `elements[]`/`PATCHABLE_KEYS`.
- Undo: all transfer mutation goes through `transferElements` (already one step) — do NOT add your own
  `beginChange`/`updateBoard` for the transfer.
- No schema bump (reuses Phase 1 + existing kinds). No new IPC.
- Security: Planning content stays passive; nothing reaches a PTY/browser channel.

### 4. Tests
- Unit/component: `SendToBoardPanel` renders the other-board list + "+ New" + Copy/Move; `onPick` fires
  the right `{target, mode}`; the menu entry is disabled only on an empty selection. A placement unit
  test (centered `at`, clamp ≥16) is welcome.
- **E2E (`@planning`, real input — the established whiteboard-probe pattern):** seed two planning boards,
  select elements in A, right-click (`contextmenu` on `.pl-well`) → click "Send to board…" → in the
  panel pick board B with **Copy** → assert (via `getBoards()`) B gained N elements and A is unchanged;
  repeat with **Move** → A loses them, B gains them, **one Ctrl+Z** restores both; "+ New planning
  board" → a new planning board appears holding the elements. (See `e2e/planningKeyboard.e2e.ts` /
  `e2e/mcpPlanning.e2e.ts` + memory's whiteboard-probe pattern for driving right-click + DOM clicks.)

### 5. Gate — all green BEFORE you report done
- `pnpm typecheck && pnpm lint && pnpm format:check` ; `pnpm test` (unit + integration).
- e2e: **run it MANUALLY** — the pre-push hook SKIPS the matrix on a new branch's first push. Run
  `pnpm test:e2e` (Windows leg) green; this phase IS user-facing so your new `@planning` e2e must pass.
  (Known unrelated env flakes: `browserNetwork`/`osrCropSupersample` @preview — they pass on rerun;
  do not chase them.)
- Verify `git config core.hooksPath` == `.githooks`.
- **Manual dev check** (CLAUDE.md): `$env:CANVAS_DEV_TITLE='worker — xfer picker'; pnpm dev` — actually
  right-click a selection, send it to another board (Copy + Move + New), confirm the toast + Focus, and
  confirm the panel matches the mock. Confirm the window title reads your stamp.
- Open ONE PR: base `feat/planning-cross-board-transfer`, head `feat/planning-xfer-picker`; make CI
  `check` green.

### 6. Do NOT
- Do NOT merge into the umbrella; do NOT target/branch off `main`.
- Do NOT `pnpm install` from the worktree (symlinked node_modules — recreates the shared tree / breaks
  electron). Use the junctioned deps; `pnpm rebuild` if a native rebuild is truly needed.
- Do NOT add a second undo path for the transfer (use `transferElements`), bump `schemaVersion`, add a
  submenu primitive, or auto-pan the camera.

### 7. Report back
- PR link, green CI run, `pnpm test` + `pnpm test:e2e` results, a screenshot of the live panel next to
  the mock, and any deviation from the spec/mock.

---

## Integration session's job (the other/main session) — for reference
On "done": fetch `feat/planning-xfer-picker`, confirm it is based on the current umbrella tip (rebase if
the umbrella advanced), re-run the gate + Windows e2e (`@planning`), confirm CI `check` green, eyeball the
diff (ephemeral-only panel state, transfer via `transferElements` only, placement/clamp, toast-Focus uses
`focusBoardById`) + the live-panel-vs-mock screenshot, then squash-merge into the umbrella and tear down
the branch/worktree. (Full e2e matrix is banked for the eventual umbrella→main PR.)
