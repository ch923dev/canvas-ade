# D1.1 — `withChange` undo-rail refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This touches the undo rails → REQUIRED: run the e2e harness before handoff (memory `e2e-before-handoff`), not just unit/typecheck.

**Goal:** Centralize the snapshot-taking logic that five self-contained store actions hand-roll today, so the phantom-undo class (memory `undo-lastrecorded-phantom`, #BUG M3 — the WB-1 class) becomes structurally impossible to reintroduce. **No behavior change a user sees; no schema change; no new dependency.** This is the draw.io track slice **D1.1** (`docs/roadmap-drawio.md`).

**Architecture:** Add one module-level pure helper, `trackedChange(state, nextBoards, selectedId?)`, that performs `recordPast` + `future:[]` + `lastRecorded` sync in ONE place. Route the five self-contained TRACKED actions through it. Leave the gesture-driven and untracked paths untouched (see Scope — this is the part the roadmap oversimplified).

**Tech Stack:** Electron 33 · TypeScript (strict) · React 18 · Zustand · Vitest · node-pty (MAIN).

**Worktree:** `Z:\canvas-ade-withchange` on branch `refactor/withchange-undo` (off `main`). Create via `.claude/tools/new-worktree.ps1` (junctions `node_modules`, skips native rebuild — memory `parallel-agent-worktrees`). All paths below are relative to that worktree root.

**Coordination (REQUIRED before editing):** Add a row to `.claude/coordination/ACTIVE-WORK.md` declaring this worktree's zone = `src/renderer/src/store/canvasStore.ts` + `canvasStore.test.ts`. Cross-check the live board: the `canvas-ade-whiteboard-w1` worktree owns `PlanningBoard.tsx` + whiteboard elements but commits its edits via the existing `beginChange`/`updateBoard(elements)` API — it should NOT modify `canvasStore.ts` core actions. If W1 has added a store action since, coordinate in Notes before proceeding (both touch undo semantics conceptually even when files are disjoint).

---

## Scope — what this refactor does and does NOT touch

The roadmap prose ("collapse `tidyBoards`/`tileBoards`/add/remove/duplicate/undo/redo into one wrapper") is **too broad**. Grounded in the real code (`canvasStore.ts`), the correct scope is narrower. Three corrections:

1. **`beginChange` stays as-is — it CANNOT be folded in.** It fires at *gesture start* (drag in `BoardNode`, draw in `PlanningBoard`), before the mutation, which then happens via *separate* `updateBoard`/`resizeBoard` store calls from the renderer's pointer loop. A gesture spans multiple store calls driven by React components — it is not a single self-contained mutator a wrapper can run. `updateBoard`/`resizeBoard` (the mutation half) also stay — they already correctly clear `future` only on a real value diff (STATE-2 fix at `:315`, `:335`).

2. **`undo`/`redo` stay as-is — they use `applyUndo`/`applyRedo`, NOT `recordPast`.** Different shape (they pop/move snapshots, they don't take one). They already sync `lastRecorded = r.present` correctly (`:451`, `:458`). Out of scope.

3. **`tileBoards(record:false)` stays OUT of the wrapper.** The untracked live-reflow branch (`:386-396`) deliberately does NOT sync `lastRecorded`, with a comment explicitly warning not to "fix" it (syncing there would make the next `beginChange` skip the pre-drag checkpoint). Only the `record:true` branch routes through `trackedChange`. Same for `growBoardHeight`/`setViewport` — untracked, leave alone.

**In scope — the five self-contained TRACKED actions** that today each hand-roll `recordPast(s.past, s.boards)` + `future:[]`:

| Action | Currently syncs `lastRecorded`? |
|---|---|
| `addBoard` (`:233`) | ❌ no — latent phantom-after edge |
| `removeBoard` (`:248`) | ❌ no — latent phantom-after edge |
| `duplicateBoard` (`:263`) | ❌ no — latent phantom-after edge |
| `tidyBoards` (`:343`) | ✅ yes (`:364`) |
| `tileBoards` record branch (`:369`) | ✅ yes (`:399`) |

**Bonus closed by this refactor:** `addBoard`/`removeBoard`/`duplicateBoard` currently DON'T sync `lastRecorded` — so a no-op gesture (a zero-movement titlebar click) immediately after one of them pushes a phantom undo step (the tolerated edge documented in the `tileBoards` comment + memory `undo-lastrecorded-phantom`: "add/remove/duplicate likely share the latent edge"). Routing them through `trackedChange` syncs `lastRecorded` for free → that latent edge is **closed**, and it's testable (Task 2).

---

## The helper

```ts
/**
 * Apply a self-contained board mutation as ONE tracked undo step. `next` is the
 * already-computed next boards array (or the SAME ref / null to signal "no change" —
 * push nothing, leave undo/redo untouched). Centralizes the recordPast + future-clear
 * + `lastRecorded` sync that addBoard/removeBoard/duplicateBoard/tidyBoards/tileBoards
 * each hand-rolled. Syncing `lastRecorded` here closes the phantom-after-no-op edge
 * (#BUG M3) the add/remove/duplicate actions left open by skipping that sync.
 * Pure: takes state, returns a partial — side values (new id) are computed by the caller.
 */
function trackedChange(
  s: CanvasState,
  next: Board[] | null,
  selectedId?: string | null
): Partial<CanvasState> | CanvasState {
  if (next == null || next === s.boards) return s // no-op: don't record / clear redo
  lastRecorded = next
  const base = { past: recordPast(s.past, s.boards), future: [] as Board[][], boards: next }
  return selectedId !== undefined ? { ...base, selectedId } : base
}
```

Each action computes `next` (and any id) outside `set`, then delegates: `set((s) => trackedChange(s, next, id))`.

---

## Gate (run after every task)

```
pnpm typecheck
pnpm test
```
Expected: typecheck silent (0 errors); full suite green (currently 482). **Plus, once, before handoff** (memory `e2e-before-handoff` — undo rails are load-bearing, unit-green ≠ working):
```
pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start   # expect E2E_* / E2E_DONE, exit 0
```

---

## Task 1: Add `trackedChange` + route `tidyBoards`/`tileBoards` (regression-safe first)

Start with the two actions that ALREADY sync `lastRecorded` — routing them through the helper must produce identical behavior, so the existing tests prove the helper is correct before it changes anything.

**Files:** Modify `src/renderer/src/store/canvasStore.ts`.

- [ ] **Step 1 (TDD): assert current tidy/tile behavior is locked.** Confirm `canvasStore.test.ts` already covers: tidy = one undo step; tidy-then-no-op-beginChange pushes no phantom; tile(record:true) = one step; tile(record:false) = untracked (past unchanged) + a real drag after a reflow stays granularly undoable. If any is missing, ADD it now (red→green baseline) before touching code.
- [ ] **Step 2:** Add the `trackedChange` helper (above) at module scope near `lastRecorded` (`:129`).
- [ ] **Step 3:** Refactor `tidyBoards`: keep the `<2 boards` guard, the `tidyLayout` map, and the `changed` computation; replace the final `lastRecorded = boards; return { past: recordPast(...), future: [], boards }` with `return trackedChange(s, changed ? boards : null)`. Keep the `if (!changed) return s` or fold it into the `null` arg — either, but keep ONE clear path.
- [ ] **Step 4:** Refactor `tileBoards` **record branch only**: replace `lastRecorded = boards; return { past: recordPast(...), future: [], boards }` with `return trackedChange(s, boards)`. **Leave the `record:false` branch exactly as-is** (untracked `return { boards }`, no `lastRecorded` sync, comment intact).
- [ ] **Step 5 (gate):** `pnpm typecheck && pnpm test`. The pre-existing tidy/tile cases MUST stay green unchanged — that's the proof the helper preserves behavior.
- [ ] **Step 6: Commit** — `refactor(store): extract trackedChange; route tidy/tile through it (no behavior change)`.

## Task 2: Route `addBoard`/`removeBoard`/`duplicateBoard` (closes the latent edge)

**Files:** Modify `src/renderer/src/store/canvasStore.ts` + `canvasStore.test.ts`.

- [ ] **Step 1 (TDD — RED):** Add three failing cases proving the latent phantom-after edge exists TODAY:
  - `addBoard` → call `beginChange()` with `boards` ref unchanged → assert `past.length` did NOT grow. **This currently FAILS** (after `addBoard`, `lastRecorded` is stale and `past[last] !== boards`, so `beginChange` pushes a phantom).
  - Same shape for `removeBoard` and `duplicateBoard`.
  Run `pnpm test` → confirm the three are RED.
- [ ] **Step 2 (GREEN):** Refactor the three actions to delegate to `trackedChange`, passing the new `selectedId` as the 3rd arg:
  - `addBoard`: compute `id`/`pos`/`board` as today (outside `set`), then `set((s) => trackedChange(s, [...s.boards, board], id))`; still `return id`.
  - `removeBoard`: compute `next` (the existing filter+previewSourceId-clear map) and `sel = s.selectedId === id ? null : s.selectedId` inside the updater; `return trackedChange(s, next, sel)`. NOTE: `filter` always returns a fresh array even for an absent id (matches today's always-record behavior — do not add an existence guard in this pass; if desired, track it as a separate optional follow-up).
  - `duplicateBoard`: compute the clone exactly as today (incl. the `idleOnMountIds.add` side effect for terminals — keep it BEFORE `set`, unchanged), then `set((s) => trackedChange(s, [...s.boards, clone], cloneId))`; still `return cloneId`.
  Run `pnpm test` → the three Task-2 cases now GREEN; everything else still green.
- [ ] **Step 3: Verify the `selectedId` threading.** Existing tests asserting `addBoard`/`duplicateBoard` select the new board, and `removeBoard` clears selection when the removed board was selected, MUST stay green (the `selectedId` arg preserves this).
- [ ] **Step 4 (gate):** `pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `fix(store): sync lastRecorded on add/remove/duplicate via trackedChange (closes phantom-after-no-op edge, #BUG M3 class)`.

## Task 3: Full verification + handoff

- [ ] **Step 1:** `pnpm typecheck && pnpm test && pnpm lint` — all clean.
- [ ] **Step 2 (REQUIRED — undo rails):** e2e harness: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start` → expect `E2E_DONE`, exit 0. (Browser-trio flake is the known env capturePage issue, not a regression — memory `e2e-browser-trio-flake`; rerun for clean if it trips.)
- [ ] **Step 3: Manual undo sanity** (`pnpm dev`): add board → no-op titlebar click → Ctrl+Z once removes the board (no dead step); duplicate → no-op click → Ctrl+Z once; tidy → Ctrl+Z reverses in one step; window-resize reflow (tile record:false) does NOT add undo steps and a board drag after it is still individually undoable.
- [ ] **Step 4:** Update `docs/roadmap-drawio.md` Status table: D1 → in progress / done as appropriate. Mark this plan's `withChange` row.
- [ ] **Step 5: Merge** into `main` sequentially per the coordination rules (re-run the full gate + e2e AFTER the merge — board components interact even when files are disjoint, memory `parallel-agent-worktrees`). Then tear the worktree down via `.claude/tools/remove-worktree.ps1` and mark its ACTIVE-WORK row `done`.

---

## Risks

- **Highest-blast-radius change in the store** — every tracked mutation flows through one helper now. A bug here breaks undo everywhere at once. Mitigation: Task 1 routes the already-correct actions first so the existing suite proves the helper before it changes any behavior; Task 2 is TDD red→green.
- **Do NOT touch `beginChange`/`updateBoard`/`resizeBoard`/`undo`/`redo`/`tileBoards(record:false)`/`growBoardHeight`/`setViewport`** — see Scope. Folding any of these in is the way this refactor silently breaks granular drag-undo or the untracked-reflow contract.
- **Coordination:** `canvasStore.ts` is conceptually shared with whiteboard undo work — declare the zone, check the board, merge sequentially.
- **Invisible payoff, real risk** — this is insurance against future regressions, not a user-facing fix. Sequence it at a clean point (not racing `whiteboard-w1`).

---

## Test seam summary

| Test | Proves |
|---|---|
| tidy = one step; tidy-then-no-op = no phantom (existing) | Task 1 helper preserves behavior |
| tile(record:true) one step; tile(record:false) untracked + drag-after still undoable (existing) | Untracked branch untouched |
| add → no-op beginChange → no phantom (NEW, RED first) | Task 2 closes the latent edge |
| remove → no-op beginChange → no phantom (NEW, RED first) | " |
| duplicate → no-op beginChange → no phantom (NEW, RED first) | " |
| add/duplicate select new board; remove clears selection (existing) | `selectedId` threading intact |
| undo/redo round-trip unchanged (existing) | Out-of-scope paths untouched |
