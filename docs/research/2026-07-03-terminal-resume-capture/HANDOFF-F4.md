# HANDOFF — F4: hook-health surfacing

**Epic:** terminal-resume umbrella (`feat/terminal-resume-umbrella`). **Parallel-safe with F1b**
(F4 is MAIN + Inspector-side; F1b is palette-side — zones disjoint). **Every phase PRs into the
umbrella, never into `main`.**

⚠️ **UI GATE FIRST:** this phase adds visible Inspector chrome. Per CLAUDE.md › *Design artifact
before code*, present the wireframe below (adjust if needed) to the user and get the nod BEFORE
writing implementation code.

## Setup

- Branch `feat/resume-f4-hook-health` off `origin/feat/terminal-resume-umbrella` — **fork AFTER
  the F2 PR merges into the umbrella** (F4 depends on F2's `RECAP_HOOK_EVENTS` +
  all-events `isRecapHookInstalled`).
- Worktree via `pwsh .claude/tools/new-worktree.ps1 -Name resume-f4 -Branch
  feat/resume-f4-hook-health -Base feat/terminal-resume-umbrella`; declare the zone.
- PR base = `feat/terminal-resume-umbrella`.

## Problem (research REPORT.md §5 F4 / RC-3)

The capture hook dies silently: packaged build with no `node` on PATH (`recapRunner === null` →
hook never installed, only a `console.warn` at `src/main/index.ts` ~:386); third-party tooling
clobbering `<project>/.claude/settings.local.json` mid-session (bridgespace — real on this
machine; re-ensure only runs on project OPEN); consent off; cwd mismatch. The user's only symptom
is "Resume never appears" — the "is the hook even working?" class.

## Design (agreed in research; UI needs the nod)

Three pieces:

1. **`recap:health` IPC (MAIN, new small module or extend recapIpc deps):** returns per-board
   `{ runner: 'ok' | 'missing', hookInstalled: boolean, captured: boolean }` where
   `runner` = recapRunner null-ness, `hookInstalled` = `isRecapHookInstalled(projectDir,
   recordScript)` (F2's all-events check), `captured` = the recap map has ANY entry for the
   board. Frame-guarded (`isForeignSender`) + `safeBoardId` like `terminal:resumeCheck`
   (`src/main/terminalResume.ts` is the freshest example of the pattern).
2. **Inspector Session block status line (`TerminalInspector.tsx`):** one quiet line, only when
   something is WRONG (healthy = render nothing):
   - runner missing → `Session capture off — Node.js not found on PATH`
   - hook not installed (consented project) → `Session capture off — hook not installed`
   - consented + agent spawned + no map entry for this board within ~15s of spawn →
     `Capture didn't record this session` (the clobber case, live). Spawn timestamp: the
     terminal runtime store / `TerminalRuntime.sessionStart` MAIN-side; simplest is a renderer
     timer keyed on state flip to 'running' for a claude-launchCommand board.
3. **Self-heal on focus:** on window focus (MAIN `browser-window-focus` or renderer focus →
   IPC), re-run the existing re-ensure (`installRecapHook` — idempotent, no-op-write-guarded)
   for the open consented project. Heals the mid-session settings.local.json clobber without
   waiting for the next project open.

### Wireframe for sign-off (Inspector › Session block, error states only)

```
┌─ SESSION ────────────────────────────┐
│  [Resume session]  [New session]     │   ← existing controls, unchanged
│                                      │
│  ⚠ Session capture off — Node.js    │   ← NEW: single muted line, --warn dot,
│    not found on PATH                 │      fs-11 mono, only rendered on fault
└──────────────────────────────────────┘

variants (one at a time, priority top→down):
  ⚠ Session capture off — Node.js not found on PATH
  ⚠ Session capture off — hook not installed
  ⚠ Capture didn't record this session
healthy state: NO extra line (zero added chrome)
```

Tokens: `var(--warn)` dot + `var(--text-3)` text, matching the Inspector's existing muted rows.
No toast, no modal — Inspector-only (calm/dense doctrine).

## Carry-in from the F2 review (#295, non-blocking — small, same zone)

`resolveBoardTranscript` (`src/main/index.ts`) threads the A4 clocks (`sessionId`/`recordedAt`
for eager-grace + rotation adoption) only when the candidate's recorded path equals the map
entry's TOP-LEVEL `transcriptPath`. The F2 confirmed-capture candidate never matches that, so a
confirmed session that itself rotates while its old file survives resumes the pre-rotation id
(stale fork, not a wrong session — the tail-lineage check still holds). Fix: also match
`entry.confirmed?.transcriptPath === recorded` and thread `confirmed.sessionId`/`confirmed.ts`
as the clocks. One conditional + a unit test beside the existing resolveBoardTranscript coverage.

## Tests

- MAIN unit: health resolver matrix (runner null / hook missing / no map entry / healthy) — pure
  fn + deps injection, mirror `terminalResume.test.ts` style.
- Renderer unit: Inspector renders the right line per health payload; nothing when healthy.
- e2e (`terminalPolish.e2e.ts` or a new `@terminal` spec file if cleaner —
  **coordinate with F1b, which edits the F1/F3 test block in terminalPolish**): drive
  `recap:health` via a MAIN e2e hook (add to `e2eMain.ts` if needed) and assert the Inspector
  line appears/disappears.
- The focus re-ensure: unit-test the handler (install called when consented; not when declined);
  a full e2e of window focus is flaky territory — unit + manual check is enough.

## Zone (declare in ACTIVE-WORK.md)

`src/main/index.ts (recap health wiring + focus re-ensure)` · `src/main/recapIpc.ts or new
recapHealth.ts (+test)` · `src/preload/recapApi.ts` ·
`src/renderer/src/canvas/boards/terminal/TerminalInspector.tsx (+test)` · `TerminalBoard.tsx`
(ONLY the inspector-slot props line — F1b touches resumeSession, disjoint region; note the
shared file on the board) · `e2e/` (new spec preferred to avoid terminalPolish collisions).

## Gate

typecheck · lint · format:check · full unit · pre-push e2e (src/main touched → FULL matrix,
Docker must be running). Manual dev check `CANVAS_DEV_TITLE='PR#NNN resume-f4'` — for the
runner-missing state, fake it by testing the packaged path or injecting a null runner in dev.
Reply inline to every bot [critical]/[warning].

## Epic-end checklist (whoever closes the umbrella — recorded here so it isn't lost)

- Rebase umbrella on `origin/main`; full matrix (`pnpm test:e2e:matrix`) + title-stamped dev check.
- **Real-claude manual check** (the one thing no phase e2e covers): consented project → spawn a
  claude terminal → say hi → quit → Resume appears and actually resumes; check
  `.claude/settings.local.json` carries all THREE hook events and `session-map.jsonl` gains
  `transcriptExists:true` lines on prompts.
- Delete `docs/research/2026-07-03-terminal-resume-capture/HANDOFF-*.md` in the umbrella→main PR
  (doc lifecycle); REPORT.md stays. Build-history entry. `signal-merge.ps1 -Pr <umbrella PR#>`.
- Product call still open for the user: decouple Resume from recap (egress) consent.
