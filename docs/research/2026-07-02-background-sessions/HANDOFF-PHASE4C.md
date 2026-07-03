# Background Project Sessions — Phase 4c handoff (2026-07-03)

> **For the next session.** Worktree `Z:\Canvas ADE\.worktrees\bg-sessions`, branch
> `feat/bg-sessions` (based on main `038fc641`, schema v18 — no schema bump anywhere in this
> epic). One session per worktree — work HERE, not in main. Delete this file (and the whole
> folder) in the PR that merges the epic (doc-lifecycle rule). Epic context + Phase 1–4a
> history: `HANDOFF-PHASE4B.md` (same folder); durable memory
> `memory/background-project-sessions-epic.md`; coordination row: ACTIVE-WORK.md ›
> `bg-sessions`.

## State: Phases 1–4b + polish DONE, committed, e2e-proven, manual dev check PASSED

- Phases 1–4a: `31fe22c7` · `102f6c79` · `f4a9c133` · `9b5ab7f0` (see HANDOFF-PHASE4B.md).
- **Phase 4b `890e8fdf`** — bottom project dock (PHASE4-UX-DESIGN §4): MAIN
  `projectThumbs.ts` (frame-guarded `project:captureThumb/thumbs`, PNG cache at
  `userData/project-thumbs/<sha1(dir)>.png`, session-set-only serving, 1/s throttle),
  capture at switch-away (inside `performProjectSwitch` BEFORE the unmount, keep + stop
  paths) + on dock-open, `ProjectDock.tsx` + `CloseBackgroundModal.tsx` +
  `projectSessionsShared.ts` (switcher refactored onto the shared bits), e2e reset()
  drains the bg registry. Gate: 4196 unit · projectDock e2e · full Win leg 249P/250 ×2
  (documented flakes rerun-green).
- **Phase 4b polish `afe43fb0`** — manual-dev-check findings: hot zone 2px→10px (a real
  mouse can't reach 2px: OS resize border / taskbar), `captureProjectThumb` time-boxed at
  400ms (a slow capture stalled the whole switch — "saving is stuck").
- ⚠️ **Hard-won regression knowledge (memory `capturepage-rect-app-death`):** the
  rect-parameterized `webContents.capturePage(rect)` on the app window reproducibly KILLED
  THE WHOLE APP under full-suite GPU load (3/3 legs; baseline counterfactual green; fix =
  full-page capture + CPU-side `nativeImage.crop`). Never pass a rect to capturePage.
- Manual dev check passed 2026-07-03 (`CANVAS_DEV_TITLE='bg-sessions P4b'`); the same
  session surfaced the findings fixed in `afe43fb0` and requested Phase 4c below.
- **Phase 4c BUILT (this commit, 2026-07-03)** — the spec below implemented as approved:
  `store/switchTransitionStore.ts` (idle→out→hold→in machine + watchdog; reduced-motion
  sampled at arm; missing snapshot ⇒ straight to HOLD) · `SwitchTransitionOverlay.tsx` +
  `styles/screens/switch-transition.css` (mock values verbatim) · App.tsx suppresses the
  welcome picker while armed (UNMOUNTED, not occluded) behind a PERMANENT `.st-app-ground`
  wrapper that carries `.st-app-rise` during IN (permanent so Canvas never remounts — a
  remount would kill the very keep-alive this epic exists for) · `performProjectSwitch`
  arms after flush-save + thumb capture (snapshot fetch time-boxed 400ms) and settles off
  the real landing ('open' → IN; load error → IMMEDIATE clear) · e2e `reset()` drains the
  overlay. Gate: 4210 unit (+10 store, +4 overlay integration) · `projectSwitchMotion.e2e`
  2/2 (@chrome, reduced-motion leg via `page.emulateMedia`) · full Win leg 250P with the
  documented osrCropSupersample + a projectBackground-clone teardown flake rerun-green.
  **Still owed: the manual dev check (`CANVAS_DEV_TITLE='bg-sessions P4c'`) with user
  sign-off, then Phase 5.**

## Phase 4c — switch-transition motion (BUILT 2026-07-03 — spec kept for reference)

**Design SIGNED OFF by the user 2026-07-03** on the interactive motion mock — do NOT
produce a new artifact and do NOT re-ask for approval. The artifact is
**`PHASE4C-MOTION-MOCK.html`** (this folder — open in a browser; replay the switch, try the
"simulate a slow load" toggle). Build to its spec table exactly:

| phase | what moves | duration / easing |
|---|---|---|
| OUT | Outgoing canvas (the switch-away SNAPSHOT, not a live render) scales 1 → 0.05 toward bottom-center (`transform-origin: 50% 96%` — its project-dock card slot), fades to 0.3, corners round off. The project dock peeks up (~180ms) with the receiving card wearing the accent ring. | 260ms · `cubic-bezier(.32,0,.67,0)` |
| HOLD | Only if the load hasn't settled when OUT ends: solid `--void` + a quiet mono "Opening <name>…" line + small spinner. **The welcome picker must never paint mid-switch** — killing that flash is the point of the phase. | as long as the load takes |
| IN | Incoming canvas rises: scale 1.03 → 1, +10px → 0, fade 0 → 1. Dock tucks away. | 240ms · `cubic-bezier(.33,1,.68,1)` |
| REDUCED | `prefers-reduced-motion`: plain 120ms cross-fade, no dock peek. | 120ms · linear |

### Mechanics (agreed in the mock's footnote — zero added wait)

1. **`store/switchTransitionStore.ts` (NEW)** — tiny zustand store:
   `{ phase: 'idle'|'out'|'hold'|'in', snapshotUrl: string|null, incomingName: string|null }`
   + arm/settle/clear actions + a **watchdog** (force-clear ~4s after arm) so a hung load
   can never hide the app behind the overlay.
2. **`SwitchTransitionOverlay.tsx` (NEW, app-level in App.tsx like AskOnSwitchModal)** —
   fixed overlay, solid `--void` ground (no blur/glass), renders the snapshot `<img>` and
   drives the OUT/HOLD/IN classes; z ABOVE Canvas/WelcomeScreen, BELOW modals (the
   ask-on-switch dialog at z 10000 must stay clickable — it shows BEFORE the overlay arms,
   but Cancel paths must never leave the overlay up).
3. **`performProjectSwitch` wiring** (order matters; Cancel/locked/save-failed arm NOTHING):
   after the flush-save succeeds and `captureProjectThumb()` returns → fetch the outgoing
   dir's data URL from `project:thumbs()` (time-box like the capture; missing thumb ⇒ skip
   the scale animation, go straight to a fade/HOLD — still no picker) → arm the overlay
   (`phase:'out'`) → `setProjectLoading()` unmount → load. On `applyOpenResult` settling
   'open' → `phase:'in'` → clear after the IN duration. On a LOAD ERROR → clear the overlay
   IMMEDIATELY (the error screen must be reachable).
4. **WelcomeScreen stays untouched** — its D0-7 disabled-picker + loading line remains the
   FALLBACK for loads with no overlay (welcome-screen opens, watchdog fires).
5. **Dock peek** — reuse ProjectDock? NO: the real dock is data-driven and heavier; the peek
   is a presentation-only strip inside the overlay (mock's `.minidock` — two cards max:
   receiving + up to 1 other resident, from the store's cached bgList or just the receiving
   card). Keep it dumb; it exists to sell "your project went HERE".

### Tests

- Unit: switchTransitionStore transitions + watchdog force-clear.
- Integration (jsdom, partial `window.api` mocks with the Promise.resolve().then wrapper
  discipline): overlay renders on arm, clears on error settle, reduced-motion branch.
- e2e (extend `projectDock.e2e.ts` or new `projectSwitchMotion.e2e.ts`, tag `@chrome`):
  during a dock-card switch assert the overlay testid is visible while the welcome picker
  text ("Create project", the recents list) has zero visible instances, then the new
  project settles; `page.emulateMedia({ reducedMotion: 'reduce' })` covers the reduced
  branch. Animation timing assertions = presence/absence only, never pixel/frame counts.

**Out of scope (unchanged):** live rendering of background canvases · background-cap UI ·
title-bar pill badge · replacing the WelcomeScreen picker.

## Gotchas (inherited + new — do not rediscover)

- Everything in `HANDOFF-PHASE4B.md` › Gotchas still applies (clean-env vitest, 700-line
  ratchet, set-state-in-effect, CANVAS_E2E at build time, mint→open interleave, forever-keep
  e2e cleanup, documented flakes, Edit-tool non-ASCII, SSH_ASKPASS).
- **capturePage(rect) = app death** — see above; the thumbnail code is already full-page +
  crop; keep it that way.
- **The overlay must tolerate a missing snapshot** (capture failed / over budget / throttled)
  — fade path, never a blocked switch.
- **workers:1 cross-spec state**: e2e reset() already drains the bg registry; a new motion
  spec must leave the overlay cleared (arm/settle in the same test; the watchdog is the
  backstop).
- The dev-check app instance from 2026-07-03 was left RUNNING deliberately (user's live
  claude session inside it) — never kill other sessions' dev instances; stamp your own with
  a distinct `CANVAS_DEV_TITLE` (e.g. `'bg-sessions P4c'`).
- **e2e mint order = the R2 dir-pin (hit building the 4c spec):** `createTempProject` flips
  MAIN's `currentDir`, so minting the DESTINATION after opening the source makes the
  switch's pinned flush-save reject → `'save-failed'` and (4c) the overlay never arms.
  Mint+open the destination FIRST, then the source (the projectDock.e2e pattern).

## After Phase 4c → Phase 5 (hardening + ADR), then the epic PR

Unchanged from HANDOFF-PHASE4B.md: ring watermark splice · `pty:exitResidue` UX ·
quit/darwin ring-tail sidecars · recap project-gating + `pruneBoardResults`
union-of-residents · the epic ADR (in-app-run lifetime · budgets · dialog policy ·
darwin=quit · no schema bump · v1 MCP limitation · ADD: the capturePage(rect) finding +
thumbnail cache design). Epic PR: full matrix (`pnpm test:e2e:matrix`, Docker up), manual
dev check BEFORE the PR, delete this folder in the PR, build-history entry, inline replies
to every reviewer comment.

## Gate ritual (unchanged, per phase)

`pnpm typecheck` · `pnpm lint` (0 errors; pre-existing STYLE-02 warnings OK) ·
`pnpm format:check` · clean-env `pnpm vitest run` (long-path TMP/TEMP +
`env -u CANVAS_RECAP_BOARD`) · the phase e2e spec + full Windows leg (rerun documented
flakes). `src/main` changes are LINUX_SENSITIVE → Docker up for pre-push. Commit
phase-style; update the ACTIVE-WORK row (gitignored, no commit).
