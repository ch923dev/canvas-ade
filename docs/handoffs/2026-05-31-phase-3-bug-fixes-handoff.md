# Phase 3 Bug-Fixes — Session Handoff (2026-05-31)

> Continue from here next session. Context got large; this captures everything needed to resume cold.

## TL;DR

- Branch **`fix/phase-3-bugs`** (off `phase-3-slice-c`). NOT merged.
- 12 user-reported bugs fixed + **3 self-inflicted regressions caught by e2e** (would never have been caught by unit tests).
- State: `pnpm lint` clean · `pnpm typecheck` clean · **302 unit tests** · **e2e harness 15/15 `ok:true`**.
- **2 bugs still OPEN** (board ⋯ menu chrome) — described below with root cause + fix direction. These are the next session's work.

## How to verify (do this first to confirm the baseline)

```
pnpm build
$env:CANVAS_SMOKE='e2e'; pnpm start     # expect E2E_DONE {ok:true}, 15 parts
pnpm lint ; pnpm typecheck ; pnpm test  # all green (302)
```
If an Electron instance is already running it locks userData (`cache: Access is denied`) and the harness fails spuriously — kill stray `electron` processes first. Use `$env:ELECTRON_ENABLE_LOGGING='1'` to surface renderer console errors (e.g. `Minified React error #185`).

**Process rule for ALL further work (memory `e2e-before-handoff`):** set a goal → implement → run the FULL e2e harness in the live app → if anything breaks, diagnose (baseline-compare vs `3786d28`, read renderer console) → iterate to production-green. Unit/typecheck green is NOT proof. Prefer a negative control (reintroduce the bug, confirm the new e2e assertion fails).

## OPEN BUGS (next session)

### Bug 13 — Terminal ⋯ menu trigger clipped / "not visible" (image #10)
**Repro:** a Terminal board; the ⋯ (More) button at the top-right of the title bar is missing/clipped at the board's right border (red arrow in the screenshot points past the last visible icon, the ⤢ maximize).
**Root cause:** the Terminal title-bar action cluster is wide — `Interrupt · globe/Preview · settings/Configure · restart` (`TerminalBoard.tsx:493-505`) **+ maximize ⤢ + ⋯ menu** (added by `BoardFrame` at `BoardFrame.tsx:355-360`). The cluster is `flex:none`; the title is `flex:1 minWidth:0` so the title shrinks first, but once the title is at 0 the cluster still overflows the title bar on a normal/narrow board, and `BoardFrame`'s outer div has `overflow:hidden` (`BoardFrame.tsx:267`) → the trailing ⋯ is clipped off the right edge. So the trigger is rendered but invisible.
**Fix direction:** make the action area not overflow — options: (a) cap/scroll the action cluster, (b) move secondary terminal actions (globe/settings/restart) INTO the ⋯ menu so the title bar only shows 1-2 inline actions + ⋯, (c) let the title bar overflow be visible just for the action cluster (tricky with the rounded frame). Decide the chrome design with DESIGN.md §6 in mind. **Note:** Bug 8/9's fix only portaled the menu POPOVER out of the clip; the ⋯ *trigger button* itself is still inside the clipped title bar — that's this bug.

### Bug 14 — ⋯ menu popover renders off-screen near window edges (image #11)
**Repro:** a Browser board near the right edge of the window; open its ⋯ menu — the popover ("Full view / Duplicate / Delete") is cut off by the window edge (only "Full view" partly visible).
**Root cause:** `BoardMenu.openMenu` (`BoardFrame.tsx:110-115`) positions the portaled popover with `style={{ position:'fixed', top: r.bottom+4, right: window.innerWidth - r.right }}` — anchored to the trigger with **no viewport clamp and no flip**. When the trigger is near (or past) the window right/bottom edge, `right` goes small/negative and the menu spills off-screen; there's no shift-back-into-viewport or flip-up. (The portal-to-body fix from bug 8/9 is correct and works — this is the missing positioning logic the plan called for as "flip/shift" but the implementer didn't add.)
**Fix direction:** after `setOpen(true)`, measure the rendered menu and clamp: `left = min(triggerRight - menuWidth, innerWidth - menuWidth - 8)` and `top = bottom+4`, flipping to `top - menuHeight - 4` if it would overflow the bottom; clamp `left>=8`, `top>=8`. Simplest robust approach: position with `left/top` (not `right`), measured against the menu's own `getBoundingClientRect()` in a `useLayoutEffect` after open, clamped to `[8, innerWidth-8]`. Add an e2e assertion (extend `board-menu` in `e2eSmoke.ts`): seed/position a board near the right edge, open the menu, assert `menu.getBoundingClientRect().right <= window.innerWidth` and `.left >= 0` and all three items present.

Both bugs live in **`src/renderer/src/canvas/BoardFrame.tsx`** (`BoardMenu` + the title-bar action cluster) and possibly **`TerminalBoard.tsx`** (if moving actions into the menu). Low risk to the rest of the app (pure chrome) but MUST still be e2e-verified (the menu e2e already exists as `board-menu`).

## DONE & VERIFIED (bugs 1-12)

All on `fix/phase-3-bugs`. e2e part name in brackets.

| Bug | Fix | Guard |
|---|---|---|
| 1 full-view kills terminal | stable portal host in `BoardNode` (relocate, don't remount) | e2e `terminal-fullview` (negative-control proven) |
| 2 focus webview ghost | detach-up-front on motion + `demoting` skip in `flushBatch` | e2e `focus-detach` (invariant) |
| 3 stale preview link | `terminalRuntimeStore` + `previewEdges(boards, runningIds)` → dashed edge | unit `previewEdges` + e2e `preview-edge-stale` |
| 4 full-view note→browser ghost | full-view-aware `reconcile`/`applyLiveness` | e2e `fullview-preview` |
| 5 checklist not draggable | drop `e.target===currentTarget` guard in `ChecklistCard` header | unit `ChecklistCard.test.tsx` |
| 6 full-view note coords | measure well scale (`screenScale`) instead of camera zoom | unit `pen.test.ts` |
| 7 config-scroll ghost | `nowheel` on the Configure popover | e2e `config-nowheel` (structural) |
| 8/9 menu clipped | portal popover to `document.body` | e2e `board-menu` — **see Bugs 13/14, not fully done** |
| 10 browser drag ghost | gate `reconcile` re-push + sync-detach on drag start | e2e `browser-gesture` |
| 11/12 menu items dead | stop `pointerdown` on the menu (matched event type) | e2e `board-menu` (pointerdown→click) |

### Regressions caught by e2e (NOT by 302 unit tests + typecheck + lint)
1. **React #185 infinite loop** — `selectRunningIds = (s) => new Set(...)` returned a fresh Set every call → `useSyncExternalStore` loop → black screen. Fixed: select stable `s.running`, `useMemo` the Set (`Canvas.tsx`). Commit `d8516de`.
2. **Blank boards after zoom-out→in** — portal `useLayoutEffect` deps missing `lod`; non-terminal anchor remounts on LOD return without re-appending `contentHost`. Fixed: add `lod` to deps (`BoardNode.tsx`). Commit `e452230`. Caught by the `board-menu` e2e (`titlebars=2` not 4).
3. **Rules-of-hooks** — portal hooks placed after the LOD early-return. Fixed in `be8a18a` (hoist hooks + `useState` host).

## e2e harness (extended this session)

- `src/main/e2eSmoke.ts` — the 15-part board harness (drives the renderer via `window.__canvasE2E`).
- `src/renderer/src/smoke/e2eHooks.ts` — added host hooks `setFullView`, `setTerminalDown`, `setFocus` (threaded from `Canvas.tsx` via `installE2EHooks(rf, { setFullView, setFocus })`).
- Main-side debug helpers used: `debugTerminalPid`, `debugCaptureView`, `debugViewIds` (`pty.ts`/`preview.ts`).
- Test infra added earlier: RTL + jsdom, `.test.tsx`→jsdom via `vitest.config.ts` `environmentMatchGlobs` (existing `.test.ts` stay on node).

## Commit list (newest first)
```
84393cf test(e2e): focus-detach (bug 2) + config nowheel (bug 7)
241f011 test(e2e): preview-link stale when terminal down (bug 3)
e452230 fix(fullview): re-attach portal host on LOD return (blank-board regression) + board-menu e2e (8/9/11/12)
c4c4004 test(e2e): full-view PTY survival (bug 1) + full-view keeps browser views closed (bug 4)
d8516de fix(preview): memoize runningIds set — #185 infinite-loop regression
be8a18a fix(fullview): hoist portal hooks above LOD early-return; useState host
7153610 feat(preview): stale preview link when source terminal down (bug 3)
0620d29 fix(preview): detach live views up-front on motion start (bugs 2/7)
a036e58 fix(terminal): nowheel on config popover (bug 7)
630c342 fix(preview): gate reconcile re-push + sync-detach on drag start (bug 10)
55966df fix(preview): keep non-fullview browser views closed during full view (bug 4)
e1bf5fb fix(fullview): relocate board subtree via stable portal host (bug 1)
9d097e3 fix(planning): measure well scale for full-view element placement (bug 6)
1422c26 fix(planning): make checklist card draggable from header (bug 5)
77f1e88 fix(menu): portal board menu to body (bugs 8/9)
6640460 fix(menu): stop pointerdown so menu item clicks fire (bugs 11/12)
b55b694 docs(phase-3): bug-fix plan
```
Plan: `docs/superpowers/plans/2026-05-31-phase-3-bug-fixes.md`.

## Recommended next-session order
1. Verify the baseline (commands above) — confirm 15/15 + 302 green.
2. Fix **Bug 14** (menu off-screen) — small, in `BoardMenu`; add the clamp/flip + extend the `board-menu` e2e with a near-edge case. Negative-control it.
3. Fix **Bug 13** (terminal ⋯ clipped) — decide the chrome approach (likely move secondary terminal actions into the ⋯ menu); e2e-assert the ⋯ trigger is within the title-bar bounds + clickable.
4. Re-run the full harness; if green, open PR `fix/phase-3-bugs` → `phase-3-slice-c`.
5. Remember: bugs 5/6 are unit-only by design (native pointer-drag/coord e2e is fragile); the literal compositor ghost pixel (2/7/10) is guarded by invariants, not pixels.
