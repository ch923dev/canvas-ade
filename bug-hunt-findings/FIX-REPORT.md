# Bug Hunt Fix Run — Report

Generated 2026-06-10 | Package `bug-hunt-findings/` | Repo Canvas ADE | Branch `fix/bug-hunt-2026-06-10` (based on main `7bdb998`).

## Outcome

| Outcome | Count |
|---|---|
| Fixed (verified) | 72 |
| Needs review | 0 |
| Blocked | 0 |
| Out of scope | 1 roadmap-skipped + 7 unconfirmed (never attempted, by construction) |

## Wave plan executed

- **Wave 1** — 8 parallel cluster agents, file-disjoint territories (43 cards): A main-recap 10, B pty 4, C llm 5, D mcp-misc 5, E planning 5, F terminal 4, G hooks/ci 5, H lib 5.
- **Wave 2** — 3 agents (16 cards): I store/undo 6, J persistence 5 incl. BUG-009 main half, K canvas-interactions 6.
- **Wave 3** — 4 agents (10 cards): L preview-main 2, M preview-renderer 3, N consent-ui 3, O packaging 2.
- **Wave 4** — 1 agent (3 cards): P browser-flow 3.
- **Adversarial verify pass** — 4 agents, refute-by-default, over all 72 fixes → 67 verified outright, 5 concerns (BUG-003, 022, 023, 035, 052), each resolved by the follow-up amendment commit `81365b6`.

## Gates

- Full gate (typecheck, lint, format:check, unit + integration) green after every wave.
- Final suite: **1906 passed / 1906** (baseline before fixes was 1774 — the run added ~130 regression tests).
- E2E matrix: run at hand-off — see PR.

## Per-fix records

### BUG-001: flushRenderer touches webContents of the destroyed main window — every window-close quit on Win/Linux throws into the crash sink, killing the guarded-quit chain — FIXED

- Cluster/Wave: A/1 · Commit: 6575c7b
- Fix: Added `win.isDestroyed()` guard in `flushRenderer` BEFORE accessing `.webContents` (then `wc.isDestroyed()` on the freshly obtained webContents, mirroring `ipcGuard.ts`), so the window-close-then-quit path no longer throws into the uncaughtException sink.
- Verification: Extended `index.flushRenderer.test.ts` with 2 destroyed/null-window tests; 78/78 pass. · Adversarial verdict: verified

### BUG-002: Recap transcript egress is not consent-gated — revoking consent does not stop transcript reads + LLM egress — FIXED

- Cluster/Wave: A/1 · Commit: 6575c7b
- Fix: Gated the `getAgentMilestones` callback (the actual egress path) on `readConsent(userData, dir) === 'enabled'`, and added decline-side side-effects: untrack transcript watchers, delete in-memory recapMap entries, and rewrite session-map.jsonl so a restart does not re-track them.
- Verification: Consent store covered by existing recapConsent tests; index.ts wiring verified by code reading; 78/78 pass. · Adversarial verdict: verified ("summaryLoop's recap branch can never fire post-revocation regardless of watcher/map state")

### BUG-003: Packaged-build recap hook is doubly broken: process.execPath without ELECTRON_RUN_AS_NODE launches a full second app instance, and the baked script path points inside app.asar — FIXED

- Cluster/Wave: A/1 · Commit: 6575c7b
- Fix: Rewrote `recordScript` with `app.asar -> app.asar.unpacked` when packaged, and passed `ELECTRON_RUN_AS_NODE` so the app exe acts as Node instead of booting a second app instance.
- Verification: 2 regression tests in `agentRecapMap.test.ts`; 78/78 pass. · Adversarial verdict: concern (Claude's hook-command schema has no `env` field, so the env half would be ignored) → resolved by amendment 81365b6: the env is now baked into a shell-form command (`cmd /c set ...` on Windows / `sh -c` env prefix on POSIX) instead of a non-existent `env` field, and install/remove detection substring-matches scriptPath so the shell form stays idempotent.

### BUG-004: First tracked edit after undo/redo skips its checkpoint (lastRecorded === present) — the undone-to state lands on neither rail and the next undo jumps two steps, permanently losing it — FIXED

- Cluster/Wave: I/2 · Commit: 16df5bd
- Fix: Replaced the eager beginChange + lastRecorded skip-token model with lazy checkpointing: `beginChange()` captures the pre-gesture snapshot into a module-level `pendingCheckpoint` and the gesture's first real mutation consumes it — so there is no post-undo skip token to go stale, and a mutation-free gesture records nothing (phantom-step class closed structurally).
- Verification: Added the card's exact repro test ("undo → edit → undo restores the pre-edit state, not two steps back") plus a redo-leg test; full store suite green (132 canvasStore tests + 9 dependent suites). · Adversarial verdict: verified ("the post-undo skip class is eliminated rather than patched")

### BUG-005: Preview module state (views map / owner / attached) survives main-window destruction — after macOS window reopen, attach() skips addChildView so previews are blank, and the docs-mandated 'closed' webContents cleanup is missing — FIXED

- Cluster/Wave: L/3 · Commit: f65256d
- Fix: `createWindow` now registers `mainWindow.on('closed', () => disposeAllPreviews())` (the docs-mandated cleanup), `detach()` guards `owner.isDestroyed()`, and `disposeOne()` splits detach and `webContents.close()` into separate try blocks so a detach throw can never skip the mandatory close.
- Verification: 2 new integration regressions in `preview.integration.test.ts` (destroyed-owner close, closeAll despite detach throw); 44/44 + 11/11 pass. · Adversarial verdict: verified

### BUG-006: Transcript watcher lifecycle is prune-only on project switch: switching away and back leaves recap auto-refresh permanently dead until a NEW claude session rewrites the map file — FIXED

- Cluster/Wave: A/1 · Commit: 6575c7b
- Fix: `onBoardsObserved` now re-arms transcript watchers for live boards whose entries exist in the in-memory recapMap (calling `recapWatcher.track()` for each) after the prune, restoring hands-free auto-refresh after a project switch-back.
- Verification: track/retain mechanics covered by existing `agentRecapWatcher.test.ts`; wiring verified by code reading; 78/78 pass. · Adversarial verdict: verified

### BUG-007: First save after T5 .bak recovery rotates the deep-corrupt primary OVER the last-good .bak before the recovered doc is durable — FIXED

- Cluster/Wave: J/2 · Commit: 9f38ca3
- Fix: `writeProject` no longer rotates before the write: it captures the prior primary's bytes (only when envelope-valid), awaits the atomic primary write, and only then writes the captured bytes to `.bak` — a crash or write failure leaves both the old primary and the last-good .bak untouched.
- Verification: New regression forces a primary-write failure after seeding a deep-corrupt primary + good .bak and asserts both files byte-identical (fails pre-fix). · Adversarial verdict: verified ("at every instant at least one on-disk file is good")

### BUG-008: Autosaver clears `dirty` before the save and never re-arms it on failure — a failed autosave's edits are silently unrecoverable by flush — FIXED

- Cluster/Wave: J/2 · Commit: 9f38ca3
- Fix: `createAutosaver.run()` now sets `dirty = true` in BOTH failure paths (save resolving false, and rejection) before invoking onError, so a later flush (blur, beforeunload, quit handshake) retries instead of no-oping on the `!dirty` gate; no hot-loop risk.
- Verification: 2 new tests — rejected save then flush retries; resolves-false then flush retries, third flush a no-op after success. · Adversarial verdict: verified

### BUG-009: ProjectSwitcher.switchTo has no in-flight guard — concurrent switches can desync renderer boards vs MAIN currentDir, then autosave cross-writes projects — FIXED

- Cluster/Wave: I+J/2 · Commit: 16df5bd, 9f38ca3
- Fix: Renderer half (I): module-level in-flight switch lock (`acquireProjectSwitchLock`/`release...`) shared by ALL switch surfaces (ProjectSwitcher.switchTo, WelcomeScreen openDir/onCreate), released in finally. MAIN half (J): `project:save` accepts an optional `expectedDir` and rejects when it mismatches `getCurrentDir()`, threaded through preload + useAutosave — so even a desync can no longer cross-write canvas.json.
- Verification: Lock-semantics unit test + cross-surface integration test ("in-flight switch from another surface blocks openDir"); new `projectIpc.test.ts` expectedDir-guard describe + preload 3-arg pin (2-arg back-compat preserved). · Adversarial verdict: verified ("both suggested mitigations landed")

### BUG-010: Selecting a board does not clear selectedConnectorId — one Delete press deletes BOTH the selected board and the still-selected connector — FIXED

- Cluster/Wave: K/2 · Commit: 4449934
- Fix: In Canvas.tsx `onNodesChange`, when foldSelectionIntents lands a non-empty node selection, `setSelectedConnectorId(null)` now runs alongside `setSelection` — the inverse of onEdgeClick's `selectBoard(null)` — restoring connector/board selection mutual exclusivity.
- Verification: No new unit test (Canvas cannot mount in jsdom; `foldSelectionIntents` already unit-tested in `nodeChanges.test.ts`); existing suites pass. · Adversarial verdict: verified ("deselect-only folds correctly do NOT clear it, so the two clears can't cancel each other")

### BUG-011: Deleting the dragged board mid-drag latches previewStore.nodeGesture true forever — all Browser previews freeze as snapshots; stale alignment guides stay painted — FIXED

- Cluster/Wave: K/2 · Commit: 4449934
- Fix: `dragNodeIdRef` set in onNodeDragStart and cleared in onNodeDragStop; the existing boards-keyed healing effect now detects the dragged board vanishing (XYDrag aborts without onNodeDragStop) and performs the stop handler's exact cleanup: un-latch nodeGesture, clear guides, overlaps, and dropTargetGroupId.
- Verification: No new unit test (the latch lives in RF's XYDrag abort path; `previewStore.setNodeGesture` covered by previewStore.test.ts). · Adversarial verdict: verified ("reattachment actually happens because usePreviewManager's effect watches nodeGesture; no false-reset on normal drags")

### BUG-012: duplicate → undo → redo of a terminal clone loses its idle-on-mount flag (BUG-033 sweep has no redo counterpart) — the redone clone auto-spawns shell + launchCommand — FIXED

- Cluster/Wave: I/2 · Commit: 16df5bd
- Fix: `undo()` now PARKS swept idle flags (`parkedIdleIds`) instead of dropping them; `redo()` symmetrically re-adds the parked flag for every board it resurrects, so the redone clone stays idle-on-mount (no silent second agent); parked ids are pruned against the redo rail and cleared in markRestoredIdle, preserving the BUG-033 no-leak guarantee.
- Verification: Added "duplicate → undo → redo restores the clone idle-on-mount flag" and "a real edit after duplicate+undo drops the parked flag for good"; both BUG-033 leak tests still pass. · Adversarial verdict: verified

### BUG-013: applyOpenResult's async .bak retry has no epoch/generation check — a late recovery (or error-set) clobbers a concurrently opened project — FIXED

- Cluster/Wave: I/2 · Commit: 16df5bd
- Fix: Added a module-level monotonic `openEpoch`: applyOpenResult captures `++openEpoch` at entry and re-checks immediately after the awaited reopenFromBak IPC; a superseded continuation returns without applying the stale .bak recovery and without stamping `status:'error'` over the newly opened project.
- Verification: 2 interleaved-applyOpenResult tests with a deferred reopenFromBak mock (late recovery and late failure legs). · Adversarial verdict: verified ("the reachability amplifier is independently closed by the BUG-009 shared lock")

### BUG-014: No primary-button guard in the whiteboard pointer machine — right-click erases/creates/moves elements and wipes selection — FIXED

- Cluster/Wave: E/1 · Commit: 8646545
- Fix: Added `if (e.button !== 0) return` guards at the top of `onWellPointerDown` and `startElementDrag` in usePlanningPointer.ts and in the pointerdown handlers of NoteCard, ChecklistCard, ImageCard, and WhiteboardSvg — right/middle presses fall through to the contextmenu path without create/move/erase or selection clearing.
- Verification: 3 regression tests in PlanningBoard.interaction.test.tsx (right-button erase / note-create / empty-well selection); 81/81 pass. · Adversarial verdict: verified ("FreeText's only hazardous path routes through the now-guarded startElementDrag")

### BUG-015: eraseHitTest uses a fixed 160×24 nominal box for text — XL/area text largely un-erasable/un-targetable; short text has a phantom hit band — FIXED

- Cluster/Wave: E/1 · Commit: 8646545
- Fix: `eraseHitTest` now accepts an optional measured map and uses live DOM dimensions for text (and notes/checklists) when positive, falling back to the nominal box; all three call sites in usePlanningPointer.ts pass `measuredRef.current`.
- Verification: erase.test.ts updated — 3 new tests (XL text hit via measured box, phantom band eliminated, note measured height); 11 erase tests pass. · Adversarial verdict: verified

### BUG-016: endMotion ignores menuOpen — camera wheel-zoom while a popover is open reattaches native views over the still-open popover — FIXED

- Cluster/Wave: M/3 · Commit: 38cb9c8
- Fix: `endMotion` now yields to `menuOpen` exactly like `nodeGesture` (single getState read, return if either is set), so a wheel-zoom onEnd while a popover token is registered no longer reattaches native views; the menu-close effect remains the sole reattach authority.
- Verification: New integration test "endMotion vs open popover (BUG-016)" — zero new attach IPCs while menu open, reattach on menu close; fails with the guard reverted. · Adversarial verdict: verified

### BUG-017: BUG-002 fix incomplete: applyLiveness-driven demoteToSnapshot has the same unguarded capture window — a concurrent attachBoard diff-skips and the board is left detached while eligible — FIXED

- Cluster/Wave: M/3 · Commit: 38cb9c8
- Fix: `demoteToSnapshot` now registers the id in the `demoting` set before its capturePreview await and drains it in a finally (mirroring beginMotion's discipline), so a concurrent attachBoard falls through the diff-skip and the demote's seq guards bail instead of detaching the eligible board; also early-returns when already demoting.
- Verification: New integration race test "attach-during-direct-demote race (BUG-017)" — asserts a real attachPreview re-issued and live===true; fails with the registration removed. · Adversarial verdict: verified ("beginMotion is unaffected — the early return can't starve it")

### BUG-018: Pre-push hook skips the entire e2e matrix on a branch's FIRST push — `git diff <single-sha>` diffs against the working tree, not the pushed commits — FIXED

- Cluster/Wave: G/1 · Commit: 0d6bd9b
- Fix: The new-branch (all-zeros remote) case now computes the range from `git merge-base origin/main $local_sha` (fallback `git rev-list --not --remotes=origin | tail -1`); if neither resolves, the hook warns and forces the full matrix (fail-safe) rather than silently skipping.
- Verification: Shell hook — verified by logic trace (two-ref range enumerates only branch commits; `force-full` sentinel fails the docs-only filter so the matrix runs). · Adversarial verdict: verified

### BUG-019: flush reply wired with ipcMain.once — one ignored foreign/spurious message permanently consumes the frame-guarded listener, degrading the BUG-038 guard to the 1500ms timeout — FIXED

- Cluster/Wave: A/1 · Commit: 6575c7b
- Fix: Changed `ipcMain.once(replyChannel, finish)` to `ipcMain.on(...)` so a foreign-frame message the guard correctly ignores does not consume the listener; the existing onCleanup (`removeAllListeners`) handles removal exactly once when finish resolves.
- Verification: 1 regression test ("calling finish with a foreign frame leaves the listener armed"); 78/78 pass. · Adversarial verdict: verified

### BUG-020: sanitizeDispatchText strips C0+DEL but passes C1 controls (U+0080–U+009F) — 8-bit CSI/OSC/DCS forms survive into the confirm modal and the PTY write — FIXED

- Cluster/Wave: D/1 · Commit: 8db61ca
- Fix: Extended the strip predicate in sanitizeDispatchText with `(code >= 0x80 && code <= 0x9f)`, closing the 8-bit CSI/OSC/DCS/NEL injection path that bypassed the existing C0+DEL filter.
- Verification: 3 new tests (full C1 range loop, CSI/NEL spot-check, printable non-ASCII above U+009F preserved); all pass. · Adversarial verdict: verified

### BUG-021: injectCspMeta silently returns input on regex no-match and is never tested against the real index.html — a meta-tag reshape would silently ship the dev CSP in packaged builds — FIXED

- Cluster/Wave: O/3 · Commit: aa77149
- Fix: `injectCspMeta` now hard-fails on regex no-match (hoisted CSP_META_RE + test()-guard that throws a descriptive error), so any future reshape of the CSP meta tag fails `pnpm build`/`pnpm dev` loudly instead of shipping the dev CSP (`script-src 'unsafe-inline'`).
- Verification: 2 regression tests — throws for all four reshape cases (dev + prod modes), and runs against the REAL `src/renderer/index.html` from disk asserting the prod content attribute; 6/6 pass; end-to-end build sanity check shows the prod policy in out/renderer. · Adversarial verdict: verified

### BUG-022: Natural-exit cleanup unconditionally tree-kills the already-exited PID — narrow PID-reuse race can force-kill an unrelated same-user process tree — FIXED

- Cluster/Wave: B/1 · Commit: ad1d517
- Fix: `cleanupCore` now skips `killTree` when the session state is already 'exited' AND the call comes from the process's own onExit; explicit `pty:kill` still always tree-kills.
- Verification: 2 regression tests (killTree NOT called on natural exit; IS called for explicit kills); all pass. · Adversarial verdict: concern (skipping killTree wholesale dropped the card's preserve-child-reaping constraint and the `proc.kill()` ConPTY/conout-worker disposal) → resolved by amendment 81365b6: natural-exit still calls `proc.kill()` — disposing the ConPTY handle + conout worker and reaping pseudoconsole children — without taskkilling a possibly recycled PID.

### BUG-023: Spawn accepts cols>1000 that isValidResize forever rejects afterward — a >1000-col terminal board's PTY silently freezes at spawn dimensions (row changes dropped too) — FIXED

- Cluster/Wave: B/1 · Commit: ad1d517
- Fix: Extracted an exported `clampSpawnDim(value, fallback)` helper (truncate then clamp to [1, 1000], the same bounds isValidResize enforces); both spawn-time col/row values go through it, making spawn and resize self-consistent.
- Verification: 6 unit tests (in-range, clamps, truncation, non-finite fallback, clamped-value-passes-isValidResize loop); all pass. · Adversarial verdict: concern (the resize path still DROPPED >1000-col resize messages entirely, freezing row updates) → resolved by amendment 81365b6: oversized-but-legitimate resizes are now clamped and applied instead of dropped, so >1000-col boards keep their row updates.

### BUG-024: adoptCore replaces a live same-id session without reaping it — the displaced proc escapes both maps and survives disposeAllPtys/quit — FIXED

- Cluster/Wave: B/1 · Commit: ad1d517
- Fix: `adoptCore` now checks `sessionsMap.has(id)` and calls `cleanupCore` on the live entry before replacing it — mirroring the Bug #13 guard on the spawn path; the deps type was widened to include `killTree`.
- Verification: 2 regression tests (displaced live session reaped — killTree called, port closed; no killTree when none live); all pass. · Adversarial verdict: verified ("the reap path passes proc=undefined so the BUG-022 skip does not apply")

### BUG-025: stripAnsi misses 8-bit C1 introducers and leaks 7-bit DCS payloads into the 'plain text' MCP scrollback page — FIXED

- Cluster/Wave: B/1 · Commit: ad1d517
- Fix: Extended the ANSI regex in ptyOutput.ts with 8-bit C1 CSI (0x9B), OSC (0x9D), and DCS (0x90) branches, and a 7-bit DCS branch that strips the full payload through ST, not just the 2-byte introducer.
- Verification: 7 new stripAnsi tests covering all terminator variants (BEL, 0x9C ST, ESC-backslash); 99 tests pass. · Adversarial verdict: verified

### BUG-026: Staged-image filenames collide across app restarts — module-level seq resets and writeFileSync silently overwrites a prior session's staged image — FIXED

- Cluster/Wave: D/1 · Commit: 8db61ca
- Fix: Added a 4-byte CSPRNG hex suffix (`randomBytes(4).toString('hex')`) to every staged-image filename in stageClipboardImage, making filenames collision-free across restarts regardless of the seq reset.
- Verification: Regression test verifies the `paste-<safeId>-<seq>-<8hex>.png` pattern and distinct consecutive paths; cleanupStaged's prefix matching unaffected. · Adversarial verdict: verified

### BUG-027: localServer removes its only 'error' listener after listen — a runtime accept error becomes an unhandled 'error' event that exits the whole app — FIXED

- Cluster/Wave: A/1 · Commit: 6575c7b
- Fix: Added a permanent `server.on('error', ...)` handler after listen() succeeds, so runtime accept errors (EMFILE/ENFILE) log and degrade instead of crashing via the uncaughtException sink; the once-listener for listen()-time failures is preserved.
- Verification: Native net.Server runtime surface — no unit test (would require mocking the accept path); fix mechanically correct; 78/78 pass. · Adversarial verdict: verified ("the server never again has zero 'error' listeners")

### BUG-028: preview:screenshot reports 'copied to clipboard' even when the clipboard write threw and nothing was saved anywhere — FIXED

- Cluster/Wave: P/4 · Commit: e5f95ce
- Fix: The handler now tracks a `clipboardOk` flag (writeImage catch sets it false) added to ScreenshotResult; the no-project and save-failed paths propagate it, and BrowserBoard's toast branches on it (total failure / saved-only / genuinely copied).
- Verification: Main: 2 new regression tests + 4 updated for the new shape (8/8); renderer: 3 toast tests in BrowserBoard.test.tsx. · Adversarial verdict: verified

### BUG-029: Untrusted preview content can fire unbounded, gesture-free shell.openExternal calls via window.open (OS browser tab flood / phishing launcher) — FIXED

- Cluster/Wave: L/3 · Commit: f65256d
- Fix: Added an exported pure `createOpenExternalLimiter` (per-view token bucket: burst 3, refill 1 per 10s ≈ 6/min sustained) wired into each view's setWindowOpenHandler; the handler still always returns deny, and the renderer-gesture `preview:openExternal` is deliberately not limited.
- Verification: Unit suite with injected fake clock (100-call flood blocked, refill, cap) + integration test driving the actually-installed handler (10 rapid opens → exactly 3 forwarded); 44/44 pass. · Adversarial verdict: verified

### BUG-030: bus.once + foreign-frame early-return cannot 'ignore and keep waiting' — one foreign event on the reply channel consumes the listener and forces the backstop deny/timeout — FIXED

- Cluster/Wave: D/1 · Commit: 8db61ca
- Fix: Replaced `bus.once` with `bus.on` in both `mcpConfirm.requestConfirm` and `mcpCommand.sendMcpCommand`; finish() already removes the listener on every resolution path, so teardown stays exactly-once while a foreign-frame event no longer consumes the listener.
- Verification: BUG-030 regression tests in both integration files (foreign event then genuine reply resolves correctly, not via timeout); all pass. · Adversarial verdict: verified ("a revert to bus.once would fail the tests")

### BUG-031: mcp:command ack channel still uses predictable Date.now()+Math.random() — the one reply channel left out of the CSPRNG hardening sweep — FIXED

- Cluster/Wave: D/1 · Commit: 8db61ca
- Fix: Replaced the predictable reply channel in sendMcpCommand with `randomUUID()` from node:crypto (`mcp:command:ack:<uuid-v4>`), completing the CSPRNG hardening sweep started in mcpConfirm and flushChannel.
- Verification: Regression test asserts the v4 UUID shape and rejects the old Date.now():base36 shape; all pass. · Adversarial verdict: verified

### BUG-032: removeRecapHook throws on malformed settings.local.json after consent is persisted — 'declined' recorded but the SessionStart hook stays installed — FIXED

- Cluster/Wave: A/1 · Commit: 6575c7b
- Fix: Made `removeRecapHook` tolerant of malformed settings: `Array.isArray(blocks)` early-return, non-object block pre-filter, and `Array.isArray(b.hooks) ? filter : []` — a malformed file no longer throws out of the IPC handler.
- Verification: 3 regression tests (non-array hooks, non-array SessionStart, mixed malformed+valid); 78/78 pass. · Adversarial verdict: verified

### BUG-033: mcp:boards sender guard is a stale inline copy, not ipcGuard.isForeignSender — fails OPEN when the window is unresolved and throws on a destroyed window — FIXED

- Cluster/Wave: A/1 · Commit: 6575c7b
- Fix: Replaced the stale inline sender guard in `registerBoardRegistryHandler` with `isForeignSender(e, getWin)` from `./ipcGuard` — null window now DENIES (fail-closed) and a destroyed window is guarded without throwing.
- Verification: 3 regression tests in new boardRegistry.test.ts (null-window denial, destroyed-window non-throw, legitimate-frame acceptance); 78/78 pass. · Adversarial verdict: verified

### BUG-034: readTranscriptTail discards readSync's bytesRead over Buffer.allocUnsafe — a shrink-race short read decodes uninitialized MAIN-heap bytes into the milestone-extraction input — FIXED

- Cluster/Wave: A/1 · Commit: 6575c7b
- Fix: `readTranscriptTail` now uses readSync's return value as the byte count for `buf.toString('utf8', 0, bytesRead)` instead of decoding the full allocUnsafe buffer.
- Verification: 1 regression test ("returned string length equals the file byte size — no heap overread"); 78/78 pass. · Adversarial verdict: verified

### BUG-035: boardResults Map is never cleared on project switch or board deletion — stale (and id-colliding cross-project) results served via canvas://board/{id}/result — FIXED

- Cluster/Wave: A/1 · Commit: 6575c7b
- Fix: Added `pruneBoardResults(liveBoardIds)` export and wired it into the `onBoardsObserved` callback (alongside `recapWatcher.retain()`), clearing stale results from deleted boards on every project open/save/switch.
- Verification: 3 regression tests in boardResults.test.ts; 78/78 pass. · Adversarial verdict: concern (the headline cross-project id-collision repro was not closed — a colliding id in the new project's live set retained the old project's verdict) → resolved by amendment 81365b6: board results are now cleared outright on project open, so id-colliding boards can no longer inherit a previous project's verdict.

### BUG-036: llm:setConfig persists maxCallsPerDay with zero runtime validation (and leaves baseUrl length unbounded) — escapes the BUG-040 hardening in the same handler — FIXED

- Cluster/Wave: C/1 · Commit: 2303a97
- Fix: Added MAX_BASE_URL_LEN (2048) and MAX_CALLS_PER_DAY_CAP (1,000,000) checks in the llm:setConfig handler, rejecting non-integer/negative/huge/non-number values before they reach `writeFileAtomic.sync`.
- Verification: Integration tests "setConfig rejects invalid maxCallsPerDay values" and "rejects an over-long baseUrl"; all 92 llm tests pass. · Adversarial verdict: verified ("a non-string truthy baseUrl skips the length check but is rejected by isLoopbackBaseUrl's typeof guard, so no bypass")

### BUG-037: llm:summarize validates input.text but not input.system — a truthy non-string system builds a malformed provider body that burns a non-refunded budget slot; no length bound on either field — FIXED

- Cluster/Wave: C/1 · Commit: 2303a97
- Fix: Extended the llm:summarize input guard: `input.system` when present must be a non-empty string, and MAX_SUMMARIZE_TEXT_LEN (100,000) bounds both text and system — all checked before readLlmConfig/runSummarize so no budget slot is consumed.
- Verification: Integration tests for non-string system (budget slot not consumed) and over-long text/system; all 92 pass. · Adversarial verdict: verified

### BUG-038: Configured caps above MAX_PERSISTED_CALLS (2000) are unenforceable — the persisted counter wraps to 0 through the corrupt-file rejection path, with a misleading corruption warning per call — FIXED

- Cluster/Wave: C/1 · Commit: 2303a97
- Fix: Made the rejection ceiling in `read()` dynamic — `max(configuredCap, 2000)` — with tryConsume/peek tracking the largest cap seen (knownCap), so counts above 2000 for a higher configured cap are accepted instead of false-corrupt-reset and wrap.
- Verification: 2 unit tests (caps above 2000 no longer warn/wrap; below-ceiling counts accepted as before); all pass. · Adversarial verdict: verified ("the cap is still enforced at the boundary")

### BUG-039: runSummarize breaks its documented never-throws contract when the budget persist throws — tryConsume runs outside the try/catch and the llm:summarize IPC promise rejects raw — FIXED

- Cluster/Wave: C/1 · Commit: 2303a97
- Fix: Moved `deps.budget.tryConsume(cap)` inside runSummarize's try/catch so a synchronous fs throw from the budget write (EPERM/ENOSPC/AV lock) is caught and mapped to a typed provider-error result instead of rejecting the IPC promise raw.
- Verification: Unit test "returns provider-error (not raw throw) when tryConsume throws"; all pass. · Adversarial verdict: verified

### BUG-040: Saving Settings with a non-local provider unconditionally overwrites (wipes) the stored local baseUrl — the preserve-when-omitted principle is not applied to baseUrl — FIXED

- Cluster/Wave: N/3 · Commit: 8d37f15
- Fix: llm:setConfig now applies preserve-when-omitted to baseUrl (`a.baseUrl ?? existing.baseUrl`), so a non-local Save no longer wipes the stored local baseUrl and local → openrouter → local round-trips keep the local provider configured; an explicitly sent baseUrl still overwrites; all prior validation runs first.
- Verification: Integration test covers the full round trip (baseUrl preserved, hasProvider:true) and explicit overwrite; suite green. · Adversarial verdict: verified

### BUG-041: A trailing slash on the local baseUrl produces '…/v1//chat/completions' — no normalization anywhere, and the opaque 'local HTTP 404' error makes it undiagnosable — FIXED

- Cluster/Wave: C/1 · Commit: 2303a97
- Fix: buildRequest normalizes the baseUrl with `replace(/\/+$/, '')` before the URL join, and the local-provider HTTP error message now includes the attempted URL (local only, to avoid leaking cloud endpoint detail).
- Verification: 3 trailing-slash normalization tests + "surfaces the attempted URL in a local 404 error"; all pass. · Adversarial verdict: verified

### BUG-042: createProject on a folder where BOTH canvas.json and .bak are unparseable silently overwrites the corrupt primary's bytes with a fresh empty doc — FIXED

- Cluster/Wave: J/2 · Commit: 9f38ca3
- Fix: When reuse-if-exists fails, createProject now renames any existing canvas.json / .bak aside to `<name>.corrupt-<timestamp>` before writing the fresh doc, preserving the hand-recoverable bytes; rename is best-effort, and brand-new folders are unaffected.
- Verification: Regression seeds truncated/garbled files and asserts createProject succeeds with both originals surviving byte-identical in the .corrupt-<ts> siblings. · Adversarial verdict: verified

### BUG-043: audit:read limit is unvalidated: limit:0 returns the ENTIRE log (slice(-0) === slice(0)), and every read loads the whole unbounded JSONL into memory — FIXED

- Cluster/Wave: D/1 · Commit: 8db61ca
- Fix: Clamped limit to a positive finite integer in `AuditLog.read` (1000-entry ceiling, invalid → default 200) and added matching validation at the IPC boundary in registerAuditHandler — defense-in-depth so neither layer can be bypassed.
- Verification: 3 regression tests in auditLog.test.ts + 4 in auditIpc.integration.test.ts; all pass. · Adversarial verdict: verified (advisory tail-reading suggestion not taken; IPC payload now bounded)

### BUG-044: A transiently-slow (>500ms) recent-project path is not just hidden but PERMANENTLY deleted from the MRU file by the next touchRecent — FIXED

- Cluster/Wave: J/2 · Commit: 9f38ca3
- Fix: touchRecent no longer persists from listRecents' timeout-filtered output — extracted `readStoredRecents()` (read + shape-validate, no existence filtering); the prune is now display-only, so a transiently-unreachable path reappears when the share wakes.
- Verification: Regression seeds an unreachable path, touches another project, asserts listRecents hides it while the on-disk MRU still holds both entries. · Adversarial verdict: verified

### BUG-045: BoardMenu's ⋯ trigger lacks a pointerdown stopPropagation — clicking the open trigger closes then instantly reopens the menu (toggle is dead) — FIXED

- Cluster/Wave: K/2 · Commit: 4449934
- Fix: The trigger wrapper div now stops the real pointerdown (ProjectSwitcher/AppChrome parity pattern), so the document-level closer no longer fires before the trigger's click — clicking the open ⋯ now closes the menu.
- Verification: New test fires the real pointerdown-then-click order and asserts the menu unmounts; adversarially checked — removing the fix makes exactly this test fail. · Adversarial verdict: verified

### BUG-046: startPlacement has no pointer-button filter — right/middle-click while a placement tool is armed creates a phantom board — FIXED

- Cluster/Wave: K/2 · Commit: 4449934
- Fix: `startPlacement` now early-returns on `e.button !== 0`, so a right/middle press with an armed placement tool neither starts the ghost drag nor commits a phantom board; the tool stays armed.
- Verification: New test (pointerDown with button:2 then pointerup → 0 boards, tool still armed); all placement tests pass. · Adversarial verdict: verified

### BUG-047: Placement drag has no blur/pointercancel teardown — a stale window pointerup later commits a phantom board spanning from the abandoned drag origin — FIXED

- Cluster/Wave: K/2 · Commit: 4449934
- Fix: The in-flight placement drag now registers window 'pointercancel' and 'blur' listeners that call abortDrag (same teardown as Esc — listeners removed, ghost cleared, tool stays armed), torn down via the same dragCleanupRef.
- Verification: 2 new tests (blur and pointercancel mid-drag, then a later pointerup → 0 boards); both fail pre-fix. · Adversarial verdict: verified

### BUG-048: Connector rubber-band drag has no Esc abort and no blur/pointercancel teardown — a stale pointerup over a board silently commits an orchestration connector — FIXED

- Cluster/Wave: K/2 · Commit: 4449934
- Fix: The connector rubber-band gesture gained abort paths — capture-phase Esc, window blur, and pointercancel all clear connectFromId/connectPointer without committing; the whole effect moved verbatim (plus the abort) into a new exported `useConnectorDrag` hook in useBoardPlacement.ts, making the gesture unit-testable for the first time.
- Verification: New useConnectorDrag describe — happy-path commit (verbatim move preserved behavior) + 3 abort regressions; targeted set 102 tests / 11 files green. · Adversarial verdict: verified

### BUG-049: Explicit push of an unchanged URL to an already-linked browser never consumes the reloadNonce bump — no immediate reload, plus a deferred surprise re-navigate on the next unrelated boards mutation — FIXED

- Cluster/Wave: P/4 · Commit: e5f95ce
- Fix: usePreviewManager now subscribes to previewStore and consumes a reloadNonce bump directly (one-microtask deferred so a url-changing push lands its updateBoard first and reconcile consumes url+nonce together) — same-URL pushes reload immediately and the deferred surprise re-navigate is gone. The useBrowserAutoConnect half of the card was verified benign (no change).
- Verification: 2 new integration tests (lone requestReload navigates exactly once with no later surprise; reload + url change in one tick navigates exactly once, to the new url); first test fails pre-fix by construction. · Adversarial verdict: verified

### BUG-050: Note hit/bbox geometry uses the never-updated persisted h:96 while NoteCard auto-sizes — phantom erase band below short notes, unreachable bottoms of tall notes — FIXED

- Cluster/Wave: E/1 · Commit: 8646545
- Fix: NoteCard gained an `onMeasure` prop wired through a ResizeObserver effect reporting its rendered size (mirroring the ChecklistCard pattern); `elementBBox` and `eraseHitTest` note cases now prefer the measured height over the stale schema h:96; PlanningBoard wires `reportMeasure`.
- Verification: BUG-050 unit test in elements.test.ts (measured-h used, zero/no-measurement fallbacks) + ResizeObserver stub in the interaction test; 81 targeted tests pass (stub also landed in the images test, 5c45858). · Adversarial verdict: verified (whiteboardExport's nominal-extent tail noted as pre-existing/cosmetic)

### BUG-051: useAssetUrl cleanup decrements a refcount it never claimed (cancelled-read and miss-then-hit interleavings) — premature blob-URL revoke for a live sibling / double-claim leak — FIXED

- Cluster/Wave: E/1 · Commit: 8646545
- Fix: `useAssetUrl` now tracks per-instance claim state (`layoutClaimedRef` + closure-local `passiveClaimed`); cleanup only decrements a ref it actually took, closing both the cancelled-read and the layout-miss/passive-hit interleavings while preserving the two-effect sibling-ordering guarantee.
- Verification: No deterministic unit test feasible (one-IPC-round-trip race in jsdom); verified by code-path accounting — every claim site sets passiveClaimed, cleanup guarded on it; 83 tests pass. · Adversarial verdict: verified ("the inverse double-claim leak is also accounted")

### BUG-052: Transient drag positions (and alt-drag ghost copies) of a checklist permanently grow the board height via the untracked growBoardHeight path — FIXED

- Cluster/Wave: E/1 · Commit: 8646545
- Fix: `growForChecklist` now skips ids starting with `__ghost__` (alt-drag ghosts) and any id covered by a live dragPos (via a dragPosRef mirror of usePlanningPointer's dragPos), so only committed positions trigger a board-height grow.
- Verification: Render-path guard with no unit-testable pure surface; covered by existing interaction tests (83 pass). · Adversarial verdict: concern (the parent-effect mirror had a one-frame phase error: first move frame could still grow, and a legitimately committed move-down could never re-trigger the grow) → resolved by amendment 81365b6: the dragPos mirror moved to useLayoutEffect — it gates the first drag frame correctly and lets the drop-commit measure re-fire after the ref clears, so legitimate grow is no longer suppressed.

### BUG-053: Double-click inside the TerminalConfig popover (or preview note) flips the board to recap, leaving the open config pointer-dead — FIXED

- Cluster/Wave: F/1 · Commit: f7902be
- Fix: Extended the flip stage's `closest()` selector to include `select, label`, and added `data-no-flip` to the TerminalConfig root and the `.ca-preview-note` div, so double-click anywhere inside those containers no longer flips the board.
- Verification: No new unit test (DOM-attribute/selector change inside an onDoubleClick handler); guard verified by inspection — selectors cover all TerminalConfig child elements. · Adversarial verdict: verified

### BUG-054: launch()'s spawnTerminal .then/.catch lack respawn()'s disposed/term-identity guard — a late spawn failure marks the successor session 'spawn-failed' and writes into a disposed xterm — FIXED

- Cluster/Wave: F/1 · Commit: f7902be
- Fix: Added the same disposed/term-identity guard respawn() already has (`disposed || termRef.current !== term`) to launch()'s .then/.catch in useTerminalSpawn.ts, so a stale spawn rejection after the effect re-ran is discarded.
- Verification: No new unit test (race requires the full spawn-effect machinery + real layout; not jsdom-reproducible); mirrors the already-tested respawn pattern exactly. · Adversarial verdict: verified ("no other unguarded spawnTerminal call site exists")

### BUG-055: Ctrl + zero-deltaY wheel events (tilt-wheel / horizontal trackpad pan) shrink the terminal font — FIXED

- Cluster/Wave: F/1 · Commit: f7902be
- Fix: Added an early return for `e.deltaY === 0` in the Ctrl+wheel font-zoom handler (before preventDefault), so horizontal-only scroll events no longer decrement the font toward the minimum.
- Verification: No new unit test (native addEventListener inside a useEffect); one-line early return correct by inspection — deltaY===0 is the precise discriminant. · Adversarial verdict: verified

### BUG-056: pasteIntoTerminal's disposal guard (`term.element === undefined`) never fires — a paste resolving after teardown writes into a disposed Terminal — FIXED

- Cluster/Wave: F/1 · Commit: f7902be
- Fix: Replaced the ineffective `term.element === undefined` guard with an optional `isLive: () => boolean` predicate (defaults true); call sites pass `() => termRef.current === term` so a paste resolving after respawn/unmount is discarded.
- Verification: 4 BUG-056 regression tests in TerminalBoard.paste.test.ts (isLive false blocks image and text paste, true passes, default preserves behavior); 19 paste tests pass. · Adversarial verdict: verified ("the isLive-true sanity test fails under the old element-undefined guard, so the suite is not false-green")

### BUG-057: Auto-connect detect path calls updateBoard without beginChange — background 1s timer silently destroys the user's redo branch — FIXED

- Cluster/Wave: I/2 · Commit: 16df5bd
- Fix: Added a history-neutral module-level `patchBoardUntracked(id, patch)` (same PATCHABLE_KEYS-filtered, value-diffed merge as updateBoard, but records no checkpoint and never clears `future`); useBrowserAutoConnect's detect-push now uses it, so the background timer can no longer wipe an armed redo stack.
- Verification: 2 store tests ("applies a url patch without clearing an armed redo branch or recording a step"; key filtering + identical-value no-op); autoConnect policy tests still green. · Adversarial verdict: verified ("history-invisible chosen over the card's tracked-step suggestion; the undo-reverts case self-heals via the detect loop")

### BUG-058: reconcile's attached-board bounds re-push lacks the full-view guard — pushes the camera-scaled canvas rect to a full-view board's native view — FIXED

- Cluster/Wave: M/3 · Commit: 38cb9c8
- Fix: reconcile's attached-board bounds re-push branch now carries the same full-view guard the other two bounds producers (attachBoard, flushBatch) already have — it skips the board currently in full view, leaving the full-view rAF pump as the sole owner of that board's bounds.
- Verification: New integration test enters full view via a real portaled frame rect, mutates boards, and asserts zero new attach IPCs for the full-view board; fails with the guard reverted. · Adversarial verdict: verified

### BUG-059: URL draft is clobbered mid-edit: render-time re-sync on board.url change resets draftUrl even while the input is focused — FIXED

- Cluster/Wave: P/4 · Commit: e5f95ce
- Fix: The render-time draft re-sync is now gated on the URL input not being focused (editingUrl), with a `urlDirty` ref so a focus-without-edit blur re-syncs from board.url instead of committing a stale draft; Escape clears the dirty flag before blurring (also fixing the adjacent Escape-commits-instead-of-discarding latent bug).
- Verification: New BrowserBoard.test.tsx — 4 tests (mid-edit external change keeps the draft + edited blur commits; unfocused re-sync; non-dirty blur keeps the external url; Escape discards); first test fails pre-fix. · Adversarial verdict: verified

### BUG-060: digestPlanning labels a planning board with only text/stroke/image/arrow content as 'Empty board' — FIXED

- Cluster/Wave: H/1 · Commit: c5c4346
- Fix: digestPlanning now counts text, arrow, stroke, and image elements alongside notes/checklists; the 'Empty board' fallback is correctly gated on `elements.length === 0`.
- Verification: 5 new regression tests (one per element kind + all kinds combined); 60 targeted tests pass. · Adversarial verdict: verified

### BUG-061: OVERVIEW_FRAME omits maxZoom, so it inherits the flow's Z_MAX 2.5 and frames TIGHTER than Fit (maxZoom 2) for small clusters — FIXED

- Cluster/Wave: H/1 · Commit: c5c4346
- Fix: Added explicit `maxZoom: 1` to OVERVIEW_FRAME in canvasView.ts so the bird's-eye view can never frame tighter than Fit; AppChrome needed no change.
- Verification: 2 regression tests (OVERVIEW maxZoom <= FIT maxZoom; maxZoom explicitly defined, not inherited); 60 targeted tests pass. · Adversarial verdict: verified (cosmetic comment-drift noted only)

### BUG-062: stackCenteredRows retains the Math.max(0, ...widths) spread — residual site of the spread-RangeError class already fixed twice in the same file — FIXED

- Cluster/Wave: H/1 · Commit: c5c4346
- Fix: Replaced the `Math.max(0, ...widths)` spread in stackCenteredRows with a linear scan, matching the style of the two prior fixes in the same file; groupReflow's smart mode goes through the same function.
- Verification: Sentinel-based regression test (Math.max monkey-patched to throw at >10 args, 13 clusters fed through smart mode) — throws without the fix; 60 targeted tests pass. · Adversarial verdict: verified ("grep confirms no remaining spread-into-Math.min/max")

### BUG-063: digestTerminal emits only the first linked preview consumer (find, not filter) — multi-viewport compare canvases are under-reported — FIXED

- Cluster/Wave: H/1 · Commit: c5c4346
- Fix: digestTerminal now uses filter instead of find to collect all browser boards whose previewSourceId matches the terminal, emitting one 'Feeds preview' line per consumer.
- Verification: Regression test with one terminal linked to three viewport consumers asserts exactly 3 'Feeds preview' lines; 60 targeted tests pass. · Adversarial verdict: verified

### BUG-064: MAIN-pushed recap:learned patch goes through updateBoard and silently clears an armed redo stack (and is reverted by any later undo) — FIXED

- Cluster/Wave: I/2 · Commit: 16df5bd
- Fix: Added module-level `patchBoardMeta(id, {agentSessionId?, agentTranscriptPath?})` that value-diffs the two terminal-only recap fields onto the live board AND rewrites the matching entry inside every past/future snapshot plus any pending checkpoint, never clearing `future`; App.tsx's recap onLearned handler uses it instead of updateBoard.
- Verification: 3 tests — redo branch survives and metadata survives undo AND redo (rails rewritten); identical re-push is a full ref-level no-op; never lands on a non-terminal board. · Adversarial verdict: verified

### BUG-065: Settings recap toggle is optimistic fire-and-forget: ignores {ok:false} and lets a recap:setConsent rejection float unhandled, showing a false-saved state — FIXED

- Cluster/Wave: N/3 · Commit: 8d37f15
- Fix: New `onRecapToggle()` mirrors the llm save/clear pattern: optimistic set, await the reply, and on a resolved {ok:false} OR a rejection it reverts recapConsent and surfaces an error via the existing role=alert slot — the rejection is caught so no unhandledRejection floats.
- Verification: 2 tests — {ok:false} on untick reverts + shows the alert; a rejection reverts, alerts, and fires zero unhandledrejection events; suite green. · Adversarial verdict: verified

### BUG-066: RecapConsentModal.decide() handles only rejections — a non-throwing {ok:false} reply closes the modal as if the decision persisted — FIXED

- Cluster/Wave: N/3 · Commit: 8d37f15
- Fix: `decide()` now reads the resolved reply and treats a non-throwing `{ok:false}` exactly like a rejection — modal stays open, inline error shown, buttons re-enable; `onClose()` fires only on `{ok:true}`, restoring the close-only-once-durably-persisted invariant.
- Verification: New test mocks `{ok:false}` → alert shown, onClose never called, retry enabled; suite green. · Adversarial verdict: verified

### BUG-067: `--diff-filter=ACMR` excludes deletions — delete+docs pushes/commits classify as docs-only and delete-only pushes skip e2e entirely — FIXED

- Cluster/Wave: G/1 · Commit: 0d6bd9b
- Fix: Changed `--diff-filter=ACMR` to `--diff-filter=ACMRD` in both pre-push and pre-commit so deleted paths participate in the docs-only classification.
- Verification: Shell hooks — verified by logic trace (a deleted src path fails the docs pattern so the docs-only branch is not taken). · Adversarial verdict: verified

### BUG-068: Pre-push hook dies silently (set -e + 2>/dev/null) when the advertised remote tip object is not in the local store — FIXED

- Cluster/Wave: G/1 · Commit: 0d6bd9b
- Fix: The git-diff command substitution is now guarded with `|| { warn; changed+=force-full; continue; }` — a missing-object failure prints a visible warning and forces the full e2e matrix instead of killing the hook silently via set -e.
- Verification: Shell hook — verified by logic trace (the `||` compound prevents the set -e abort; failure direction is fail-safe). · Adversarial verdict: verified

### BUG-069: Review workflow allowlists unrestricted `Bash(gh api:*)` while the agent processes PR-head-controlled content — prompt injection can drive arbitrary repo API writes — FIXED

- Cluster/Wave: G/1 · Commit: 0d6bd9b
- Fix: Narrowed the `Bash(gh api:*)` wildcard to five explicit prefix allowlist entries covering exactly the gh api forms the workflow prompt uses (comment list/delete for self-clear, issue-comment list/delete, milestones list) — `gh api -X POST .../reviews` (self-approve) and `-X PATCH` issue mutation no longer prefix-match.
- Verification: Verified by exhaustive enumeration of every gh api call in the prompt against the five prefixes — all legitimate calls match, no write endpoint reachable; inline YAML comment documents each entry. · Adversarial verdict: verified (residuals inherent to the card's own suggested prefix shape, accepted)

### BUG-070: `prepare` script swallows hook-installation failure with an empty catch — the sole mechanism enabling the only e2e gate can no-op with zero signal — FIXED

- Cluster/Wave: G/1 · Commit: 0d6bd9b
- Fix: The prepare script's empty catch now writes a loud `[prepare] WARNING: git config core.hooksPath .githooks failed (...)` to stderr; it still does not rethrow (install must not fail in CI/Docker where git config legitimately fails).
- Verification: Lifecycle script — verified by inspection (process.stderr.write is synchronous; the catch does not exit, so installs still succeed). · Adversarial verdict: verified

### BUG-071: Renderer-only deps in `dependencies` are double-shipped: Vite-bundled into out/renderer AND packed as raw node_modules in app.asar — FIXED

- Cluster/Wave: O/3 · Commit: aa77149
- Fix: Moved the seven renderer-only packages (@xterm/xterm + fit/webgl addons, @xyflow/react, react, react-dom, zustand) from `dependencies` to `devDependencies` after auditing every main/preload runtime import, so electron-builder stops packing their trees into app.asar; all genuine MAIN runtime deps stay.
- Verification: Not unit-testable (packaging concern) — `pnpm build` green for all three targets with the renderer bundles intact; verifier confirmed the lockfile regenerated with dev-flag moves only and no main/preload source imports any moved package. · Adversarial verdict: verified

### BUG-072: tsconfig.web.json grants project-wide Node ambient types to the sandboxed renderer, blinding typecheck to 'renderer never touches Node' violations — FIXED

- Cluster/Wave: H/1 · Commit: c5c4346
- Fix: Removed 'node' from tsconfig.web.json `compilerOptions.types` (set to `[]`) so the sandboxed renderer no longer has Node ambient globals and the typecheck gate can catch process/Buffer/fs leaks.
- Verification: `pnpm typecheck:web` exit 0 with zero errors (no renderer source used any Node ambient); verifier independently re-ran tsc on the worktree — clean. · Adversarial verdict: verified
