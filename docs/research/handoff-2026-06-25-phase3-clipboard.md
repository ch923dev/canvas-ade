# Handoff — Phase 3: copy / cut / paste (in-app element clipboard, Ctrl+C/X/V)

**For:** a worker session (own worktree). **Feature:** cross-board element transfer between Planning
boards. **Umbrella (integration target):** `feat/planning-cross-board-transfer` — **Phases 1 (engine) +
2 (picker) are already merged** (tip `e7dc2316`). **You do NOT merge.** A separate integration session
verifies (e2e) and merges your PR into the umbrella.

Paste the prompt below into a fresh Claude Code session.

---

## PROMPT

You are a worker session for the Canvas ADE **cross-board element transfer** feature — **Phase 3:
copy / cut / paste** via an in-app element clipboard (Ctrl+C / Ctrl+X / Ctrl+V). Reuse the already-merged
Phase 1 engine. Deliver on ONE branch off the umbrella, open ONE PR into the umbrella, then STOP (the
integration session verifies + merges).

### 0. Read first (do not re-litigate locked decisions)
- Spec — `docs/research/2026-06-24-planning-cross-board-transfer.md` › §3.B (copy/cut/paste), §4.1–4.3
  (engine + placement), §5–6 (constraints + edge cases incl. **E7** clipboard-vs-image precedence), §10.
- Phase 1 engine you reuse (already on base `e7dc2316`, in `planning/elements.ts`):
  - `extractForTransfer(els, ids, mode?) → { payload, remaining }` — `payload` is the group-expanded,
    deep-cloned, **origin-normalized** selection (exactly what you store on the clipboard). For `'move'`
    it skips locked members; `remaining` is the source after a cut.
  - `insertTransferred(targetEls, payload, at, newId) → { elements, newIds }` — fresh ids + group remap,
    translate by `at`, append; **paste-twice safe** (re-clones per insert). This is the paste.
- `usePlanningKeyboard.ts` already receives `elements`, `selectedIds`, `setSelectedIds`, `commit`,
  `beginChange`, `newId`, `wellRef` — everything copy/cut/paste needs except a last-pointer ref (§2.4).
- `usePlanningImageIO.ts` — the existing **document-level `paste`** listener (`onWellPaste`) for bitmaps;
  your Ctrl+V must coexist with it (§2.3). There is **no** canvas-level board copy/paste to collide with.
- Project contract — `CLAUDE.md` (scene/session split, undo invariants, single commit path).

### 1. Worktree off the UMBRELLA (has Phases 1+2)
```
pwsh .claude/tools/new-worktree.ps1 -Name planning-xfer-clipboard -Branch feat/planning-xfer-clipboard \
  -Base origin/feat/planning-cross-board-transfer \
  -Zone "planning/elementClipboard.ts (new) + usePlanningKeyboard.ts + usePlanningImageIO.ts + usePlanningPointer.ts/PlanningBoard.tsx (last-pointer ref) — Ctrl+C/X/V"
```
Open a session in `.worktrees/planning-xfer-clipboard`. Verify the engine is present:
`grep -n "extractForTransfer\|insertTransferred" src/renderer/src/canvas/boards/planning/elements.ts`.
Set `$env:CANVAS_DEV_TITLE='worker — xfer clipboard'` for the dev check.

### 2. What to build (spec §3.B)
1. **`elementClipboard.ts`** (new, in `planning/`) — a tiny **ephemeral module-level** store:
   `setClipboard(payload: PlanningElement[])`, `getClipboard(): PlanningElement[] | null`,
   `clearClipboard()`, `hasClipboard(): boolean`. Holds the origin-normalized payload from
   `extractForTransfer`. **NEVER serialized, never the OS clipboard, never into `elements[]`/
   `PATCHABLE_KEYS`** (scene/session split). A module singleton is fine (keyboard reads it imperatively).
2. **Ctrl+C / Ctrl+X / Ctrl+V in `usePlanningKeyboard.ts`** (the focused-well `onKeyDown`). Gate ALL three
   on `tool === 'select'` + the well focused; `stopPropagation()` + `preventDefault()` when you act
   (future-proof against a later global handler; mirror the existing Ctrl+G swallow):
   - **Ctrl/⌘+C** (non-empty selection): `setClipboard(extractForTransfer(elements, selectedIds, 'copy').payload)`.
     No store mutation, no undo step.
   - **Ctrl/⌘+X** (non-empty selection): `const { payload, remaining } = extractForTransfer(elements,
     selectedIds, 'move')`; if `payload.length` → `setClipboard(payload)`, then `beginChange();
     commit(remaining)` (ONE undo step) + `clearSel()`. Lock-precedence is built into `'move'` (locked
     stay in source, not on the clipboard).
   - **Ctrl/⌘+V** (clipboard non-empty): `const { elements: next, newIds } = insertTransferred(elements,
     getClipboard()!, at, newId)`; `beginChange(); commit(next)`; `setSelectedIds(new Set(newIds))`.
     `at` = the last board-local pointer position over THIS well (§2.4), else board center. Pastes into
     the focused board — so paste into a DIFFERENT board (cross-board copy/move) and into the SAME board
     (duplicate) both fall out for free. **Use the board's own `commit`/`beginChange` — NOT
     `transferElements`** (that store action is the atomic cross-board picker/drag path; clipboard
     cut-then-paste are two separate user actions = two separate undo steps).
   - If the clipboard is EMPTY on Ctrl+V → do **nothing** (do NOT preventDefault) so the image-paste
     path still runs (§2.3).
3. **Coexistence with image paste (spec §3.B / E7) — do BOTH:**
   - Primary: the Ctrl+V keydown above `preventDefault()`s when it pastes elements → suppresses the OS
     paste, so the document `paste` event for an image does not fire.
   - **Robust insurance:** in `usePlanningImageIO.onWellPaste`, **defer** when `hasClipboard()` is true
     AND this well owns focus — return early (no image paste). This guarantees no double-paste even if
     keydown-preventDefault-suppresses-`paste` is unreliable in Electron. (Element clipboard = the most
     recent explicit Ctrl+C/X → it wins; E7.)
4. **Last-pointer ref for paste placement** — track the last board-local pointer position over the well
   (a ref updated on the well's `pointermove`; the cleanest spot is `usePlanningPointer` or a thin
   wrapper in `PlanningBoard`), thread it into `usePlanningKeyboard`. Null (no pointer since mount) →
   fall back to the board's content center (`board.w/2 - unionW/2`, clamp ≥16, like the picker §4.3).

### 3. Honor (hard constraints)
- The clipboard + last-pointer ref are **ephemeral** — never serialized / into `elements[]` /
  `PATCHABLE_KEYS`.
- Undo: cut = one step (commit `remaining`), paste = one step (commit inserts). No phantom steps — bail
  (no `beginChange`) when nothing would change (empty selection on C/X, empty clipboard on V).
- Do NOT break the existing image paste (the defer-guard must be exact). No schema bump. No new IPC.
- Security: clipboard is in-memory passive data; nothing reaches a PTY/browser channel.

### 4. Tests
- Unit: `elementClipboard` set/get/clear/has. `usePlanningKeyboard.integration.test.tsx` — copy leaves
  source + sets clipboard; cut removes (lock-precedence: locked stay) + one undo step + sets clipboard;
  paste inserts fresh ids + reselects + one undo step; empty-selection C/X and empty-clipboard V are
  no-ops (no checkpoint). A unit test of the image-paste **defer-guard** (`hasClipboard()` → skip).
- **E2E (`@planning`, real keydown — whiteboard-probe pattern):** seed two planning boards; select in A;
  **Ctrl+C** → focus B → **Ctrl+V** → assert (`getBoards()`) B gained N, A unchanged; **Ctrl+X** in A →
  focus B → **Ctrl+V** → A lost them (locked stay), B gained; paste twice → two distinct sets; one Ctrl+Z
  undoes each step. (Drive real `keydown` with `ctrlKey`; see memory `paste-fires-at-document` +
  `e2e-modifier-keys-synthetic` + `e2e-whiteboard-probes`.) The image-paste regression is best covered by
  the unit defer-guard test; just confirm the existing image-paste e2e still passes.

### 5. Gate — all green BEFORE you report done
- `pnpm typecheck && pnpm lint && pnpm format:check` ; `pnpm test` (unit + integration).
- e2e: **run it MANUALLY** (pre-push SKIPS the matrix on a new branch's first push) — `pnpm test:e2e`
  (Windows leg) green; your new `@planning` copy/paste e2e must pass. (Known unrelated env flakes:
  `browserNetwork`/`osrCropSupersample` @preview — pass on rerun; ignore.)
- Verify `git config core.hooksPath` == `.githooks`.
- **Manual dev check:** `$env:CANVAS_DEV_TITLE='worker — xfer clipboard'; pnpm dev` — actually Ctrl+C in
  one board, Ctrl+V into another (and the same board); Ctrl+X (locked stays); confirm an image paste
  still works when the clipboard is empty. Confirm the window title reads your stamp.
- Open ONE PR: base `feat/planning-cross-board-transfer`, head `feat/planning-xfer-clipboard`; CI `check`
  green.

### 6. Do NOT
- Do NOT merge into the umbrella; do NOT target/branch off `main`.
- Do NOT `pnpm install` from the worktree (symlinked node_modules). Use junctioned deps; `pnpm rebuild`
  if truly needed.
- Do NOT use `transferElements` for the clipboard path (use the board's own `commit`/`beginChange`); do
  NOT route the clipboard into the OS clipboard / persistence / `elements[]`; do NOT break image paste;
  do NOT bump `schemaVersion`.

### 7. Report back
- PR link, green CI, `pnpm test` + `pnpm test:e2e` results, a short clip/notes from the manual dev check
  (copy, cut, paste, image-paste-still-works), any deviation.

---

## Integration session's job (the other/main session) — for reference
On "done": fetch `feat/planning-xfer-clipboard`, confirm it is on the current umbrella tip (rebase if it
advanced), re-run the gate + Windows e2e (`@planning`), confirm CI `check` green, eyeball the diff
(clipboard ephemeral-only, cut/paste via board `commit` — NOT `transferElements`, image-paste defer-guard
exact, one-undo-step each, no schema), then squash-merge into the umbrella and tear down the
branch/worktree. (Full e2e matrix is banked for the eventual umbrella→main PR.)
