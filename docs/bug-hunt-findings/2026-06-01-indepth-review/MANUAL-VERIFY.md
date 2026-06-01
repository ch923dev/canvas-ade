# Canvas ADE — In-Depth Review (2026-06-01) — Manual-Verify Findings

**How this was produced:** 9-dimension review (security, PTY, native-preview, persistence, state,
canvas/RF, design parity, tests, perf) via a fan-out workflow; **every medium+ finding was
adversarially re-verified against the actual source** before landing here. Severities below are the
**post-verification** values (some reviewer claims were downgraded when the trigger scenario didn't
hold). Baseline at review time: **356 unit tests green · typecheck clean · lint clean**.

**Verdict:** healthy codebase, no Critical. **1 High · 6 Medium** real bugs (clustered in the
native-preview lifecycle) + ~10 low/perf/test-gap items.

Each bug below has a **Scenario** you can run by hand to confirm or deny it. After testing, mark each
`CONFIRMED` / `NOT A BUG` / `UNSURE` in the checkbox so we only fix what's real.

---

## How to read each card
- **Where** — file:line.
- **What** — the defect in one line.
- **Scenario (manual verify)** — steps to reproduce in the running app (`pnpm dev`).
- **Expected vs Actual** — what you should see if the bug is real.
- **If you can't reproduce** — when to mark NOT A BUG.

---

# HIGH

## H1 — Native browser previews silently drift out of position after a quick flick
- [ ] CONFIRMED / [ ] NOT A BUG / [ ] UNSURE
- **Where:** `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx:505` (`demoting.current` never drained on early gesture-abandon)
- **What:** A short pan/drag that *ends before the snapshot capture IPC resolves* leaves the live boards permanently flagged "demoting", so every later frame skips updating their native `WebContentsView` bounds/zoom. The native browser view stops following its board.
- **Scenario (manual verify):**
  1. Open a project with at least one **Browser board** showing a live localhost page, zoomed in (above LOD, i.e. you can see the real page, not a snapshot card).
  2. Do a **very quick flick-pan** of the canvas — grab empty canvas, drag a short distance, and *release fast* (faster than the snapshot round-trip, ~<150ms).
  3. Now **pan or zoom the canvas again slowly**, or **resize the Browser board**.
- **Expected (no bug):** the native browser content stays glued to the board frame through every move/resize.
- **Actual (bug):** after the quick flick, the live browser content **no longer tracks the board** — it stays put or lags while the board frame moves, so the page floats off its frame. Off-screen Browser boards stay broken for the rest of the session.
- **If you can't reproduce:** the flick has to end *before* capture resolves — try several fast flicks, or throttle to make the window obvious. If the view always re-syncs on the next move, mark UNSURE (it self-heals when a *complete* gesture later covers the same board).

---

# MEDIUM

## M1 — Pasting/importing many Browser boards opens too many live renderers
- [ ] CONFIRMED / [ ] NOT A BUG / [ ] UNSURE
- **Where:** `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx:717` (new-board path bypasses the `MAX_LIVE = 4` cap)
- **What:** The cap that keeps only ~4 live native views is only enforced on the next camera gesture / selection change. Creating several Browser boards at once (that don't change selection) attaches a live `WebContentsView` to *all* of them at once.
- **Scenario (manual verify):**
  1. Zoomed in (above LOD). Open **Task Manager → Details** (or `chrome://process-internals`) so you can count Electron renderer processes.
  2. Create **5+ Browser boards at once** — paste/duplicate a multi-selection, or import a canvas.json that has 6 Browser boards — in a way that does **not** end with them selected.
  3. Count renderer processes immediately, *before* you pan or click anything.
- **Expected (no bug):** at most ~4 live preview renderers; extras show snapshot cards.
- **Actual (bug):** **one renderer per Browser board** (6 boards → 6 renderers, ~50–100MB each) until you next pan/zoom/select, which retroactively closes the over-cap ones.
- **If you can't reproduce:** if every creation path you try also selects the new boards, the cap fires immediately — mark UNSURE and tell me which path you used.

## M2 — Last edit before quitting the app can be lost
- [ ] CONFIRMED / [ ] NOT A BUG / [ ] UNSURE
- **Where:** `src/main/index.ts:216` (`before-quit` runs PTY drain then `app.exit(0)`, which skips the renderer's `beforeunload` autosave flush)
- **What:** Autosave is debounced ~1s. On quit, the app hard-exits without giving the renderer a chance to flush a pending save, so an edit made in the last ~1 second is lost.
- **Scenario (manual verify):**
  1. Open a project. Make a small change (move a board / type in a note) and **within ~1 second, immediately quit** the app (Cmd/Ctrl-Q or close the window) — do **not** click away to another window first.
  2. Reopen the project.
- **Expected (no bug):** your last change is there.
- **Actual (bug):** the last change is **gone** (reverted to the state ~1s before quit).
- **If you can't reproduce:** clicking/tabbing to another window before quitting triggers a blur-flush that saves — so you must quit while the canvas window is still focused, fast. If it always saves, mark UNSURE.

## M3 — Undo behaves oddly after you've already undone something
- [ ] CONFIRMED / [ ] NOT A BUG / [ ] UNSURE
- **Where:** `src/renderer/src/store/canvasStore.ts:288` (`beginChange` dedup guard fails post-undo)
- **What:** After an undo, harmless clicks (titlebar, a tap that moves nothing) push duplicate snapshots onto the undo stack, creating "phantom" undo steps that go back to an identical state, and bloating memory.
- **Scenario (manual verify):**
  1. Do one real edit (move a board). Press **Undo** once (board returns).
  2. Now **click around without changing anything** — click a board's title bar, click empty canvas, tap a resize handle without dragging — a few times.
  3. Press **Undo** repeatedly.
- **Expected (no bug):** after the first undo, further Undo either does nothing or steps to a genuinely different earlier state.
- **Actual (bug):** you get **several Undo presses that visibly change nothing** (the canvas "undoes" to the same picture) before reaching a real earlier state.
- **If you can't reproduce:** if no-op clicks don't register as changes at all in your build, mark UNSURE — the growth only happens when `beginChange` fires (selection/drag-start handlers).

## M4 — Terminal→Browser connector arrow bends the wrong way
- [ ] CONFIRMED / [ ] NOT A BUG / [ ] UNSURE
- **Where:** `src/renderer/src/canvas/edges/PreviewEdge.tsx:56-57` (bezier control direction hardcoded Right→Left)
- **What:** The "push preview" connector computes correct endpoints for any layout but always curves as if the Browser is to the *right* of the Terminal. When it isn't, the curve fishhooks/S-bends.
- **Scenario (manual verify):**
  1. Create a Terminal board and a Browser board. Use the Terminal's **Preview (globe)** button so the connector arrow appears.
  2. Now **move the Browser board to the LEFT of the Terminal**, and separately try it **directly above/below**.
- **Expected (no bug):** a smooth arc from terminal edge to browser edge regardless of relative position.
- **Actual (bug):** when the Browser is left of / above / below the Terminal, the connector shows a **tight fishhook or backward S-curve** instead of a clean arc.
- **If you can't reproduce:** with the Browser to the right it looks fine (that's the hardcoded case) — you must place it left/above to see it.

## M5 — A corrupt/edited canvas.json could launch an arbitrary program (security hardening)
- [ ] CONFIRMED / [ ] NOT A BUG / [ ] UNSURE
- **Where:** `src/main/pty.ts:317` (`opts.shell` spawned with no allowlist / absolute-path / existence check)
- **What:** The terminal `shell` value persisted in `canvas.json` is passed straight to `pty.spawn`. There's no validation it's one of the real enumerated shells. A tampered project file could point it at any binary, which then runs in the main process.
- **Scenario (manual verify):**
  1. Close the app. Open the project's `canvas.json`, find a Terminal board, and set its `"shell"` to a harmless marker binary you can spot (e.g. on Windows `"C:\\Windows\\System32\\calc.exe"`, on macOS `/usr/bin/say`).
  2. Reopen the project and let / make that terminal spawn.
- **Expected (no bug / desired):** the app rejects the unknown shell and falls back to a real enumerated shell.
- **Actual (bug):** the **marker binary launches** (calc opens / `say` runs), proving an unvalidated path is executed.
- **Note:** this is defense-in-depth, not a remote exploit — it requires the attacker to already edit your project file. Still worth closing because corrupt files shouldn't execute arbitrary binaries.
- **If you can't reproduce:** if the app refuses the bad shell, it's already guarded somewhere — mark NOT A BUG.

## M6 — IPC frame-guard allows calls when the window is being torn down (security hardening)
- [ ] CONFIRMED / [ ] NOT A BUG / [ ] UNSURE
- **Where:** `src/main/pty.ts:287`, `src/main/preview.ts:356`, `src/main/projectIpc.ts:19` (identical `isForeignSender`)
- **What:** The guard that blocks IPC from foreign frames returns "allow" when `getWin()` is null (intended for synthetic internal calls) — but that also matches the window-destroyed state, so a late IPC during teardown bypasses the check. Also has **zero unit tests** in all three modules.
- **Scenario (manual verify):** This one is **hard to trigger by hand** (it's a teardown race) — it's primarily a code + test-coverage hardening item. Manual confirmation isn't expected; treat it as "confirmed by code reading" unless you want to skip it. The concrete fix is: when `getWin()` is null, deny instead of allow (or distinguish synthetic calls explicitly), plus add a unit test per module.
- **If reviewing:** mark CONFIRMED to include the guard fix + tests, or NOT A BUG to skip.

---

# LOW / PERF / POLISH (batch — lower priority)

These are real but minor; grouped so you can accept/skip as a set. No separate scenario needed unless you want one.

- [ ] **L1 — zoom +/− buttons don't animate** (`AppChrome.tsx:133,137`). Every other camera control eases over 200ms (DESIGN.md §9); the +/− buttons snap. *Verify:* click +/− vs the fit/overview buttons — only +/− jumps instantly. One-line fix.
- [ ] **L2 — `setViewport` runs the preview subscriber every camera frame** (`canvasStore.ts:280` + `BrowserPreviewLayer.tsx:806`). No correctness bug (IPC is diff-skipped) but wasteful JS churn per pan/zoom frame; worse when a board is in full-view (runs `applyLiveness` every frame). Fix: value-equality guard in `setViewport`.
- [ ] **L3 — `applyLiveness` is O(n²)** (`BrowserPreviewLayer.tsx:585`, `wantLive.includes` in a loop). Harmless at 4-board cap; convert `wantLive` to a `Set`.
- [ ] **L4 — Full-view rAF pump never idles** (`BrowserPreviewLayer.tsx:667`). Calls `getBoundingClientRect` every frame for the whole full-view session; add the 4-idle-frame self-stop the motion pump already uses.
- [ ] **L5 — `recentProjects.ts` uses plain `writeFileSync`** (`:46`) not `write-file-atomic`. A crash mid-write can zero out your recent-projects list (silently → empty). Match the canvas.json atomic pattern.
- [ ] **L6 — Full-chrome title bar omits the §6 micro type-tag** (`BoardFrame.tsx:415-500`). Deliberate (code comment) but diverges from DESIGN.md §6 + prototype. Design call — keep or restore.

---

# TEST-COVERAGE GAPS (no runtime bug; add tests)

Confirmed gaps in otherwise-strong coverage. Recommend adding before next phase:

- [ ] **T1 — `pty.ts` park/adopt/reapParked/disposeAllPtys** have zero unit tests. This is the delete→undo terminal-identity path + shutdown drain — the most complex stateful code in MAIN. (med)
- [ ] **T2 — `isForeignSender`** untested in all 3 modules (ties to M6). (med)
- [ ] **T3 — `previewStore.patchIfPresent`** untested; its no-op-on-absent contract is the only guard against a known orphan-entry leak (Bug #32). (med)
- [ ] **T4 — `projectIpc.ts`** has no test file; `project:save` null-dir no-op and `project:current` stale-dir-on-deleted-folder are unverified. (low)
- [ ] **T5 — `preview.ts` `failed` latch** (did-fail→did-finish suppression ordering) untested. (low)

---

# Downgraded by verification (NOT bugs as originally framed)

For transparency — the adversarial pass caught two over-claims:

- **STATE-1 element-edit clobber** → **downgraded to latent/low.** The stale `elements` closure pattern is real, but the claimed "two edits in one React 18 batch overwrite each other" trigger **does not occur** with the current handlers (separate DOM events flush separately, and Zustand updates synchronously between them). Worth a defensive refactor (functional updater) but **not a live data-loss bug today.**
- **onWinMsg missing null-port guard** → **downgraded to nit.** Not triggerable given the current sandbox/port-transfer flow; defensive only.

---

*Reply with your CONFIRMED / NOT A BUG marks (or "fix all the verified ones") and I'll run the
worktree-isolated fix workflow.*
