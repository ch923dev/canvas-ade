# Fix Run Report

Generated: 2026-06-15 · Package: `docs/reviews/2026-06-15-bug-hunt/` · Repo: Canvas ADE · Branch: `fix/bug-hunt-2026-06-15` (off `main` `7f835d4`)

| Outcome | Count |
|---------|-------|
| Fixed (verified) | 16 |
| Needs review | 0 |
| Blocked (collision/dependency) | 0 |
| Out of scope (skipped/unconfirmed) | 9 unconfirmed + 0 roadmap-skipped (not touched, by construction) |

**Wave plan executed:** single wave of 10 file-disjoint clusters, run in parallel (collision groups collapsed into one agent each so no two agents co-edited a file).

**Verification (central, gate-of-record):** the worktree (node_modules junctioned) ran the FULL gate after integration — `typecheck` ✅ · `lint` ✅ · `format:check` ✅ · unit+integration **2550/2550 pass (183 files)** ✅. Every card shipped a regression test driving the REAL code path (no faked/seeded status). The e2e matrix is the remaining pre-merge gate (see bottom).

> Note on outcome vs. the workflow tally: the fix workflow reported BUG-006 as *needs-review* only because its fail-closed guard turned red two **out-of-scope** test files the cluster agent wasn't allowed to edit. Those were completed during central integration (one-line approval seeds reflecting the new contract), so BUG-006 is **fixed and verified**.

---

### BUG-001: Recap-map watcher crashes the whole app on a destroyed-but-non-null mainWindow — FIXED
- **Commit:** `6de86eb` (cluster A) · **Files:** `src/main/index.ts` (+ `index.flushRenderer.test.ts`)
- **Fix:** `closed` handler nulls `mainWindow`; the recap `onChange` guards `isDestroyed()` before `.webContents` (mirrors `flushRenderer`).
- **Verification:** new test drives the real `watchRecapMap` debounce `setTimeout` against a destroyed window double whose `.webContents` getter throws — old shape throws, fixed guard does not.

### BUG-002: handoff_prompt / barriers never settle for a live agent — FIXED
- **Commit:** `6de86eb` (cluster A) · **Files:** `src/main/mcpOrchestrator.ts` (+ test)
- **Fix:** added a per-board result-settle notifier; `awaitHandoffSettled` now settles when the worker reports its own `write_result`, so a handoff to a permanently-`running` agent completes instead of timing out.
- **Verification:** test parks a handoff under a never-resolving backstop + permanently-running status, then `writeResult` settles it `completed` (not `timed_out`); per-board isolation asserted.
- **Follow-up (noted, non-blocking):** the package-side `wait_for_*` barriers in `@expanse-ade/mcp` (separate repo) don't yet share this settle signal — needs an attention-vs-barrier consumer split that doesn't exist today.

### BUG-007: Idle-reaper never reaps a quiescent MCP terminal — FIXED
- **Commit:** `6de86eb` (cluster A) · **Files:** `src/main/pty.ts`, `mcpRegistry.ts`, `mcpLifecycle.ts`, `mcpOrchestrator.ts`, `index.ts` (+ `pty.test.ts`, `mcpLifecycle.test.ts`)
- **Fix:** `pty.ts` exposes read-only `getTerminalActivityStaleMs`; `reapIdle` measures dormancy by PTY output silence instead of the never-flipping `running` bucket. Human pill unchanged.
- **Verification:** test reaps an output-silent terminal whose status stays `running`, and proves fresh output re-arms it — driving the real `reapIdle` path.

### BUG-008: Audit-append-after-write turns a successful dispatch into an error — FIXED
- **Commit:** `6de86eb` (cluster A) · **Files:** `src/main/mcpOrchestrator.ts` (+ test)
- **Fix:** post-write `dispatched`/outcome audit failures are logged (forensic-gap warning), not re-thrown; pre-write refusal branches still re-throw.
- **Verification:** test makes audit throw on `dispatched` + `completed`; `handoffPrompt` resolves and the PTY write committed exactly once.

### BUG-009: write_result stores worker summary/refs with no length bound — FIXED
- **Commit:** `6de86eb` (cluster A) · **Files:** `src/main/mcpOrchestrator.ts` (+ test)
- **Fix:** clamp summary (100 000) + bound refs (256 entries × 256 chars), mirroring `auditLog`/`boardRegistry`.
- **Follow-up (noted):** the external `@expanse-ade/mcp` schema `.max()` remains a separate-repo change.

### BUG-010: Title-only rename burns a budgeted summarize — FIXED
- **Commit:** `6506e83` (cluster B) · **Files:** `src/main/memoryEngine.ts` (+ test)
- **Fix:** dropped `title` from `boardFingerprint` for terminal/browser, restoring lockstep with `boardContent`; updated the contradictory comments + BUG-018 tests.
- **Verification:** test drives `observe → boardFingerprint → armDebounce`; a title-only rename arms no intent, a real content change still does.

### BUG-011: Truncate-before-redact secret leak — FIXED
- **Commit:** `6506e83` (cluster B) · **Files:** `src/main/agentTranscript.ts` (+ test)
- **Fix:** `redactSecrets` runs on the full milestone text before `slice(0, cap)`; belt-and-suspenders redact in `buildRecapInput` kept.
- **Verification:** test plants a 64-hex secret straddling offset 600 and asserts the surviving prefix is redacted.

### BUG-013 + BUG-014: MAIN/renderer schema version drift + an ineffective guard — FIXED
- **Commit:** `d7c7c8b` (cluster C) · **Files:** `src/main/projectStore.ts` (+ test), `src/renderer/src/lib/boardSchema.ts`, `boardSchemaVersion.ts` (new)
- **Fix:** bumped MAIN `SCHEMA_VERSION` 9→10; the drift-guard test now imports the authoritative renderer constants and asserts parity. Constants extracted to a dependency-free `boardSchemaVersion.ts` (re-exported by `boardSchema`) so the cross-import doesn't drag DOM code into the node tsconfig (the integration fix).
- **Verification:** lock-step test fails on any one-sided bump; fresh-doc on-disk versions asserted against the imported constants.

### BUG-003: Native preview paints over modals — FIXED
- **Commit:** `44bfdb2` (cluster D) · **Files:** `src/renderer/src/canvas/Modal.tsx` (+ test)
- **Fix:** the shared `Modal` primitive registers a `useId`-keyed `previewStore.setMenuOpen` on mount/unmount, covering every modal.
- **Verification:** test drives the real `previewStore` — `menuOpen` is true while a Modal is mounted, false after unmount.

### BUG-004: did-navigate-in-page never clears the failed latch — FIXED
- **Commit:** `13bba46` (cluster E) · **Files:** `src/main/preview.ts`, `usePreviewEvents.ts`, `useOffscreenPreview.ts` (+ tests)
- **Fix:** in-page recovery clears `e.failed`, re-shows the view, and flags the emitted `did-navigate`; both renderer consumers lift a stale `load-failed`→`connected`. Genuine main-frame 4xx unaffected.
- **Verification:** test emits `did-fail-load(404)` then `did-navigate{recovered}` and asserts recovery; evicted-board and non-recovered cases asserted unaffected.

### BUG-005: OSR blocked-scheme hang — FIXED
- **Commit:** `5bbb8a8` (cluster F) · **Files:** `src/main/previewOsr.ts` (+ test)
- **Fix:** `ensureOsr` emits a synthetic `did-fail-load` (errorCode -1, "blocked scheme") on a rejected scheme, mirroring the native path, so the board resolves to `load-failed`.
- **Verification:** test asserts an http(s) url loads + emits nothing, while `file:`/`data:`/non-URL all set `failed` + emit the terminal event.

### BUG-006: Project-dir guard allows any absolute path — FIXED
- **Commit:** `4d7c25c` (cluster G) · **Files:** `src/main/projectIpc.ts` (+ test, + 2 out-of-scope tests seeded)
- **Fix:** `project:create`/`open` require the target to be equal-to-or-under a dialog-picked root, the current project, or a recents entry (fail closed). Dialog-pick / open-recent / in-session reopen preserved.
- **Verification:** real-path tests reject an unapproved create/open and admit the dialog/recents flows; `isUnderApprovedRoot` unit-suite covers equal/under/sibling-prefix/case/trailing-sep.

### BUG-012: removeBoard leaks idleOnMountIds — FIXED
- **Commit:** `6d44485` (cluster H) · **Files:** `src/renderer/src/store/canvasStore.ts` (+ test)
- **Fix:** `removeBoard` parks the flag (undo can re-promote); GC reconciles parked ids against past/future rails after history-rail eviction. No eager delete (preserves undo-restores-idle).
- **Verification:** test duplicates→deletes→evicts history and asserts the UUID is reclaimed; undo-after-delete still restores idle.

### BUG-015: parkTerminal unhandled rejection — FIXED
- **Commit:** `612b93c` (cluster I) · **Files:** `src/renderer/src/canvas/Canvas.tsx`, `useBoardActions.ts` (+ test)
- **Fix:** `.catch()` on both `void window.api.parkTerminal(...)` sites.
- **Verification:** jsdom test asserts no `unhandledrejection` when `parkTerminal` rejects, while the real `remove` path still calls it.

### BUG-016: Backdrop dpr reblur — FIXED
- **Commit:** `7c55cb2` (cluster J) · **Files:** 8 `backdrop/scenes/*.ts` (+ `sceneHandles.test.ts`)
- **Fix:** `ensureSize()` in each model scene's `tick()` (matches the ambient scenes), so a dpr change re-rasters on the next frame.
- **Verification:** parametrized scene-contract test changes `devicePixelRatio` without firing the ResizeObserver and asserts the backbuffer resizes.

---

## Remaining before merge to `main`

1. **Manual dev check** (CLAUDE.md mandate): `$env:CANVAS_DEV_TITLE='fix/bug-hunt-2026-06-15'; pnpm dev` — a green gate is not "verified working".
2. **Full e2e matrix** (mandatory pre-merge): `pnpm test:e2e:matrix` (both legs; Linux via Docker) — cluster A touches `src/main`, so the Linux-sensitive leg is required.
3. **Sequential merge** into `main` per the coordination protocol, then `signal-merge.ps1`.

## Noted follow-ups (separate repo / out of this package's scope)
- BUG-002: share the result-settle signal with the package `wait_for_*` barriers in `@expanse-ade/mcp`.
- BUG-009: add `.max()` to the `write_result` schema in `@expanse-ade/mcp` (the app-side clamp is belt-and-suspenders).
- BUG-004: `src/preload/index.ts` `did-navigate` PreviewEvent could add the optional `recovered?: boolean` so the renderer cast can be dropped.
- BUG-005: `previewOsr.ts` has the same in-page-latch shape as BUG-004 (forward-compatible today; can adopt the `recovered` emit later).
