# KICKOFF — Jarvis review wave (pre-J4 hardening)

**Lane:** `fix/jarvis-review-wave` → PR into `feat/jarvis-umbrella` (NOT main).
**Base:** umbrella @ `ce1323be` (0.17.0 = J1+J2+J3+panel, synced with main through #340,
jarvisBoot extraction). **Version bump: 0.17.1** (fix wave).
**Source of truth:** `docs/reviews/2026-07-13-jarvis-epic-review/REVIEW.md` (this branch) —
consolidated 4-pass deep review of the whole epic diff. Read it first; every item below
references its finding ids.

## Why before J4

J4 (hands / tool use) builds directly on the turn lifecycle and the mic-gate:

- BRAIN-1/2 are IN the turn path J4 extends with tool_use round-trips — fix the abort race
  and the crash sink before adding more await hops to that chain.
- MIC-1/2 break the panel's headline structural invariant; J4's confirm chip assumes the
  panel/mic state machine is trustworthy.
- TTS-1 is an app-exit on a routine disk condition — ships to nobody.

## Scope (P0 + P1 from the review — 10 items)

1. **MIC-1** arm-generation token + post-await `panelOpen` re-checks in `setConverseMode(true)`
   (`jarvisSession.ts`). Unit: close-during-arm leaves no consumer/capture. e2e: double-tap
   hotkey → store asserts converse off + capture off.
2. **MIC-2** unconditional `stopVoice()` on disarm (or stop-pending latch). Unit beside MIC-1.
3. **TTS-1** `'error'` listener on the download write stream → reject → existing cleanup;
   fix BOTH `voiceTtsModels.ts` and the pre-existing `voiceModels.ts:273-289` (STT). Regression
   test: stream that errors mid-write → `ok:false`, single-flight released, no throw.
4. **BRAIN-2** `.catch` on the turn IIFE + `isDestroyed()` guard in `push` (`jarvisIpc.ts`).
   Test: destroyed-window push mid-stream → no unhandledRejection.
5. **BRAIN-1** `signal.aborted` checks at `streamJarvisReply` entry + after the `getAppModel`
   await. Tests: pre-aborted signal → no fetch; abort-during-manifest → no fetch.
6. **TTS-2** delete keep-set covers shared components of in-flight installs (`voiceTtsModels.ts`
   + guard in `voiceIpc.ts`). Test: cross-model delete-during-download keeps espeak.
7. **TTS-3** explicit user download force-refetches (or hash-verifies) landed components.
8. **ESC-1** scope the panel Esc to panel-contained targets; restore one-Esc-one-layer
   (check `useCanvasKeybindings.ts` full-view precedent). e2e: Esc in terminal board with panel
   open reaches the terminal.
9. **HIST-1** wire `clearTurns`/`hydrateTurns` on project switch + panel mount (decide: MAIN
   `jarvis:history:get` read-back vs clear-on-switch; document the choice in the PR).
10. **TTS-4** flush watermark → max ACCEPTED id (renderer-side from `speak()` returns) or host
    epoch tag; regression test: barge-in before first chunk drops the whole utterance.

**P2 items (BRAIN-3/4/5, TTS-5/6/7, TURN-1, DUCK-1, MIC-3, BADGE-1, PANE-1, E2E-1, NIT-1/2):**
take the cheap ones in-lane (BRAIN-4 tests fall out of item 5; NIT-1/2 are one-liners; TURN-1 and
DUCK-1 are ~5 lines each); leave the rest dispositioned in the REVIEW doc with a “deferred → J4 /
follow-up” note. **BRAIN-5 (manifest newline neutralization) is a hard MUST inside J4's injection
audit — do not lose it.**

## Rituals (this repo's lane checklist)

- Plan-viz first: add a "Review wave" checklist to plan board `b78c90b3` (or note deferral if
  the app is down); tick as items land.
- Gates: cheap trio · full unit suite 0-fail · jarvis e2e + @voice leg green · targeted new
  regression tests per fix · title-stamped dev check (`CANVAS_DEV_TITLE='PR#NNN jarvis-review-wave'`)
  with a live mic-gate drill (double-tap hotkey; barge-in during first-clause warmup) ·
  Win e2e leg on push (epic-end umbrella→main PR pays the full matrix, lane precedent).
- Reviewer dispositions inline per CLAUDE.md.
- Doc lifecycle: this kickoff dies in the merge PR; the REVIEW doc collapses to a dated summary
  once all findings are fixed/dispositioned (leave it live while P2 items remain open).

## Sharp edges (inherited, do not rediscover)

- First push MUST be `git push -u origin fix/jarvis-review-wave` (new-worktree.ps1 leaves
  upstream = the BASE branch — a bare `git push` would hit the umbrella).
- NEVER `pnpm install`/link through the node_modules junction (targets MAIN); drop the junction
  first if a dep change is ever needed (it shouldn't be — fixes only).
- pnpm in PowerShell background = silent stdin hang; use bash.
- 2 unit tests fail environmentally in worktrees (pathSafe 8.3-TEMP + pty.recapenv ambient
  CANVAS_RECAP_BOARD) — verify green with sanitized env before calling them regressions.
- `pnpm playwright test` after a plain `pnpm build` silent-fails mainCall specs — always go
  through `pnpm test:e2e` (pretest builds flavored).
- Version collision watch: PR #342 (project-switcher) is also 0.17.0 on main's track; the
  epic-end umbrella→main merge re-bumps whatever is taken by then. This lane stays 0.17.1
  inside the umbrella.

## After this lane

**J4 — hands** off the umbrella tip (target 0.18.0): curated tool defs (spawn_board,
relay_prompt, add/update/move_card, visualize_plan, focus_viewport, read-only canvas state —
destructive close/delete NOT exposed), brain tool_use/tool_result streaming loop, confirm-gate
chip as a `turn-act` row in the panel transcript (KICKOFF-PANEL §5), read-only auto-allow,
spoken confirmations grounded in tool RESULTS, D8 spoken-announce policy + chip→focus_viewport
wiring, **injection audit incl. BRAIN-5** (Browser-board content must never reach tool args
unvetted; gate: e2e voice-driven `add_card` behind the confirm gate). Then J5 (wake word,
`.canvas/memory`, win-arm64 parity, docs collapse) → epic-end umbrella→main PR (full matrix).
