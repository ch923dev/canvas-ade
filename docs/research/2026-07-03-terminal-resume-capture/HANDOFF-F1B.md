# HANDOFF — F1b: palette Resume row gated on validated canResume

**Epic:** terminal-resume umbrella (`feat/terminal-resume-umbrella`). **Parallel-safe with F4**
(zones below are disjoint — F1b is renderer/palette-side, F4 is MAIN/Inspector-side; NEITHER
touches the other's files). **Every phase PRs into the umbrella, never into `main`.**

## Setup

- Branch `feat/resume-f1b-palette-gate` off `origin/feat/terminal-resume-umbrella`
  (fork AFTER PR "F2 capture" merges into the umbrella — F1b doesn't use F2 APIs, but forking
  post-F2 avoids a pointless umbrella-sync later).
- New worktree via `pwsh .claude/tools/new-worktree.ps1 -Name resume-f1b -Branch
  feat/resume-f1b-palette-gate -Base feat/terminal-resume-umbrella` + declare the zone in
  `ACTIVE-WORK.md`.
- PR base MUST be `feat/terminal-resume-umbrella` (`gh pr create --base feat/terminal-resume-umbrella`).

## Problem (from the #294 bot review — recorded as F1b in REPORT.md §5)

The command palette's "Restart terminal: resume session" ROW is listed off the RAW
`selected.agentSessionId` truthiness (`src/renderer/src/canvas/palette/commandRegistry.ts:180`),
not the MAIN-validated `canResume`. A board with a dead stored id (RC-1/2/4) still shows the row;
invoking it safely degrades to a fresh launch (F3), but silently — the user picked "resume" and
got "fresh" with no signal.

The listing is a SYNCHRONOUS snapshot read (`commandRegistry` builds rows from a store snapshot),
so it cannot await `terminal:resumeCheck`. The validated boolean must be PUBLISHED to a store.

## Design (agreed)

1. **New store** `src/renderer/src/store/resumeValidityStore.ts` — tiny zustand map
   `boardId -> boolean` + `setResumeValidity(id, ok)` + `clearResumeValidity(id)` (on board
   removal; mirror how other per-board stores GC — see `terminalRuntimeStore` for the pattern).
2. **Publisher:** `useResumeValidity` (`src/renderer/src/canvas/boards/terminal/useResumeValidity.ts`)
   already computes the fail-closed boolean — add a store write alongside its `setCanResume`
   (same `apply()` path; keep the local state, the hook's return contract must not change).
   Unmount/board-delete → clear the entry (a stale `true` for a deleted board must not linger).
3. **Consumer:** the palette snapshot (`CommandPalette.tsx` ~:110 builds
   `{... agentSessionId: b.agentSessionId}`) additionally carries
   `canResume: useResumeValidityStore.getState().get(b.id) ?? false` (or subscribe properly —
   match how the palette already reads store state); `commandRegistry.ts:180` gates the
   restart-resume row on `selected.canResume` instead of `selected.agentSessionId`.
   Keep `agentSessionId` in the snapshot type if other rows use it; delete it if orphaned.
4. **Fallback toast (part of this phase):** in `usePaletteRestart` + `TerminalBoard.resumeSession`,
   when the user chose RESUME but `resumeLaunch` returns `mode: 'fresh'`, fire the existing toast
   store with `"Session not resumable — started fresh"` (match existing toast copy tone;
   `useToastStore` — see the board-remove Undo toast for the pattern). `mode: 'continue'` needs
   no toast (it IS a resume, of the cwd's most recent session).
   Toast = existing component, no new UI surface → no design-artifact gate.

## Tests

- Store unit test (set/clear/default-false).
- `commandRegistry.test.ts`: update rows-listing cases (`:123` "resume only with agentSessionId"
  becomes "resume only with validated canResume") — snapshot fixtures gain `canResume`.
- `paletteIntent.consumers.integration.test.tsx`: add the fresh-fallback toast assertion
  (resumeLaunch mock returns `{mode:'fresh'}` → toast fired).
- e2e: extend `terminalPolish.e2e.ts` F1/F3 test — after the DEAD-id patch settles
  (`__canvasE2E.resumeCheckState`), open the palette (Ctrl+K) and assert the resume row is
  ABSENT; after the LIVE seeded transcript patch, assert it is PRESENT. Palette e2e patterns:
  `wayfinding.e2e.ts:44` (palette verb) / `CommandPalette.integration.test.tsx`.

## Zone (declare in ACTIVE-WORK.md)

`src/renderer/src/store/resumeValidityStore.ts (NEW)` ·
`src/renderer/src/canvas/boards/terminal/useResumeValidity.ts` ·
`src/renderer/src/canvas/palette/{CommandPalette,commandRegistry}.tsx/ts (+tests)` ·
`usePaletteRestart.ts` + `TerminalBoard.tsx resumeSession` (toast lines ONLY — F4 does not touch
these) · `e2e/terminalPolish.e2e.ts` (the F1/F3 test block — coordinate if F4 edits the same
file; it should NOT).

## Gate (repo standard)

typecheck · lint · format:check · full unit · pre-push e2e (renderer-scoped → Windows leg;
palette/terminal tags). Manual dev check with `CANVAS_DEV_TITLE='PR#NNN resume-f1b'`.
Reply inline to every bot [critical]/[warning]. Epic-end full matrix happens on the umbrella.
