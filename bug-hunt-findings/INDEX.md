# Bug Hunt Findings — Work Queue

Generated: 2026-05-30 · Scope: `src/**` (Electron main · preload · renderer · vendor) · Confirmed in-scope: 33

Adversarial dynamic-workflow hunt (17 discovery agents → independent refuter per candidate, 2nd refuter for High/Critical). **78 candidates → 42 confirmed → 34 after root-cause merge → 1 skipped to roadmap → 33 in-scope.** Every card below was reproduced or concretely demonstrated; unverified candidates are in `unconfirmed.md`. Most findings are **incomplete remediations** of the prior 50-bug hunt (`docs/bug-hunt-findings.md`).

Severity mix: 1 High · 13 Medium · 19 Low.

| ID | Severity | Category | Title | Files | Collides with | Status |
|----|----------|----------|-------|-------|---------------|--------|
| BUG-001 | High | error-handling | Unguarded proc.write/proc.resize in MessagePort message handlers throw on an exited pty, escaping to uncaughtE | `pty.ts` | BUG-004 BUG-006 BUG-013 BUG-033 | fixed |
| BUG-002 | Medium | concurrency | Auto-pan during a node drag clears the shared gestureRef and reattaches all live native Browser views mid-drag | `BrowserPreviewLayer.tsx` `Canvas.tsx` | BUG-005 BUG-007 BUG-008 BUG-009 BUG-015 BUG-018 BUG-019 BUG-020 BUG-030 BUG-032 | fixed |
| BUG-003 | Medium | concurrency | Clicking a board resize handle without dragging leaves nodeGesture stuck true → live Browser previews freeze t | `BoardNode.tsx` | BUG-007 BUG-017 | fixed |
| BUG-004 | Medium | correctness | Adopted PTY session never delivers exit: proc.onExit posts to the spawn-time port closed by park(), not the li | `pty.ts` | BUG-001 BUG-006 BUG-013 BUG-033 | fixed |
| BUG-005 | Medium | correctness | Browser board stranded on 'load-failed' after a successful Reload/Back/Forward (no "navigation restarted" sign | `preview.ts` `BrowserPreviewLayer.tsx` | BUG-002 BUG-008 BUG-009 BUG-014 BUG-015 BUG-018 BUG-020 BUG-030 BUG-032 BUG-033 | fixed |
| BUG-006 | Medium | correctness | Stale output from a dying old PTY bleeds into a freshly-restarted session because proc.onData forwards to the  | `pty.ts` | BUG-001 BUG-004 BUG-013 BUG-033 | fixed |
| BUG-007 | Medium | data-integrity | beginChange() down-time checkpoint wipes the armed redo branch — store guard misses the post-undo case (affect | `canvasStore.ts` `Canvas.tsx` `BoardNode.tsx` `PlanningBoard.tsx` | BUG-002 BUG-003 BUG-017 BUG-019 BUG-022 BUG-024 BUG-027 BUG-028 | fixed |
| BUG-008 | Medium | error-handling | A rejected capturePage() aborts the renderer detach pass — native preview keeps painting above all HTML (demot | `BrowserPreviewLayer.tsx` `preview.ts` | BUG-002 BUG-005 BUG-009 BUG-014 BUG-015 BUG-018 BUG-020 BUG-030 BUG-032 BUG-033 | fixed |
| BUG-009 | Medium | error-handling | preview:capture handler has no try/catch — a rejected capturePage() throws into the renderer's await, skipping | `preview.ts` `BrowserPreviewLayer.tsx` | BUG-002 BUG-005 BUG-008 BUG-014 BUG-015 BUG-018 BUG-020 BUG-030 BUG-032 BUG-033 | fixed |
| BUG-010 | Medium | error-handling | startLocalServer registers no server 'error' listener and its Promise has no reject path — any listen() failur | `localServer.ts` `index.ts` | BUG-031 | fixed |
| BUG-011 | Medium | error-handling | Terminal Restart's spawnTerminal promise has no .catch(); a rejected pty:spawn invoke leaves the board stuck o | `TerminalBoard.tsx` | BUG-012 BUG-013 BUG-016 BUG-023 BUG-029 | fixed |
| BUG-012 | Medium | performance | Terminal WebGL "pooling" fix never caps on-screen contexts — many detail-view terminals still exhaust Chromium | `TerminalBoard.tsx` | BUG-011 BUG-013 BUG-016 BUG-023 BUG-029 | fixed |
| BUG-013 | Medium | resource-leak | Restart during the mount's adopt/deferred-launch window spawns a second PTY that overwrites the first session  | `TerminalBoard.tsx` `pty.ts` | BUG-001 BUG-004 BUG-006 BUG-011 BUG-012 BUG-016 BUG-023 BUG-029 BUG-033 | fixed |
| BUG-014 | Medium | security | Preview WebContentsView scheme allowlist is incomplete — will-redirect (30x) and subframe navigations bypass t | `preview.ts` `preview.test.ts` | BUG-005 BUG-008 BUG-009 BUG-033 | fixed |
| BUG-015 | Low | concurrency | beginMotion's post-detach forEach clobbers a board reattached by a concurrent endMotion/applyLiveness (no gest | `BrowserPreviewLayer.tsx` | BUG-002 BUG-005 BUG-008 BUG-009 BUG-018 BUG-020 BUG-030 BUG-032 | fixed |
| BUG-016 | Low | concurrency | TerminalBoard.restart() resolves its async spawn into a captured term with no disposed-guard, so a same-window | `TerminalBoard.tsx` | BUG-011 BUG-012 BUG-013 BUG-023 BUG-029 | fixed |
| BUG-017 | Low | correctness | Board stays stuck in hovered=true after zooming across the LOD boundary with the cursor over it | `BoardNode.tsx` | BUG-003 BUG-007 | fixed |
| BUG-018 | Low | correctness | did-finish-load can flip an over-cap-evicted (closed, non-live) Browser board to 'connected' though no native  | `BrowserPreviewLayer.tsx` | BUG-002 BUG-005 BUG-008 BUG-009 BUG-015 BUG-020 BUG-030 BUG-032 | fixed |
| BUG-019 | Low | correctness | doUndo/doRedo clear focus unconditionally, dropping the focus dim on a no-op undo/redo (empty history) | `Canvas.tsx` | BUG-002 BUG-007 | fixed |
| BUG-020 | Low | correctness | fitZoomFactor's documented invariant (bounds.width / zoomFactor === presetW) is broken because the consumer ro | `BrowserPreviewLayer.tsx` `cameraBounds.ts` `cameraBounds.test.ts` | BUG-002 BUG-005 BUG-008 BUG-009 BUG-015 BUG-018 BUG-030 BUG-032 | fixed |
| BUG-021 | Low | correctness | FreeText drag-gutter swallows pen/arrow draw-through (stopPropagation runs before the !interactive guard) | `FreeText.tsx` | BUG-026 | fixed |
| BUG-022 | Low | correctness | Note/checklist placement is blocked over committed arrows/strokes (vector hit-test keyed on `drawing`, not any | `WhiteboardSvg.tsx` `PlanningBoard.tsx` | BUG-007 BUG-024 BUG-028 | fixed |
| BUG-023 | Low | correctness | Restart respawns the PTY at default 80x24 for a terminal created-and-restarted entirely under LOD because rest | `TerminalBoard.tsx` | BUG-011 BUG-012 BUG-013 BUG-016 BUG-029 | fixed |
| BUG-024 | Low | data-integrity | Checklist auto-grow rewrites board height on mount as an untracked (non-beginChange) store mutation | `PlanningBoard.tsx` `ChecklistCard.tsx` | BUG-007 BUG-022 BUG-028 | fixed |
| BUG-025 | Low | data-integrity | Deep load validation accepts non-positive / sub-minimum board and element geometry (MIN_BOARD_SIZE not enforce | `boardSchema.ts` | BUG-027 | fixed |
| BUG-026 | Low | data-integrity | Empty note/free-text orphaned when its grip is pressed (no drag) then focus leaves — blur-prune permanently sk | `NoteCard.tsx` `FreeText.tsx` | BUG-021 | fixed |
| BUG-027 | Low | data-integrity | fromObject/migrate return the input doc by reference, so loadObject's store boards alias the caller's input (l | `boardSchema.ts` `canvasStore.ts` | BUG-007 BUG-025 | fixed |
| BUG-028 | Low | performance | strokePaths useMemo never hits: perfect-freehand outlines recompute for all committed strokes on every Plannin | `WhiteboardSvg.tsx` `PlanningBoard.tsx` | BUG-007 BUG-022 BUG-024 | fixed |
| BUG-029 | Low | performance | xterm WebGL context lost while a terminal stays in detail view is never re-acquired (#11 fix implemented only  | `TerminalBoard.tsx` | BUG-011 BUG-012 BUG-013 BUG-016 BUG-023 | fixed |
| BUG-030 | Low | resource-leak | attachBoard's post-openPreview patchRuntime resurrects a cleared previewStore entry (with live:true) for a boa | `BrowserPreviewLayer.tsx` | BUG-002 BUG-005 BUG-008 BUG-009 BUG-015 BUG-018 BUG-020 BUG-032 | fixed |
| BUG-031 | Low | resource-leak | Normal quit paths (before-quit / window-all-closed) fire shutdown() without awaiting, so the awaitable PTY tre | `index.ts` | BUG-010 | fixed |
| BUG-032 | Low | resource-leak | previewStore.patch (create-if-absent) lets the unguarded onPreviewEvent handlers resurrect a cleared runtime e | `previewStore.ts` `BrowserPreviewLayer.tsx` | BUG-002 BUG-005 BUG-008 BUG-009 BUG-015 BUG-018 BUG-020 BUG-030 | fixed |
| BUG-033 | Low | security | IPC handlers never validate event.senderFrame — PTY/preview isolation relies solely on the preview view having | `preview.ts` `pty.ts` | BUG-001 BUG-004 BUG-005 BUG-006 BUG-008 BUG-009 BUG-013 BUG-014 | fixed |

**Summary:** 78 candidates → 42 confirmed → 1 skipped to roadmap → **33 in-scope for fixing**.

**✅ RUN COMPLETE (2026-05-30):** all 33 fixed & verified on branch `fix/bug-hunt-batch` (one commit per bug). Whole-integration gates green — `pnpm typecheck` · `pnpm lint` · `pnpm test` (240) · `pnpm build` — and every fix was adversarially re-verified against the final code. See **`FIX-REPORT.md`** for per-fix records, the wave plan, and residual notes.

**Parallelization note:** Cards with no entry in "Collides with" can be assigned simultaneously: . Cards sharing files must be sequenced (see each card's collision notes). Hot files: `BrowserPreviewLayer.tsx`(9), `TerminalBoard.tsx`(6), `pty.ts`(5), `preview.ts`(5), `PlanningBoard.tsx`(4), `Canvas.tsx`(3).
