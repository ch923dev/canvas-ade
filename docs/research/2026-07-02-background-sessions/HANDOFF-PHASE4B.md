# Background Project Sessions — Phase 4b handoff (2026-07-03)

> **For the next session.** Worktree `Z:\Canvas ADE\.worktrees\bg-sessions`, branch
> `feat/bg-sessions` (based on main `038fc641`, schema v18 — no schema bump anywhere in this
> epic). One session per worktree — work HERE, not in main. Delete this file (and the whole
> folder) in the PR that merges the epic (doc-lifecycle rule). Full approved plan:
> `C:\Users\De Asis PC\.claude\plans\do-an-indepth-review-fluffy-phoenix.md`; durable memory
> note `memory/background-project-sessions-epic.md`. Coordination row: ACTIVE-WORK.md ›
> `bg-sessions`.

## Epic in one line

Maestri-style resume: switch project A→B→A within one app run and A's terminals are STILL
RUNNING (same PTYs, live) and its previews still alive with in-page state intact. In-app-run
lifetime only (quit kills all); ask-on-switch dialog mediates; NO feature flag anymore.

## State: Phases 1–4a DONE, committed, e2e-proven, manual dev check PASSED

- **Phase 1 `31fe22c7`** — plumbing (projectDir-tagged sessions, typed parks, owner-checked
  adopt, scoped disposal, `projectSessions.ts` registry, `onProjectForeground`).
- **Phase 2 `102f6c79`** — keep-running switch pipeline (`store/projectSwitch.ts`), IPC
  `project:background/listBackground/closeBackground/closeActive`, exit tombstones, R2/R4/R5.
- **Phase 3 `f4a9c133`** — preview keep-alive completion: synthetic state re-emit in
  `preview:osrOpen` for an existing entry (`emitOsrRemountState` — kept page NEVER reloads),
  `GLOBAL_OSR_MAX = 8` existence budget (`pickOsrEvictions`, backgrounded-only, oldest
  `backgroundedAt` first, foreground never starved), downloads denied while backgrounded,
  `osrEval` e2e helper, `projectBackgroundPreview.e2e.ts` proves same-JS-context survival.
- **Phase 4a `9b5ab7f0`** — the approved PHASE4-UX-DESIGN §1–3, and the
  **`EXPANSE_BG_SESSIONS` flag is REMOVED** (feature is the shipped default):
  - **Ask-on-switch dialog** — `AskOnSwitchModal.tsx` + `store/askOnSwitchStore.ts`
    (promise-based request/settle; card keyed by `reqId` so state remounts fresh — no
    reset-effect). Shown only when the outgoing project has live resources AND no remembered
    policy. Cancel aborts the whole switch (`SwitchOutcome` now includes `'cancelled'`).
  - **Keep policy ladder** (`projectSessions.ts`): `'ask'` default → Keep = session-scoped
    remembered → forever checkbox = persisted `userData/background-keep.json` (lazy-hydrated,
    corrupt file degrades to session-only) → ∞ badge forgets (policy only, sessions untouched)
    → ✕ / active close resets everything. Stop is one-shot, never remembered.
  - **Pipeline order locked**: lock → decide/dialog → autosave-cancel → pinned flush-save →
    handover → load. **Stop path is the SCOPED `closeActiveLiveResources(outgoingDir)`** —
    the legacy dispose-all would reap OTHER residents' background sessions (latent bug fixed).
  - **Switcher live rows** — `ProjectSwitcher.tsx` (extracted from AppChrome under the
    700-code-line ratchet; AppChrome re-exports it because two other integration tests import
    from './AppChrome'). Rows: `--ok` 6px dot · mono `2 term · 1 prev` badge · hover-✕ →
    §3 close-confirm (silent when idle) · ∞ forget badge. Aux buttons are SIBLINGS of the
    `role=menuitem` main button (never nested interactives; Menu roving tabindex intact).
  - IPC added: `project:askOnSwitchInfo` (ACTIVE dir resolved MAIN-side) ·
    `project:setKeepPolicy(forever)` · `project:forgetKeepPolicy(dir)` ·
    `project:keepForeverDirs`. Removed: `project:bgSessionsEnabled`.
  - Tests: 6 policy unit tests (`projectSessions.test.ts`), 4 switcher integration tests
    (`AppChrome.projectswitcher.integration.test.tsx`), ladder e2e
    (`projectBackgroundDialog.e2e.ts` — ask → Keep+forever → silent → forget → Cancel → Stop).
  - Gate green: 4170 unit+integration · 6/6 bg e2e · full Windows leg 247P (2 documented
    flakes rerun-green) · manual dev check passed 2026-07-02 (`CANVAS_DEV_TITLE='bg-sessions
    P4a'`).

Working tree clean at `9b5ab7f0`. **Design sign-off for 4b already obtained** — the user
approved the FULL PHASE4-UX-DESIGN.md including §4; no new artifact needed. Build straight
from §4.

## Phase 4b — bottom project dock (THE NEXT WORK, not started)

Authoritative spec: `PHASE4-UX-DESIGN.md` §4 (same folder — read it first; the wireframe +
every locked decision live there). Summary of what to build:

1. **Thumbnail plumbing (MAIN)** — new module (do NOT grow `index.ts`/`previewOsr.ts`;
   ratchet): `webContents.capturePage(canvasRect)` of the app window, downscaled ~2×, PNG
   cached at `userData/project-thumbs/<dirHash>.png` (app cache — NEVER the project folder,
   ADR 0009). Renderer supplies the canvas rect (React Flow pane bounding rect) over IPC.
   Two capture moments: the OUTGOING project at switch-away (call inside
   `performProjectSwitch` BEFORE `setProjectLoading()` unmount — both keep and stop paths),
   and the ACTIVE project on dock-open. Serve to the renderer as data URLs (e.g.
   `project:captureThumb(rect)` + `project:thumbs()` → `{dir → dataUrl}`). Frame-guard the
   handlers like the rest of `projectSessionsIpc.ts`. Capture failure → renderer dot-grid
   placeholder (capturePage is env-flaky; see gotchas).
2. **Dock component (renderer)** — NEW file (`ProjectDock.tsx`), mounted app-level like
   `AskOnSwitchModal`. Bottom-edge hot zone ~2px + ~150ms intent delay (drive-by never
   opens); Leave / Esc / card-click closes; reveals ABOVE the board dock. Membership =
   session projects ONLY: active dir + `project:listBackground` residents — cold recents
   never appear. Card = header (dot `--ok` when alive · name · counts badge · hover-✕ on
   backgrounded cards → the SAME §3 close-confirm · ∞ badge via `project:keepForeverDirs`)
   + thumbnail; active card wears 1.5px accent ring + `ACTIVE` micro tag, click closes dock.
   **+ tile** (dashed border, trailing) → small menu with Open folder… / Create project…
   (same actions as the switcher — extract/reuse the handlers from `ProjectSwitcher.tsx`
   rather than duplicating; `bgBadge`/`closeBody` helpers live there too). Card click =
   `performProjectSwitch` — the dialog/policy flow comes free, ZERO new switch semantics.
   Solid surfaces only (`--surface`/`--surface-raised`), no blur/glass.
3. **Styles** — extend `styles/chrome/menu.css` grammar or a new dock css file; reuse
   `.ps-dot/.ps-badge/.ps-aux` class conventions where sensible.
4. **Tests** — unit: dirHash/thumb-cache pure bits + dock membership logic. Integration
   (jsdom, mocked `window.api` — wrap api calls in `Promise.resolve().then(...)` so partial
   mocks don't throw synchronously): reveal on hot-zone hover after delay, session-only
   membership, + tile actions, ✕ confirm reuse, ∞ forget. e2e (`projectDock.e2e.ts`, tag
   `@chrome`): hover bottom edge → dock visible with both residents → click background card
   → switch rides the policy (silent after a remembered keep) → thumbnail img present (data
   URL or placeholder). Drive hover with real mouse.move to window-bottom coords —
   synthetic dispatchEvent bypasses hit-testing (documented gotcha).

**Out of scope (locked, §4 + Out-of-scope section):** live rendering of background canvases
(one React Flow instance per app), background-cap UI, title-bar pill badge.

## Gotchas this epic already paid for (do not rediscover)

- **vitest false failures from THIS session's env**: running inside an Expanse terminal board
  leaks `CANVAS_RECAP_BOARD` (breaks pty.recapenv ×3) and an 8.3 short-name `TMP`
  (`C:\Users\DEASIS~1\...`) breaks pathSafe ×2 ("realpath escapes the project root"). Run
  vitest with long-path `TMP/TEMP` + `env -u CANVAS_RECAP_BOARD`. Code is fine — don't "fix".
- **max-lines ratchet = 700 CODE lines** (skipBlankLines+skipComments). AppChrome 610,
  ProjectSwitcher 408 — the dock goes in a NEW file; if ProjectSwitcher helpers need sharing,
  extract a small module rather than growing either.
- **react-hooks/set-state-in-effect is an ERROR** — never a reset-effect; use the
  key-remount pattern (see `AskOnSwitchModal`).
- **e2e MAIN registry needs `CANVAS_E2E=1` at BUILD time** — `pnpm test:e2e` handles it;
  hand-iterating: `CANVAS_E2E=1 pnpm exec electron-vite build` then playwright.
- **e2e temp projects: interleave mint→open** (`project:open` approves only current dir or
  recents) — helpers in `projectBackground.e2e.ts`.
- **Persisted forever-keeps survive across e2e specs** (real userData) — any spec that sets
  forever MUST `forgetKeepPolicy` in `finally` (see `projectBackgroundDialog.e2e.ts`).
- **Documented flakes**: osrCropSupersample pair ("Target page…has been closed" in fixture
  reset) and terminalTheme (banner read before marker) — rerun, don't "fix".
- **capturePage is env-flaky** (the browser-trio e2e flake class) — thumbnail code must
  treat failure as normal (placeholder path), and e2e must accept placeholder OR image.
- **Synthetic dispatchEvent bypasses CSS-transform hit-testing** in e2e — use real
  `page.mouse.move` / PointerEvents for the hot zone.
- **Edit tool mangles non-ASCII** near `…`/curly quotes (both live in ProjectSwitcher +
  modal copy) — prefer Write/careful anchors, run typecheck after.
- **Permission rule: PowerShell one-liners through the Bash tool get denied** — use node
  scripts or plain POSIX. Push/e2e from Bash needs `env -u SSH_ASKPASS`.
- `pnpm format:check` is part of the gate (prettier ≠ eslint); `prettier --write` touched
  files before committing.

## e2e harness surface already available

`e2eHooks.ts`: `switchProjectFromDisk(dir, keep)` (explicit keep bypasses dialog),
`switchProjectAsk(dir)` (no opts → real dialog path; leave the returned promise unawaited
and click the modal). MAIN registry: `terminalPid`, `ptySessionCounts`, `osrPainting(id)`,
`osrEval(id, code)`. Renderer globals typed in `e2eHooks.types.ts` (e2e tsconfig has NO DOM
lib — cast via `globalThis`).

## After Phase 4b → Phase 5 (hardening + ADR), then the epic PR

- Ring watermark splice (full scrollback) · `pty:exitResidue` UX in TerminalRestoredBar ·
  quit/darwin ring-tail append to owning-project sidecars · recap project-gating +
  `pruneBoardResults` union-of-residents · new ADR (in-app-run lifetime · budgets · dialog
  policy · darwin=quit semantics · no schema bump · v1 MCP limitation).
- Epic PR: full matrix (`pnpm test:e2e:matrix`, Docker up) at pre-merge, manual dev check
  (`$env:CANVAS_DEV_TITLE='bg-sessions P4b'; pnpm dev`) BEFORE the PR, delete this folder in
  the PR, build-history entry, reply inline to every reviewer comment.

## Gate ritual (unchanged, per phase)

`pnpm typecheck` · `pnpm lint` (0 errors; pre-existing STYLE-02 warnings OK) ·
`pnpm format:check` · clean-env `pnpm vitest run` · the phase e2e spec + full Windows leg.
`src/main` changes are LINUX_SENSITIVE → pre-push wants the Docker leg up. Commit
phase-style; update the ACTIVE-WORK row (gitignored, no commit).
