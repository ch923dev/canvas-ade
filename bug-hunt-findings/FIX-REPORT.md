# Fix Run Report

Generated: 2026-05-30 · Package: `bug-hunt-findings/` · Repo: `Z:\Canvas ADE` · Branch: `fix/bug-hunt-batch`

| Outcome | Count |
|---------|-------|
| Fixed (verified) | 33 |
| Needs review | 0 |
| Blocked (collision/dependency) | 0 |
| Out of scope (skipped/unconfirmed) | 24 (`skipped-roadmap.md` ×1 + `unconfirmed.md` ×23) |

**Verification (whole-integration):** `pnpm typecheck` ✓ · `pnpm lint` ✓ (0 problems) · `pnpm test` ✓ (240 passed, +15 new regression tests vs the 225 baseline) · `pnpm build` ✓. Every fix was additionally **adversarially re-verified** by an independent agent that tried to refute it against the final integrated code (7-agent verification workflow); two lint regressions (BUG-012/029, BUG-028) and one incomplete fix (BUG-024) were caught and remediated in a follow-up pass.

## How this run was structured (collision-aware)

The 33 cards cluster on a few hot files (`BrowserPreviewLayer.tsx` ×9, `TerminalBoard.tsx` ×6, `pty.ts` ×5, `preview.ts` ×5, `PlanningBoard.tsx` ×4). Four "bridge" cards (002/007/013/033) touch files owned by multiple domains. So work was scheduled as **6 file-disjoint domain lanes in parallel** (each a worktree-isolated agent fixing its cards sequentially, `node_modules` junctioned to skip the native rebuild), then the **4 bridge cards** applied directly on the integration branch in two collision-safe waves.

**Wave plan executed:**
- **Lanes (parallel, 29 cards):**
  - lane-pty → BUG-001, 004, 006
  - lane-terminal → BUG-011, 012, 016, 023, 029
  - lane-browser → BUG-005, 008, 009, 014, 015, 018, 020, 030, 032
  - lane-canvas → BUG-003, 017, 019, 025, 027
  - lane-planning → BUG-021, 022, 024, 026, 028
  - lane-server → BUG-010, 031
- **Bridge wave 1:** BUG-002 ‖ BUG-013
- **Bridge wave 2:** BUG-007 ‖ BUG-033
- **Verification-driven follow-ups:** BUG-012/029 (lint), BUG-028 (lint), BUG-024 (completeness), BUG-017 (scoping), BUG-005 (preload type mirror)

**Delivery note (one-bug-per-branch adaptation):** pure per-bug branches are infeasible here — 9 cards co-edit `BrowserPreviewLayer.tsx`, 6 co-edit `TerminalBoard.tsx`, etc. Instead the run produced **one commit per bug** on a single integration branch `fix/bug-hunt-batch` (clean revert units), file-disjoint lanes merged as `--no-ff` lane merges, bridges + follow-ups committed directly. No remote PRs were opened (recommend the batch branch as one PR with per-bug commits). The 6 lane branches were merged then deleted; their per-bug commits are preserved on the integration branch.

**Out of scope (untouched, by construction):** the 1 roadmap-deferred finding (`skipped-roadmap.md`) and the 23 unconfirmed candidates (`unconfirmed.md`).

---

## Per-fix records

### BUG-001: Unguarded proc.write/proc.resize throw on an exited pty → app crash — FIXED
- **Branch / commit:** `fix/bug-hunt-batch` · `4fd6fe4` · Wave: lane-pty
- **Files changed:** `src/main/pty.ts`
- **Fix:** wrapped proc.write/proc.resize in both the spawn-time and adopt-time MessagePort `message` handlers in try/catch, mirroring the existing onData/onExit guards — a resize on an exited-but-not-reaped pty can no longer escape the EventEmitter listener into uncaughtException → app.exit(1).
- **Verification:** typecheck + 12/12 pty.test.ts; adversarial trace of node-pty's synchronous resize-throw site (windowsPtyAgent.js:119-122) → crash sink (index.ts uncaughtException → app.exit(1)) now severed.

### BUG-004: Adopted PTY never delivers exit (stuck 'running') — FIXED
- **Commit:** `3b53fa9` · Wave: lane-pty · **Files:** `src/main/pty.ts`
- **Fix:** proc.onExit now posts `{state:'exited'}`+`{exit}` to the CURRENT live port via `sessions.get(opts.id)` (fire-time lookup, guarded by `live.proc === proc`) instead of the captured spawn-time port park() closed.
- **Verification:** typecheck + tests; trace of the park→adopt→exit path. (Optional e2e "let an adopted session exit" assertion not added — coverage gap, not a defect.)

### BUG-006: Stale old-proc bytes bleed into a restarted session — FIXED
- **Commit:** `cfb12d4` · Wave: lane-pty · **Files:** `src/main/pty.ts`
- **Fix:** added `&& live.proc === proc` identity guard to proc.onData forwarding; buf.data append stays unconditional so park/adopt scrollback replay is unaffected.
- **Verification:** typecheck + 12/12 pty.test.ts; matches the isStaleExit identity semantics already unit-tested.

### BUG-011 / BUG-016 / BUG-023: TerminalBoard.restart() hardening — FIXED
- **Commit:** `22a4ccb` · Wave: lane-terminal · **Files:** `src/renderer/src/canvas/boards/TerminalBoard.tsx`
- **Fix:** restart routed through a shared `respawn()` with a `.catch` (011, surfaces a rejected pty:spawn instead of hanging on 'spawning'); `.then`/`.catch` guard `termRef.current !== term` to avoid write-after-dispose (016); restart now defers via `pendingRespawnRef` until the ResizeObserver's first finite fit so an under-LOD restart never respawns at 80×24 (023).
- **Verification:** typecheck + lint; adversarial trace confirmed no double-spawn (pendingRespawnRef reset per mount; pty:spawn reaps prior id via BUG-013).

### BUG-012 / BUG-029: Renderer-wide WebGL context cap + budget-freed re-acquire — FIXED
- **Commits:** `a028850` (registry) + `5e83bbc` (lint follow-up) · Wave: lane-terminal · **Files:** `src/renderer/src/canvas/boards/TerminalBoard.tsx`
- **Fix:** module-level `WEBGL_BUDGET=8` registry (acquire/release/waiter-retry) caps live terminal GL contexts (012); onContextLoss frees the slot, re-upgrades a waiting DOM-fallback terminal, and self re-acquires while still in detail view (029). Follow-up: routed the recursive `attachWebgl` re-invocations through a ref (`attachWebglRef`) so the useCallback no longer self-references — resolved a `react-hooks/immutability` **lint regression** the verifier caught.
- **Verification:** typecheck + **lint ✓** (was red) + build; leak-free slot accounting traced.

### BUG-005: Browser board stranded on 'load-failed' after a successful reload — FIXED
- **Commits:** `edc6fd8` + `0e0bc52` (preload type mirror) · Wave: lane-browser · **Files:** `src/main/preview.ts`, `src/renderer/.../BrowserPreviewLayer.tsx`, `src/preload/index.ts`
- **Fix:** main emits a new `{type:'did-start-navigation'}` PreviewEvent on a main-frame nav start; the renderer clears a stale load-failed latch → 'connecting' so the following did-finish-load promotes to 'connected'. The error-page commit reuses the failed navigation (no fresh did-start-navigation), so the #5/#8 error-page suppression is preserved. Variant mirrored into the preload union.
- **Verification:** typecheck + 240 tests; adversarial trace of BOTH the recovery and error-page paths confirmed no #5/#8 regression. (Card's optional "fail→reload→connected" assertion not added — React-callback path, no DOM harness.)

### BUG-008 / BUG-009: capturePage rejection no longer aborts the native-view detach — FIXED
- **Commits:** `04d41c4` (renderer) + `30e8716` (main) · Wave: lane-browser · **Files:** `BrowserPreviewLayer.tsx`, `src/main/preview.ts`
- **Fix:** main `preview:capture` wraps capturePage() in try/catch → returns null on reject (009, mirrors debugCaptureView); renderer demoteToSnapshot guards its await and beginMotion uses per-item `.catch(()=>null)` so one failed capture can't abort the whole detach batch (008) — the always-above native view is still detached.
- **Verification:** typecheck + 240 tests; preview.test.ts 17/17.

### BUG-014: Preview scheme allowlist now covers redirects + subframes — FIXED
- **Commit:** `9fe64d2` · Wave: lane-browser · **Files:** `src/main/preview.ts`, `src/main/preview.test.ts`
- **Fix:** extracted `registerPreviewNavGuards(wc)` wiring the http(s)-only guard onto will-navigate, will-redirect (30x), and will-frame-navigate (subframes); +4 wiring tests.
- **Verification:** preview.test.ts 17/17 (incl. the 4 new redirect/subframe/allowed-scheme assertions).

### BUG-015: beginMotion post-detach attachSeq re-check — FIXED
- **Commit:** `3238525` · Wave: lane-browser · **Files:** `BrowserPreviewLayer.tsx`
- **Fix:** snapshot per-board attachSeq before the detach await; in the post-detach forEach bail if `!r || attachSeq changed || !gestureRef.current` so a concurrent reattach isn't clobbered. Symmetric with the demoteToSnapshot fix.
- **Verification:** typecheck + trace of the endMotion-during-detach race.

### BUG-018: did-finish-load no longer flips an evicted board to 'connected' — FIXED
- **Commit:** `8c7e750` · Wave: lane-browser · **Files:** `BrowserPreviewLayer.tsx`
- **Fix:** did-finish-load guards `if (!recs.current.get(ev.id)?.exists) return` before the connected promotion; legitimate first-load still promotes (rec.exists set synchronously in attachBoard).
- **Verification:** typecheck + 240 tests; trace of the over-cap eviction race.

### BUG-020: preview zoomFactor derived from the rounded bounds width — FIXED
- **Commit:** `c081d7a` · Wave: lane-browser · **Files:** `BrowserPreviewLayer.tsx`, `cameraBounds.ts`, `cameraBounds.test.ts`
- **Fix:** new `fitZoomFactorForBounds(roundedW, presetW)`; zoomFor derives the factor from the SAME rounded width fed to setBounds so `bounds.width/zoomFactor === presetW` holds exactly.
- **Verification:** cameraBounds.test.ts 28/28 (incl. 4 new exact-invariant + drift assertions).

### BUG-030: attachBoard re-checks existence after openPreview await — FIXED
- **Commit:** `514238b` · Wave: lane-browser · **Files:** `BrowserPreviewLayer.tsx`
- **Fix:** `if (!recs.current.has(g.id)) return` after the openPreview await, before the trailing `patchRuntime({live:true})` — a board deleted during the open IPC no longer resurrects a cleared entry with live:true.
- **Verification:** typecheck + trace of delete-during-open.

### BUG-032: lifecycle events can't resurrect a cleared previewStore entry — FIXED
- **Commit:** `efe488b` · Wave: lane-browser · **Files:** `previewStore.ts`, `BrowserPreviewLayer.tsx`
- **Fix:** added `patchIfPresent` (no-op when id absent) and routed did-navigate/did-fail-load through it; did-finish-load/did-start-navigation are rec-guarded (BUG-018) — all four event handlers are now resurrection-safe.
- **Verification:** typecheck + 240 tests.

### BUG-003: nodeGesture armed on first onResize, not onResizeStart — FIXED
- **Commit:** `7f51cd4` · Wave: lane-canvas · **Files:** `BoardNode.tsx`
- **Fix:** moved `setNodeGesture(true)` from onResizeStart to a new onResize handler (real movement) so a pure handle click never sticks nodeGesture true; onResizeEnd still clears it. beginChange left on onResizeStart for BUG-007.
- **Verification:** typecheck + 240 tests; trace against @xyflow/system XYResizer (onResize gated on resizeDetected).

### BUG-017: stale hover cleared on LOD entry — FIXED
- **Commits:** `9ebd8e8` + `07ce4e0` (scoping) · Wave: lane-canvas · **Files:** `BoardNode.tsx`
- **Fix:** useEffect clears `hovered` on LOD entry (declared before the LOD early-return for hook-order safety). Follow-up: scoped the clear to `board.type !== 'terminal'` (the types that actually unmount the hover div) so terminal hover behavior — which the card exempted — is unchanged.
- **Verification:** typecheck + lint; trace of the stationary-cursor LOD crossing.

### BUG-019: focus preserved on a no-op undo/redo — FIXED
- **Commit:** `f2d7363` · Wave: lane-canvas · **Files:** `Canvas.tsx`
- **Fix:** doUndo/doRedo read `boards` before/after and only `setFocusedId(null)` when the ref changed (empty-stack undo/redo return state unchanged).
- **Verification:** typecheck + history/canvasStore tests; ref-equality is exact (no-op returns same `s`).

### BUG-025: reject degenerate geometry + clamp below-min on load — FIXED
- **Commit:** `8a4526f` · Wave: lane-canvas · **Files:** `boardSchema.ts`, `boardSchema.test.ts`
- **Fix:** `isPositiveNum` rejects non-positive board/note w/h (checklist h exempt — seeded h:0 is legitimate); fromObject clamps below-min board w/h up to MIN_BOARD_SIZE.
- **Verification:** boardSchema.test.ts 38/38 incl. 5 new BUG-025 cases.

### BUG-027: load path deep-clones so the store owns its data — FIXED
- **Commit:** `02beafc` · Wave: lane-canvas · **Files:** `boardSchema.ts`, `boardSchema.test.ts`
- **Fix:** fromObject structuredClones the input doc before clamp/migrate (symmetric with toObject) so loadObject no longer aliases the caller's input.
- **Verification:** new clone-isolation test; canvasStore loadObject 26/26 still green.

### BUG-021: FreeText grip guards before stopPropagation — FIXED
- **Commit:** `4bd83b3` · Wave: lane-planning · **Files:** `planning/FreeText.tsx`
- **Fix:** one-line reorder — `if (!interactive) return` before `e.stopPropagation()`, so pen/arrow draw-through over the grip bubbles to the well.
- **Verification:** typecheck; matches the NoteCard/ChecklistCard guarded pattern.

### BUG-022: vector hit-test disabled for any non-select tool — FIXED
- **Commit:** `02cc9b5` · Wave: lane-planning · **Files:** `PlanningBoard.tsx`, `planning/WhiteboardSvg.tsx`
- **Fix:** pass `drawing={tool !== 'select'}` so committed arrows/strokes set pointerEvents:'none' for note/check too; placement over ink now falls through to onWellPointerDown. Select-mode drag/select intact.
- **Verification:** typecheck + planning tests.

### BUG-024: checklist auto-grow routed through an untracked store action — FIXED
- **Commits:** `0774090` (interim redo-guard) + `4e7d460` (complete fix) · Wave: lane-planning · **Files:** `PlanningBoard.tsx`, `canvasStore.ts`
- **Fix:** the verifier flagged the interim fix (a `future.length` guard) as **incomplete** — it stopped the redo-wipe but left the untracked board.h mutation. Completed with a dedicated `growBoardHeight(id, h)` store action that only-grows and NEVER touches the undo/redo rails, so a measured content-fit bump neither checkpoints nor wipes history.
- **Verification:** typecheck + 240 tests.

### BUG-026: empty note/free-text pruned on a zero-movement grip press — FIXED
- **Commit:** `fcdcc7c` · Wave: lane-planning · **Files:** `planning/NoteCard.tsx`, `planning/FreeText.tsx`
- **Fix:** replaced the time-based `dragging` flag with document pointermove/pointerup/pointercancel listeners; on a zero-movement grip release the still-empty (live-DOM-checked) element is pruned; a real drag (>3px) or typed content preserves it. Listeners self-remove on up/cancel.
- **Verification:** typecheck + planning/store tests; trace confirms a typed/focused note is never pruned and no listener leak.

### BUG-028: per-stroke outline memo via module WeakMap — FIXED
- **Commits:** `355fa47` + `4731d7d` (lint follow-up) · Wave: lane-planning · **Files:** `planning/WhiteboardSvg.tsx`
- **Fix:** memoize each stroke's perfect-freehand outline keyed on the `points` array identity. Follow-up: moved the cache from a render-time `useRef` Map (a `react-hooks/refs` **lint regression** the verifier caught) to a module-level WeakMap keyed by `points` — lint-clean, auto-GC'd, same per-stroke reuse.
- **Verification:** typecheck + **lint ✓** + svgPaths/elements tests.

### BUG-010: startLocalServer rejects on a listen error — FIXED
- **Commit:** `1dc633f` · Wave: lane-server · **Files:** `src/main/localServer.ts`, `src/main/index.ts`
- **Fix:** Promise executor takes `(resolve, reject)` + `server.once('error', reject)` (removed on success); the call site try/catches with a clear diagnostic and boots with an empty fallback preview URL instead of crashing on uncaughtException.
- **Verification:** typecheck + 240 tests; graceful-degrade trace.

### BUG-031: guarded async quit drains the PTY tree — FIXED
- **Commit:** `e4f1f02` · Wave: lane-server · **Files:** `src/main/index.ts`
- **Fix:** before-quit uses the guarded pattern (`quitting` flag + preventDefault + `await shutdown()` + app.exit(0)); window-all-closed routes through app.quit() so the common path awaits the bounded PTY tree-kill instead of fire-and-forget.
- **Verification:** typecheck + 240 tests; trace confirms no double-exit / no unhandledRejection.

### BUG-002: camera auto-pan endMotion ignored during a node drag — FIXED
- **Commit:** `9a6aa30` · Wave: bridge-1 · **Files:** `BrowserPreviewLayer.tsx`
- **Fix:** endMotion early-returns while `nodeGesture` is active, so a React-Flow auto-pan onEnd during a node drag can't reattach (re-occlude) mid-drag; the node-drag's own end (nodeGesture→false) remains the sole authority that reattaches. Normal camera pans (nodeGesture false) reconcile as before.
- **Verification:** typecheck + 240 tests; adversarial trace confirmed node-drag-stop reattach + normal-pan reconcile both preserved.

### BUG-007: beginChange no longer wipes the redo branch — FIXED
- **Commit:** `bfb5b5a` · Wave: bridge-2 · **Files:** `canvasStore.ts`, `canvasStore.test.ts`
- **Fix:** beginChange takes the pre-edit snapshot but no longer clears `future`; the actual mutation (updateBoard/resizeBoard) discards the redo branch only on a real change. Store-level fix closes the whole no-op-gesture class (titlebar/resize click, degenerate arrow/pen) without touching the four caller files. +1 regression test.
- **Verification:** canvasStore.test.ts 27/27; adversarial trace confirmed a REAL edit after undo still checkpoints the pre-edit state (no history step lost).

### BUG-013: reap a session occupying the id before pty:spawn overwrites it — FIXED
- **Commit:** `c5c81eb` · Wave: bridge-1 · **Files:** `src/main/pty.ts`
- **Fix:** `if (sessions.has(opts.id)) void cleanup(opts.id)` at the top of pty:spawn — a double-spawn race (restart vs deferred launch) now safely replaces instead of orphaning the displaced proc tree. cleanup deletes synchronously before the new sessions.set; the displaced proc's onExit no-ops via isStaleExit.
- **Verification:** typecheck + 12/12 pty.test.ts; ordering-safety trace.

### BUG-033: IPC sender-frame allowlist on all 16 handlers — FIXED
- **Commit:** `625dc16` · Wave: bridge-2 · **Files:** `src/main/preview.ts`, `src/main/pty.ts`
- **Fix:** `isForeignSender(e, getWin)` rejects IPC whose senderFrame isn't the main window's main frame (privileged creators throw; others benign no-op). Defense-in-depth so untrusted preview-view content can never reach pty:spawn even if a preview preload is ever added. A synthetic/internal call (no senderFrame) is allowed.
- **Verification:** typecheck + preview 17/17 + pty 12/12; grep-confirmed all 16 handlers covered; legit main-window IPC + the window.api-based e2e harness pass the check.

---

## Residual notes (non-blocking, for a human glance)

- **Optional regression tests not added** (cards marked them optional; the paths are React callbacks with no DOM/jsdom harness): BUG-004 (adopted-session-exit e2e), BUG-005 (fail→reload→connected). Both fixes are correct by trace + integration green.
- **BUG-007 cosmetic wart** (acknowledged by the card): a no-op gesture immediately after an undo pushes one redundant identical snapshot onto `past` → one extra visual-no-op undo press. Not a data-integrity issue; inherent to the chosen minimal store-level fix.
- **BUG-012/029 WebGL fairness** (bounded, self-heals): releaseWebglSlot notifies exactly one (oldest) waiter; a declined retry mid global-LOD transition leaves the slot briefly unclaimed until the next LOD round-trip. Not a leak.
